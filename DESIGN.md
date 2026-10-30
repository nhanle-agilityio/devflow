# devflow — design

A Claude Code plugin with three project-agnostic workflows (v2 wave 1):

1. **`/devflow:spec`** — idea → analyse → grill-me → spec PR (risk per task) → Gate 1 (human merges; this approves the risk levels) → GitHub issues labelled ready and `risk:low|high`.
2. **`/devflow:next-task`** — run locally on demand: pick up to N ready issues → implement (test first) → checks → verify → review → open PR labelled with its risk, stacked on a parent PR when needed.
3. **`/devflow:sync`** — keep those PRs mergeable: retarget, update behind branches, resolve conflicts, address review threads.

Merging is done by a human, or for `risk:low` PRs by the merge gate GitHub Action (`devflow-merge-gate.yml`). Claude never merges.

Nothing in the plugin knows about a specific stack. Project mechanics live in `.claude/devflow.json`; project rules (architecture, conventions, "Never" list) live in the project's `CLAUDE.md`. Skills read both and never restate them.

## Principles

- **Deterministic where it matters.** The loop and the order of stages in `next-task` are a Workflow script (`workflows/next-task-engine.js`), not prose. Safety rules are hooks, not instructions.
- **Claude never merges.** The plugin opens PRs and pushes its own feature branches, never merges, never pushes to the base branch, never force-pushes (except `--force-with-lease` on its own branch). Who merges is decided by risk: a human for `risk:high` and unlabelled PRs; the merge gate Action (outside Claude, own token) for `risk:low` PRs once its checks are green.
- **Risk is judged early and enforced late.** The spec judges each task against `risk.highWhen` / `risk.highPaths` (unsure → high) and the human approves the levels at Gate 1. The engine only ever escalates to high, deterministically, when changed files match `risk.highPaths`. A missing label counts as high.
- **No reliance on GitHub paid features.** Target repos may be private on GitHub Free: no branch protection, no required checks, no native auto-merge. The merge gate is a plain Action that does the checking itself.
- **Model tiers.** Opus plans and reviews; Sonnet implements and ships (it writes the PR body reviewers read); Haiku runs mechanical steps (selecting, claiming, running checks, blocked clean-up).
- **GitHub via the GitHub MCP server** (issues, labels, PRs, comments). `gh` is optional, never required. Adding a missing label to an issue creates it.
- **Stack-agnostic verification.** `http` (API calls against the dev server), `browser` (Playwright MCP, or Claude in Chrome if that is what the user has) and `none`. A project enables any subset.
- **All committed content is English.** No `Co-Authored-By` or AI attribution in commits or PRs, unless the project's CLAUDE.md says otherwise.
- **Never write the review bot's at-sign handle into issues, PRs, comments or replies.** Repos that use `anthropics/claude-code-action` start a job on it. No stage posts a re-review trigger: pushing commits re-runs the review (`synchronize`). The handle appears only in the `claude.yml` template, as its trigger.

## Layout

```
.claude-plugin/plugin.json          name "devflow", description, author, repository, license MIT (no version: follow commits)
.claude-plugin/marketplace.json     marketplace "nhanle-devflow", plugins: [{name: devflow, source: "./"}]
README.md                           what it is, install, per-project setup, merge gate setup checklist, usage, safety, permissions snippet
DESIGN.md                           this file
LICENSE                             MIT
skills/init/SKILL.md                /devflow:init
skills/init/templates/devflow.json          annotated example config
skills/init/templates/devflow.schema.json   JSON Schema for the config
skills/init/templates/github/workflows/claude-code-review.yml  PR review Action (Opus); publishes commit status devflow/review
skills/init/templates/github/workflows/devflow-merge-gate.yml  merge gate workflow (copied to the default branch)
skills/init/templates/github/workflows/claude.yml              Claude app mention Action
skills/init/templates/github/scripts/devflow-merge-gate.cjs    merge gate logic (copied to .github/scripts/)
skills/spec/SKILL.md                /devflow:spec
skills/spec/templates/spec.md       spec + task list template
skills/spec/templates/issue.md      issue body template
skills/next-task/SKILL.md           /devflow:next-task  (thin entry: preflight, then calls the workflow)
skills/next-task/templates/pr.md    PR body template
skills/sync/SKILL.md                /devflow:sync (replaces /devflow:address-reviews)
workflows/next-task-engine.js       meta.name "next-task-engine" → /devflow:next-task-engine (internal; users run /devflow:next-task)
hooks/hooks.json                    PreToolUse guard (matcher Bash|mcp__.*merge_pull_request)
hooks/guard.py                      python3 (3.9+, stdlib only)
hooks/test_guard.py                 unittest for guard.py
tests/merge-gate.test.cjs           node:test for the merge gate script (fake Octokit)
```

