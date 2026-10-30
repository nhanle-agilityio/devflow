# devflow — design

A Claude Code plugin with two project-agnostic workflows:

1. **`/devflow:spec`** — idea → analyse → grill-me → spec PR → Gate 1 (human merges) → GitHub issues labelled ready.
2. **`/devflow:next-task`** — run locally on demand: pick up to N ready issues → implement (test first) → checks → verify → review → open PR. Plus **`/devflow:address-reviews`** to resolve review comments on the PRs it opened.

Nothing in the plugin knows about a specific stack. Project mechanics live in `.claude/devflow.json`; project rules (architecture, conventions, "Never" list) live in the project's `CLAUDE.md`. Skills read both and never restate them.

## Principles

- **Deterministic where it matters.** The loop and the order of stages in `next-task` are a Workflow script (`workflows/next-task-engine.js`), not prose. Safety rules are hooks, not instructions.
- **Humans own merges.** The plugin opens PRs and pushes its own feature branches, never merges, never pushes to the base branch, never force-pushes (except `--force-with-lease` on its own branch).
- **Model tiers.** Opus plans and reviews; Sonnet implements; Haiku runs mechanical steps (listing, checks, labels).
- **GitHub via the GitHub MCP server** (issues, labels, PRs, comments). `gh` is optional, never required. Adding a missing label to an issue creates it.
- **Stack-agnostic verification.** `http` (API calls against the dev server), `browser` (Playwright MCP, or Claude in Chrome if that is what the user has) and `none`. A project enables any subset.
- **All committed content is English.** No `Co-Authored-By` or AI attribution in commits or PRs, unless the project's CLAUDE.md says otherwise.
- **Never write the literal string `@claude` into issues, PRs or comments** except the deliberate re-review trigger in `address-reviews`: repos that use `anthropics/claude-code-action` start a job on it.

## Layout

```
.claude-plugin/plugin.json          name "devflow", description, author, repository, license MIT (no version: follow commits)
.claude-plugin/marketplace.json     marketplace "nhanle-devflow", plugins: [{name: devflow, source: "./"}]
README.md                           what it is, install, per-project setup, usage, safety, permissions snippet
DESIGN.md                           this file
LICENSE                             MIT
skills/init/SKILL.md                /devflow:init
skills/init/templates/devflow.json          annotated example config
skills/init/templates/devflow.schema.json   JSON Schema for the config
skills/init/templates/claude-code-review.yml  generic PR review Action (reads CLAUDE.md + devflow.json)
skills/init/templates/claude.yml            @claude mention Action
skills/spec/SKILL.md                /devflow:spec
skills/spec/templates/spec.md       spec + task list template
skills/spec/templates/issue.md      issue body template
skills/next-task/SKILL.md           /devflow:next-task  (thin entry: preflight, then calls the workflow)
skills/next-task/templates/pr.md    PR body template
skills/address-reviews/SKILL.md     /devflow:address-reviews
workflows/next-task-engine.js       meta.name "next-task-engine" → /devflow:next-task-engine (internal; users run /devflow:next-task)
hooks/hooks.json                    PreToolUse guard
hooks/guard.py                      python3 (3.9+, stdlib only)
hooks/test_guard.py                 unittest for guard.py
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
    "blocked": "agent:blocked", "e2e": "needs-e2e"
  },
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
4. Offer (each a separate yes) to copy the two GitHub Action templates into `.github/workflows/` when absent, and print the `permissions` snippet from the README for `.claude/settings.json`.
5. Remind the user that the plugin hook blocks merges and pushes to protected branches.

## `/devflow:spec <idea or path to a brief>`

`disable-model-invocation: true`. Designed to run in a cloud session (claude.ai/code) on the repo, works locally too. Steps, each announced with its number:

1. **Analyse.** Read `.claude/devflow.json`, `CLAUDE.md`, and the code the idea touches. Produce a short analysis: current behaviour, affected areas (backend/frontend/infra/data), risks, unknowns. Do not write files yet.
2. **Grill.** Invoke the `grill-me` skill on the idea plus the analysis. Keep going until every unknown is decided or explicitly deferred. If `grill-me` is not available, run the same interview inline: one question at a time, each with a recommended answer.
3. **Spec + tasks.** Create branch `spec/<slug>` from `<remote>/<baseBranch>`. Write `<specDir>/<YYYY-MM-DD>-<slug>.md` from `templates/spec.md`: problem, goals/non-goals, decisions (with the grill answers), design (API contracts, data model, UI screens and states, mocks if any — mocks go in `<specDir>/<slug>/`), risks, and the **task list**. Each task: stable id `T1..Tn`, title, type, `area`, depends-on, acceptance criteria written as checkable behaviour (API: request → response; UI: user action → visible result), files/areas in scope, test plan, `needs-e2e` yes/no, size S/M (split anything bigger).
4. **Test matrix (QA).** Skipped when `spec.testMatrix` is false. A QA agent (Agent tool, model `spec.qaModel`, default opus) gets only the spec file and `CLAUDE.md`, not the grill conversation, so it tests what the spec says rather than what was meant. It returns test-case rows (id `T<n>.<k>`, criterion, case happy/error/edge/boundary, Given/When/Then, level unit/integration/http/e2e, priority must/should; every criterion has a must row), the criteria it cannot test as written, and cases the spec leaves undecided. Those go back to the user one at a time with a recommended answer; the spec is updated and QA runs again, at most 2 rounds, leftovers under Risks. The rows go into the spec's Test matrix and each task's test plan points at them. Opus is the default because the value of the step is in spotting what the spec does not say, and the matrix is copied into every issue, so a miss repeats; it runs once per spec, so the cost is small.
5. **Spec PR.** Commit `docs(spec): <title>`, push the branch, open a PR to `baseBranch` titled `spec: <title>`, body = summary + task table + test matrix size and QA questions resolved/open. No need to ask before pushing the spec branch or opening the PR.
6. **Gate 1.** Ask exactly one question (AskUserQuestion): "Spec PR <url> merged?" — options: merged / changes requested / abandon. Changes requested → read the PR review comments, update the spec on the same branch, push, ask again. Abandon → close nothing, stop. Merged → verify through MCP that the PR is merged; if not, say so and ask again.
7. **Issues.** Search existing issues for each task title first (no duplicates; re-running after a partial failure must be safe). Create one issue per task from `templates/issue.md`: title `[<slug>] T<n>: <task title>`, body with spec link (on baseBranch), acceptance criteria as a checklist, scope, test cases (the task's Test matrix rows, or the test plan when there is no matrix), `Depends on #<n>` lines (resolve task ids to issue numbers — create in dependency order), labels `labels.ready` plus `labels.e2e` when needed plus `type:<type>`. Then comment on the spec PR with the issue list. Final message: table task → issue.