Skills reference bundled files with `${CLAUDE_SKILL_DIR}/templates/...` or `${CLAUDE_PLUGIN_ROOT}/...` written literally in the SKILL.md body (they are substituted in the body, not set as env vars in Bash).

## Config: `.claude/devflow.json`

```jsonc
{
  "$schema": "./devflow.schema.json",            // optional; init copies the schema next to it
  "github": { "owner": "acme", "repo": "shop", "remote": "origin" },  // remote = git remote that points at GitHub
  "baseBranch": "main",                         // branches start from <remote>/<baseBranch>; PRs target it
  "protectedBranches": ["main", "develop"],     // guard blocks pushes to these and to baseBranch
  "branchPattern": "{type}/{issue}-{slug}",     // type ∈ feat|fix|chore|docs|refactor|test; slug ≤ 5 words kebab
  "commitScope": "#{issue}",                    // Conventional Commits scope, e.g. feat(#12): ...
  "specDir": "docs/specs",
  "labels": {
    "ready": "agent:ready", "inProgress": "agent:in-progress", "review": "agent:review",
    "blocked": "agent:blocked", "e2e": "needs-e2e",
    "devflow": "devflow",                       // on every PR devflow opens
    "riskLow": "risk:low", "riskHigh": "risk:high",  // on issues (from the spec) and PRs
    "stacked": "stacked"                        // PR based on another open devflow PR
  },
  "risk": {                                      // unsure means high
    "highWhen": ["authentication or permissions", "data migration or deleting stored data",
                 "a change to a public API contract that breaks existing clients",
                 "security-sensitive input handling", "payments or money"],
    "highPaths": []                              // globs (** * ?); a PR touching one is escalated to high
  },
  "mergeGate": { "enabled": false, "dryRun": true, "requiredChecks": ["devflow/review"], "method": "merge" },
  "testing": { "e2eFramework": false },          // false: e2e must rows are covered by Verify, not committed tests
  "checks": [                                    // run in order; all must pass before review
    { "name": "test", "run": "npm test" },
    { "name": "lint", "run": "npm run lint" }
  ],
  "verify": {
    "modes": ["http", "browser"],                // subset of http | browser; [] = none
    "devServer": { "run": "npm run dev", "url": "http://localhost:3000", "readyTimeoutSec": 60 },
    "browserTool": "playwright"                  // playwright | chrome
  },
  "spec": { "testMatrix": true, "qaModel": "opus" }, // QA step of /devflow:spec; qaModel = opus | sonnet
  "nextTask": { "defaultLimit": 3, "maxFixRounds": 2, "maxReviewRounds": 2 }
}
```

Missing optional keys take the defaults shown. `github`, `baseBranch` and `checks` are required.

## `/devflow:init`

`disable-model-invocation: true`. Sets a project up once; idempotent (re-running shows a diff of proposed changes).

1. Read the repo: git remotes (find the GitHub one), default/current branches, `package.json` scripts, `Makefile`, `pyproject.toml`, lockfiles, framework config, `CLAUDE.md`, existing `.github/workflows`.
2. Propose a filled `.claude/devflow.json` (explain each detected value and where it came from). Ask the user to confirm or edit with AskUserQuestion for anything ambiguous (which remote, base branch, dev server command, verify modes). Write it plus `devflow.schema.json`.
3. Check the CLAUDE.md has what the workflows rely on (conventions, test approach, "Never" list). List gaps; offer to draft additions, never edit CLAUDE.md without a yes.
4. Risk and merge gate (AskUserQuestion, recommended option each time): `risk.highWhen` (show defaults), `risk.highPaths` (globs for auth, migrations, payments, CI config), `mergeGate.enabled` (default false, `dryRun` true), `mergeGate.requiredChecks` (job names found in `.github/workflows/*` plus `devflow/review`), `testing.e2eFramework` (true only when an automated e2e setup exists; say which signal), `spec.testMatrix` / `spec.qaModel`.
5. Offer (each a separate yes) to copy `claude-code-review.yml`, the pair `devflow-merge-gate.yml` + `devflow-merge-gate.cjs` (filling the `workflow_run` workflow list with the project's CI workflow names), and `claude.yml` into `.github/` when absent (otherwise show a diff). Tell the user the setup each needs (secrets `CLAUDE_CODE_OAUTH_TOKEN`, `DEVFLOW_GATE_TOKEN`; allow merge commits; gate on the default branch; see the README checklist). Print the `permissions` snippet from the README for `.claude/settings.json`.
6. Remind the user that the plugin hook blocks merges and pushes to protected branches.

## `/devflow:spec <idea or path to a brief>`

`disable-model-invocation: true`. Designed to run in a cloud session (claude.ai/code) on the repo, works locally too. Steps, each announced with its number:

1. **Analyse.** Read `.claude/devflow.json`, `CLAUDE.md`, and the code the idea touches. Produce a short analysis: current behaviour, affected areas (backend/frontend/infra/data), risks, unknowns. Do not write files yet.
2. **Grill.** Invoke the `grill-me` skill on the idea plus the analysis. Keep going until every unknown is decided or explicitly deferred. If `grill-me` is not available, run the same interview inline: one question at a time, each with a recommended answer.
3. **Spec + tasks.** Create branch `spec/<slug>` from `<remote>/<baseBranch>`. Write `<specDir>/<YYYY-MM-DD>-<slug>.md` from `templates/spec.md`: problem, goals/non-goals, decisions (with the grill answers), design (API contracts, data model, UI screens and states, mocks if any — mocks go in `<specDir>/<slug>/`), risks, and the **task list**. Each task: stable id `T1..Tn`, title, type, `area`, depends-on, acceptance criteria written as checkable behaviour (API: request → response; UI: user action → visible result), files/areas in scope, test plan, `needs-e2e` yes/no, size S/M (split anything bigger), **risk** `low|high` with a one-line reason (judged against `risk.highWhen` and `risk.highPaths`; unsure → high), and **hotspot files** other tasks are likely to touch (recorded only, nothing uses them yet).
4. **Test matrix (QA).** Skipped when `spec.testMatrix` is false. A QA agent (Agent tool, model `spec.qaModel`, default opus) gets only the spec file and `CLAUDE.md`, not the grill conversation, so it tests what the spec says rather than what was meant. It returns test-case rows (id `T<n>.<k>`, criterion, case happy/error/edge/boundary, Given/When/Then, level unit/integration/http/e2e, priority must/should; every criterion has a must row), the criteria it cannot test as written, and cases the spec leaves undecided. Those go back to the user one at a time with a recommended answer; the spec is updated and QA runs again, at most 2 rounds, leftovers under Risks. The rows go into the spec's Test matrix and each task's test plan points at them. Opus is the default because the value of the step is in spotting what the spec does not say, and the matrix is copied into every issue, so a miss repeats; it runs once per spec, so the cost is small.
5. **Spec PR.** Commit `docs(spec): <title>`, push the branch, open a PR to `baseBranch` titled `spec: <title>`, body = summary + task table (incl. risk and reason) + test matrix size and QA questions resolved/open. No need to ask before pushing the spec branch or opening the PR.
6. **Gate 1.** Ask exactly one question (AskUserQuestion): "Spec PR <url> merged? Merging also approves the risk levels in its table." — options: merged / changes requested / abandon. Changes requested → read the PR review comments, update the spec on the same branch, push, ask again. Abandon → close nothing, stop. Merged → verify through MCP that the PR is merged; if not, say so and ask again.
7. **Issues.** Search existing issues for each task title first (no duplicates; re-running after a partial failure must be safe). Create one issue per task from `templates/issue.md`: title `[<slug>] T<n>: <task title>`, body with spec link (on baseBranch), acceptance criteria as a checklist, scope, test cases (the task's Test matrix rows, or the test plan when there is no matrix), `Depends on #<n>` lines (resolve task ids to issue numbers — create in dependency order), a Risk line and Hotspots section, labels `labels.ready` plus `labels.riskLow` or `labels.riskHigh` plus `labels.e2e` when needed plus `type:<type>`. Then comment on the spec PR with the issue list. Final message: table task → issue.

## `/devflow:next-task [limit | #issue ...]`

`disable-model-invocation: true`. Entry point only; the work is the workflow.

Preflight (inline, fail fast with a clear message):
- `.claude/devflow.json` exists and parses; else tell the user to run `/devflow:init`.
- Working tree clean; current branch noted (restored at the end).
- `git fetch <remote> <baseBranch>` succeeds.
- GitHub MCP reachable (get the authenticated user).

Then call the Workflow tool with name `devflow:next-task-engine` and `args = { config: <parsed devflow.json>, limit: <n or config default>, issues: [<explicit issue numbers>] , startBranch: <current branch>, prTemplatePath }`. `prTemplatePath` points at `templates/pr.md`. When it returns, print the summary table: issue → PR (risk, and the PR it is stacked on) / blocked (reason) / skipped, and say who merges: the merge gate for `risk:low` when enabled, a human otherwise.

## Workflow `next-task-engine.js`

Plain JS, no `Date.now()`/`Math.random()`, no filesystem. Tasks run **sequentially** in the main checkout (they share one working tree and often touch the same files). Every agent gets the config in its prompt. Every agent returns structured output (schemas below); a stage that fails marks the issue blocked and moves on to the next issue.

Phases: `Select`, then per issue `Implement`, `Check`, `Verify`, `Review`, `Ship`, then `Report`.

1. **Select** (haiku, schema `{issues:[{number,title,labels,body,dependsOn:[int],stackOn}], skipped:[{number,reason}]}`): explicit issues if given, otherwise open issues with `labels.ready`, not labelled inProgress/blocked, no open PR referencing them. Dependencies: all `Depends on` issues closed → normal; exactly one open dependency that has an open PR → **stacked** (`stackOn = {issue, prNumber, branch}`); exactly one open dependency without a PR that is itself in the selection → stacked **in run** (the engine fills in the PR once the parent ships; if the parent does not ship, the child is skipped with that reason); anything else is skipped naming the open dependency. Order: parents first, then oldest. The agent returns up to 3×`limit` candidates; the engine works on `limit` of them (a skipped child does not count). `log()` what was skipped and why (no silent caps).
2. Per issue, in order:
   - **Claim** (haiku): add `labels.inProgress`, remove `labels.ready`; `git switch -c <branch> <parentRef>` (branch from `branchPattern`), where `parentRef` is `<remote>/<baseBranch>`, or `<remote>/<parent PR branch>` when stacked. Return `{branch}`.
   - **Implement** (sonnet, schema `{status: done|blocked, summary, commits:[sha+msg], filesChanged, assumptions:[], outOfScope:[], blockedReason?}`): read the issue and the linked spec; follow CLAUDE.md. For behaviour changes and bug fixes: commit a failing test first (`test(<scope>): ...`), confirm it fails for the right reason, then the implementation (`feat|fix(<scope>): ...`). When the issue has a Test cases table, write a test for every `must` row, traceable to its row id (`test_t<task>_<n>_...` or a `# T1.2` comment). With `testing.e2eFramework` false, `e2e` rows get no committed test: Verify covers them. Stage files by name. Stay inside the issue scope; record anything else in `outOfScope`. Ambiguity that changes behaviour and is not answered by the spec → `blocked` with the question (no guessing on contracts); minor ambiguity → decide and record in `assumptions`.
   - **Check** (haiku, schema `{passed, failures:[{check, output}]}`): run every `checks[].run` in order, report only failures (trimmed output). If failed: **Fix** (sonnet) with the failures, then Check again; up to `maxFixRounds`. Still failing → blocked.
   - **Verify** (sonnet, schema `{ran, mode, steps:[{action, expected, actual, pass}], notes}`): only if `verify.modes` is non-empty and the issue has `labels.e2e`, the diff touches UI, or the issue's Test cases table has a row with level `http` or `e2e`. Start the dev server in the background, wait until `url` answers (≤ `readyTimeoutSec`), walk every acceptance criterion and every Test cases row with level http or e2e: `http` with curl, `browser` with the configured browser tool (navigate, act, read the page; take screenshots for the agent's own check). Stop the server. Failures → one Fix round (sonnet) → Check → Verify again; still failing → blocked.
   - **Review** (opus, read-only, schema `{verdict: pass|changes, findings:[{severity: critical|warning|suggestion, file, line, problem, fix}]}`): review `git diff <parentRef>...HEAD` (so a stacked PR shows only its own changes) against the issue's acceptance criteria, the spec and CLAUDE.md; correctness first, then tests (does each change have a test that fails without it; a `must` Test cases row without a traceable test is a warning, except `e2e` rows when `testing.e2eFramework` is false), then scope creep. Critical/warning → Fix (sonnet) → Check → Review again, up to `maxReviewRounds`; suggestions go to the PR body, not fixed.
   - **Risk** (deterministic, in the engine, no agent): level = the issue's risk label (`unknown` if none, treated as high); reason = the issue body's `Risk:` line. If any changed file matches a `risk.highPaths` glob, the level becomes high and the reason names the file. The result also sets `labels.riskHigh` on the issue.
   - **Ship** (sonnet): push the branch (`git push -u <remote> <branch>`), open a PR via MCP with `templates/pr.md` filled from the stage results (what, how, risk line, tests, verification evidence, assumptions, out of scope, `Closes #<n>`). The PR base is `baseBranch`, or the parent PR's branch when stacked (the body then says it retargets when the parent merges). Label the PR `labels.devflow`, `labels.riskLow|riskHigh` and, when stacked, `labels.stacked`; add `labels.review` to the issue and remove `labels.inProgress`. Return `{prNumber, url}`.
   - **On blocked at any stage** (haiku): commit nothing further; if the branch has commits, push it so work is not lost; comment on the issue with the stage, reason and question; label `labels.blocked`, remove `labels.inProgress`; `git switch <startBranch>`.
   - After each issue: `git switch <startBranch>` so the next one starts clean.
3. **Report**: return `[{issue, status: pr|blocked|skipped, url?, prNumber?, risk?, stackedOn?, reason?}]`.

**In-run stacking.** The engine keeps a map of issues that shipped in this run (issue → PR number and branch). A child whose only open dependency is such an issue is stacked on that PR's branch: its branch starts from the parent's branch and its PR targets it. Because tasks run in order, parents are always processed before their children.

## `/devflow:sync [#pr ...]`

`disable-model-invocation: true`. Replaces `/devflow:address-reviews`. Default targets: open PRs labelled `labels.devflow` and authored by the current user; explicit `#pr` numbers override. Needs a clean working tree; the starting branch is restored at the end. Fork PRs are skipped. PRs are processed parents before children. Only new commits and normal pushes: no rebase, no force push, no merge.

Per PR:
1. **Retarget.** If the PR is stacked and its parent PR is merged (or the base branch is gone), change its base to `baseBranch` (`update_pull_request`) and remove `labels.stacked`.
2. **Update when behind.** If behind and it merges cleanly, `update_pull_request_branch`.
3. **Conflicts.** Merge `<remote>/<base>` into the branch (a merge commit, never a rebase). Resolve each conflict from the linked issue and spec, keeping both behaviours when compatible; run `checks`; commit `merge(<scope>): sync with <base>`; push. Then remove `labels.blocked` from the PR and its issue (the gate adds it on conflict), unless something else blocks the issue. If a conflict cannot be resolved with confidence or checks fail: `git merge --abort`, label the issue blocked, comment with the files and the one question for a human.
4. **Review.** Unresolved, actionable threads are classified fix / answer / won't fix (reason, citing CLAUDE.md or the spec); a thread needing a product decision goes to the user. Fixes are new commits (`fix(<scope>): address review - <what>`), `checks` must pass, push, then reply on every thread. The merge gate treats a thread as answered when its last comment is by the PR author, so the reply is what unblocks it. No re-review comment is posted: the push re-runs the review.
5. **Round limit.** A round is a run of step 3 or 4 that changed or answered something. Rounds are counted by the hidden marker `<!-- devflow-sync -->` in earlier comments; at `nextTask.maxReviewRounds` the PR is left for the user. After a round, one marker comment with a one-line summary is posted. Steps 1 and 2 are not rounds.
6. Switch back; summary table PR → retargeted / updated / conflicts / threads fixed, answered, won't fix / rounds left.

## Risk and the merge gate

Risk flows: spec task (`risk` + reason, approved at Gate 1) → issue label and `Risk:` line → engine (escalate to high on `risk.highPaths`; unlabelled = high) → PR label and body line → gate (acts only on `risk:low`).

**Merge gate** = `.github/workflows/devflow-merge-gate.yml` + `.github/scripts/devflow-merge-gate.cjs`, installed by `/devflow:init`. It exists because target repos may be private on GitHub Free. Runs on `workflow_run` completion (CI workflows and "Claude Code Review"), `status`, and manual `workflow_dispatch` (optional PR number). The workflow lives on the default branch (those triggers only run from there) and uses `DEVFLOW_GATE_TOKEN`, a fine-grained PAT (Contents + Pull requests read/write, this repo only), because pushes and merges made with `GITHUB_TOKEN` do not trigger CI. Config is read from `.claude/devflow.json` at `baseBranch`. It does nothing unless `mergeGate.enabled`; with `dryRun` (default) it only reports.

Per run it walks open PRs labelled `labels.devflow`, oldest first, and **merges at most one**. Rules in order; the first failure decides:

1. not a draft; not `risk:high`; has `risk:low`; not `labels.blocked`;
2. base is `baseBranch` (a stacked PR waits for its parent);
3. mergeable (not yet computed → skip; conflicts → label the PR and its linked issues blocked, comment once pointing at `/devflow:sync`);
4. not behind its base; if behind, `update-branch` and stop for this PR (CI re-runs);
5. every `mergeGate.requiredChecks` entry is green on the head SHA (check run or commit status);
6. no unanswered review thread (unresolved, not outdated, last comment not by the PR author).

Then: merge with `mergeGate.method` (merge commit) pinned to the head SHA, retarget open PRs based on the merged branch to `baseBranch`, delete the head branch (same-repo, not a protected name). The run summary lists every PR with action and reason. `tests/merge-gate.test.cjs` covers each rule against a fake Octokit.

**Review check** = `claude-code-review.yml`: sets `devflow/review` pending, reviews with Opus (correctness, tests incl. Test cases rows, scope, CLAUDE.md), writes a verdict file `{verdict, critical, warning, summary}` and publishes `devflow/review` as success (pass) or failure (changes, or no verdict). It runs on open, ready, reopen and every push. If the only commits since the last bot-published result are clean base merges (two parents, made by GitHub's web-flow), it copies that result to the new head instead of re-reviewing. Concurrent runs for one PR are cancelled. The `devflow/review` status is created with `GITHUB_TOKEN` and does not fire `status` events, which is why the gate also listens for the review workflow's `workflow_run`.

## Guard hook (`hooks/guard.py`)

PreToolUse, matcher `Bash|mcp__.*merge_pull_request`. Exit 2 with a reason on stderr to block:

- any MCP tool whose name ends with `merge_pull_request`;
- Bash: `gh pr merge`, `gh api ... /merge` (PUT; an explicit GET is allowed), the GraphQL merge mutations (`mergePullRequest`, `enablePullRequestAutoMerge`), `git push` that targets a protected branch (explicit refspec `:main`, `HEAD:main`, `main`, or pushing while the current branch is protected), `git push --force`/`-f`/`+refspec` (allow `--force-with-lease`), `git push --mirror`/`--all`/`--delete` of a protected branch.

Protected branches = `protectedBranches` + `baseBranch` from `.claude/devflow.json` in the project (`$CLAUDE_PROJECT_DIR`), defaulting to `main`, `master`, `develop` when the file is missing. Parse commands with `shlex` like the TaskBoard `block_git_add_all.py` hook (look through `env`/`sudo`/`bash -c` wrappers; regex fallback when shlex fails). Stdlib only, Python 3.9. Ship `test_guard.py` (unittest) covering blocked and allowed cases, including that `update_pull_request` and `update_pull_request_branch` stay allowed (`/devflow:sync` needs them). The merge gate Action is outside the hook's reach by design: it is the one place merges happen, and it runs with its own token.

## Templates

- `spec.md`, `issue.md`, `pr.md` as described above, with HTML comments explaining each section. English.
- `claude-code-review.yml`: see Risk and the merge gate. One summary comment edited in place, inline comments, no approve/request-changes, and it skips points already raised or answered.
- `devflow-merge-gate.yml` + `devflow-merge-gate.cjs`: see Risk and the merge gate.
- `claude.yml`: the standard Claude app mention handler (unchanged upstream workflow).

## Out of scope (later waves)

- One ticket per session/worktree, and parallel task execution. Tasks still run sequentially in the user's checkout; hotspot files are recorded for this later work.
- Dispatching tasks to other sessions or agents.
- A QA agent running in parallel with implementation (the QA step today runs once, on the spec).
- `/devflow:answer` (answering blocked-issue questions).
- GitHub Projects (v2) board sync — labels are the state machine.
- Uploading screenshots to PRs (no API path); evidence is text.