## `/devflow:next-task [limit | #issue ...]`

`disable-model-invocation: true`. Entry point only; the work is the workflow.

Preflight (inline, fail fast with a clear message):
- `.claude/devflow.json` exists and parses; else tell the user to run `/devflow:init`.
- Working tree clean; current branch noted (restored at the end).
- `git fetch <remote> <baseBranch>` succeeds.
- GitHub MCP reachable (get the authenticated user).

Then call the Workflow tool with name `devflow:next-task-engine` and `args = { config: <parsed devflow.json>, limit: <n or config default>, issues: [<explicit issue numbers>] , startBranch: <current branch> }`. When it returns, print the summary table: issue → PR / blocked (reason) / skipped.

## Workflow `next-task-engine.js`

Plain JS, no `Date.now()`/`Math.random()`, no filesystem. Tasks run **sequentially** in the main checkout (they share one working tree and often touch the same files). Every agent gets the config in its prompt. Every agent returns structured output (schemas below); a stage that fails marks the issue blocked and moves on to the next issue.

Phases: `Select`, then per issue `Implement`, `Check`, `Verify`, `Review`, `Ship`, then `Report`.

1. **Select** (haiku, schema `{issues:[{number,title,labels,body,dependsOn:[int]}], skipped:[{number,reason}]}`): explicit issues if given, otherwise open issues with `labels.ready`, not labelled inProgress/blocked, no open PR referencing them, all `Depends on` issues closed. Order: dependencies first, then oldest. Take `limit`. `log()` what was skipped and why (no silent caps).
2. Per issue, in order:
   - **Claim** (haiku): add `labels.inProgress`, remove `labels.ready`; `git switch -c <branch> <remote>/<baseBranch>` (branch from `branchPattern`). Return `{branch}`.
   - **Implement** (sonnet, schema `{status: done|blocked, summary, commits:[sha+msg], filesChanged, assumptions:[], outOfScope:[], blockedReason?}`): read the issue and the linked spec; follow CLAUDE.md. For behaviour changes and bug fixes: commit a failing test first (`test(<scope>): ...`), confirm it fails for the right reason, then the implementation (`feat|fix(<scope>): ...`). When the issue has a Test cases table, write a test for every `must` row, traceable to its row id. Stage files by name. Stay inside the issue scope; record anything else in `outOfScope`. Ambiguity that changes behaviour and is not answered by the spec → `blocked` with the question (no guessing on contracts); minor ambiguity → decide and record in `assumptions`.
   - **Check** (haiku, schema `{passed, failures:[{check, output}]}`): run every `checks[].run` in order, report only failures (trimmed output). If failed: **Fix** (sonnet) with the failures, then Check again; up to `maxFixRounds`. Still failing → blocked.
   - **Verify** (sonnet, schema `{ran, mode, steps:[{action, expected, actual, pass}], notes}`): only if the issue has `labels.e2e` or the diff touches UI, and `verify.modes` is non-empty. Start the dev server in the background, wait until `url` answers (≤ `readyTimeoutSec`), walk every acceptance criterion and every Test cases row with level http or e2e: `http` with curl, `browser` with the configured browser tool (navigate, act, read the page; take screenshots for the agent's own check). Stop the server. Failures → one Fix round (sonnet) → Check → Verify again; still failing → blocked.
   - **Review** (opus, read-only, schema `{verdict: pass|changes, findings:[{severity: critical|warning|suggestion, file, line, problem, fix}]}`): review `git diff <remote>/<baseBranch>...HEAD` against the issue's acceptance criteria, the spec and CLAUDE.md; correctness first, then tests (does each change have a test that fails without it; a `must` Test cases row without a traceable test is a warning), then scope creep. Critical/warning → Fix (sonnet) → Check → Review again, up to `maxReviewRounds`; suggestions go to the PR body, not fixed.
   - **Ship** (haiku): push the branch (`git push -u <remote> <branch>`), open a PR to `baseBranch` via MCP with `templates/pr.md` filled from the stage results (what, how, tests, verification evidence, assumptions, out of scope, `Closes #<n>`), add `labels.review` to the issue and remove `labels.inProgress`. Return `{prNumber, url}`.
   - **On blocked at any stage** (haiku): commit nothing further; if the branch has commits, push it so work is not lost; comment on the issue with the stage, reason and question; label `labels.blocked`, remove `labels.inProgress`; `git switch <startBranch>`.
   - After each issue: `git switch <startBranch>` so the next one starts clean.
3. **Report**: return `[{issue, status: pr|blocked|skipped, url?, reason?}]`.

## `/devflow:address-reviews [#pr ...]`

`disable-model-invocation: true`. Default target: open PRs whose linked issue has `labels.review` and that were authored by the current user.

Per PR:
1. Read review threads and the latest review summary comment (MCP). Keep only unresolved, actionable threads.
2. Classify each: fix / answer (question) / won't fix (out of scope or wrong — say why, cite CLAUDE.md or the spec).
3. Check out the branch, apply fixes as new commits (`fix(<scope>): address review — <what>`), run `checks`, push. Never rewrite pushed history.
4. Reply on every thread (fixed in <sha> / answer / won't fix + reason).
5. If anything was fixed and the repo has `claude-code-review.yml`, post `@claude review again` once. Round count = number of such comments already on the PR; stop at `maxReviewRounds` and tell the user instead.
6. Switch back to the starting branch. Summary table PR → fixed / answered / won't fix / rounds left.

## Guard hook (`hooks/guard.py`)

PreToolUse, matcher `Bash|mcp__.*merge_pull_request|mcp__.*update_pull_request_branch`. Exit 2 with a reason on stderr to block:

- any MCP tool whose name ends with `merge_pull_request`;
- Bash: `gh pr merge`, `gh api ... /merge` (PUT), `git push` that targets a protected branch (explicit refspec `:main`, `HEAD:main`, `main`, or pushing while the current branch is protected), `git push --force`/`-f`/`+refspec` (allow `--force-with-lease`), `git push --mirror`/`--all`/`--delete` of a protected branch.

Protected branches = `protectedBranches` + `baseBranch` from `.claude/devflow.json` in the project (`$CLAUDE_PROJECT_DIR`), defaulting to `main`, `master`, `develop` when the file is missing. Parse commands with `shlex` like the TaskBoard `block_git_add_all.py` hook (look through `env`/`sudo`/`bash -c` wrappers; regex fallback when shlex fails). Stdlib only, Python 3.9. Ship `test_guard.py` (unittest) covering blocked and allowed cases.

## Templates

- `spec.md`, `issue.md`, `pr.md` as described above, with HTML comments explaining each section. English.
- `claude-code-review.yml`: same shape as the TaskBoard one (review once on open/ready/reopened, one summary comment edited in place, inline comments, no approve/request-changes) but the prompt says: read CLAUDE.md and `.claude/devflow.json`; check correctness, tests, scope against the linked issue's acceptance criteria.
- `claude.yml`: standard @claude mention handler.

## Out of scope for v1

- Parallel task execution (worktrees). Revisit when tasks are reliably independent.
- GitHub Projects (v2) board sync — labels are the state machine.
- Uploading screenshots to PRs (no API path); evidence is text.
