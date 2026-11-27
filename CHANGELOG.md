# Changelog

All notable changes to devflow. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [3.3.2] - 2026-11-27

The last fixes from a full lifecycle audit of unattended autopilot runs: no stalls on finished lanes, no overlapping ticks, backoff for failed launches, resumed PRs, closed merged children and a claim check before Ship.

### Fixed
- Autopilot locks each tick, wakes on lane changes or timeout, tracks working sessions with bounded history, backs off failed launches, resumes open PRs and closes merged children, while next-task parks idle worktrees, orders claims at millisecond precision, rechecks ownership before Ship and releases the claim afterward. (#195)

### Upgrade
- Update the plugin to 3.3.2 and run `/devflow:doctor --fix` to move the helper rules to 3.3.2; nothing else changes (no template, schema or config key). Stop old background lane sessions that already finished (`claude agents`), then restart `/devflow:autopilot`: plans written by earlier versions with short session ids are matched by prefix.

## [3.3.1] - 2026-11-26

Claims are released reliably and autopilot recovers an issue that no lane is working on.

### Fixed
- Claims are released by editing them to a released marker because the GitHub MCP server cannot delete comments; a quoted timestamp no longer lets a stale claim win; autopilot resets an in-progress issue that no lane works on after 15 minutes instead of waiting for the 12-hour stall. (#192)

### Upgrade
- Update the plugin to 3.3.1 and run `/devflow:doctor --fix` to move the helper rules to 3.3.1; nothing else changes (no template, schema or config key). Claim comments left by earlier runs are released by the next run or by autopilot when it resets an orphaned issue; doctor check 14 lists any that remain. Restart a running `/devflow:autopilot` loop.

## [3.3.0] - 2026-11-26

Unattended runs no longer stop on flow faults seen in the first autopilot run, checks can share a local service safely, and autopilot wakes within minutes of a lane finishing.

### Added
- `checks[].lock`: a check holds a named lock while it runs (also during the commit red check), so lanes sharing one local service never run it at the same time; autopilot wakes within 1–2 minutes of a lane finishing instead of waiting a fixed interval. (#189)

### Fixed
- Unattended runs no longer stop on flow faults: absolute paths from agents no longer block the commit step (unlisted changed files go into the code commit and are reported), a blocked issue parks its uncommitted work in a named stash (`devflow-run park`) so the lane continues on a clean tree, re-runs no longer collide with an empty kept branch, and the lane note names the real parent ("stacked on #<p> (PR #<n>)"). (#189)

### Upgrade
- Update the plugin to 3.3.0, then run `/devflow:init --upgrade` (installs the new `.claude/devflow.schema.json` with `checks[].lock`) and `/devflow:doctor --fix` (moves the helper rules to 3.3.0; `park` uses the existing `devflow-run` rule). Add `"lock": "<name>"` to checks that share a local service, for example a test check that resets one local database. Restart a running `/devflow:autopilot` loop to pick up the faster wake-up. Work left by an issue blocked before 3.3.0 stays uncommitted in its worktree; stash or commit it before re-running.

## [3.2.3] - 2026-11-26

`/devflow:doctor --fix` no longer leaves an uncommitted settings file that stops the next autopilot run.

### Fixed
- `/devflow:doctor --fix` no longer leaves `.claude/settings.json` uncommitted (which stopped autopilot, accept, next-task and dispatch at preflight): check 8 writes the allow rules on `chore/devflow-allow-rules-<version>`, opens a PR and switches back, removes stale devflow rules of older plugin versions and the old `devflow-lane-:*` rule, and lists the current rule set. Check 6 uses `claude agents --json`. (#186)

### Upgrade
- Update the plugin to 3.2.3. The next `/devflow:doctor --fix` proposes the allow rules on a `chore/devflow-allow-rules-3.2.3` PR (it removes the 3.2.2 helper paths); merge it and `git pull` before the next autopilot or dispatch run. Reusable-mode callers may move their pin to `v3.2.3` with `/devflow:init --upgrade`; the gate did not change.

## [3.2.2] - 2026-11-26

Autopilot runs unattended to the end: every loop tick runs, no permission prompt stops a lane, and PRs waiting for a merge are reported.

### Fixed
- `/devflow:autopilot` now runs every `/loop` tick (it no longer sets `disable-model-invocation`), lists each PR in review as waiting for its merge instead of dropping it, and the generated allow list matches numbered lane sessions (`devflow-lane-*`) and covers `claude --version`, `claude agents --json`, `devflow-gh` and `devflow-scan`, so an unattended run no longer stops at a permission prompt. (#183)

### Upgrade
- Update the plugin to 3.2.2, then run `/devflow:doctor --fix` (check 8) to add the new allow rules: `claude --bg --name devflow-lane-*` (the old `devflow-lane-:*` rule never matched a lane and can be removed), `claude --version`, `claude agents --json` and the `devflow-gh` and `devflow-scan` helpers. Reusable-mode callers may move their pin to `v3.2.2` with `/devflow:init --upgrade`; the gate did not change. Restart a running `/devflow:autopilot` loop after updating: it resumes from the epic's plan comment.

## [3.2.1] - 2026-11-26

Fixes a crash that blocked a lane whenever a run decided a question.

### Fixed
- A run that decides a question no longer crashes with "Date.now() / new Date() are unavailable in workflow scripts" and blocks its lane: the engine dates `## Decisions` lines from the new `runDate` arg (or the `claimId` prefix) instead of the clock. (#180)

### Upgrade
- Update the plugin to 3.2.1. Reusable-mode callers may move their pin from `v3.2.0` to `v3.2.1` with `/devflow:init --upgrade`; the gate script did not change. Issues blocked with `Stage: Error` and "Date.now() / new Date() are unavailable in workflow scripts" can be retried: remove `agent:blocked` after updating.

## [3.2.0] - 2026-11-26

Wave 5, autopilot: one command runs an approved epic to the end; people review `risk:high` PRs and read a daily digest.

### Added
- The merge gate now readies eligible dependent issues and retargets stacked devflow PRs after human merges. (#163)
- `/devflow:autopilot` runs an approved epic in a self-paced loop and records lane progress on the epic until every sub-issue closes. (#166)
- `/devflow:report --daily` prints an epic's daily digest, and autopilot posts it on the epic each day and refreshes it at completion. (#167)

### Changed
- Record high-risk decisions for human review and file deduplicated triage bugs for exhausted check fixes and missing run requirements. (#164)
- Dispatch can start fan-out children in parallel on open parent PRs before their dependencies merge. (#165)
- `/devflow:spec` now extracts shared groundwork into foundation tasks, records dependencies only on code or files a task uses, and warns when a task has 3 or more dependents. (#168)

### Fixed
- Keep a decision flagged for human review when a run resumes an issue, report a ready issue whose open PR has no run, and allow the plugin helpers and lane sessions that dispatch and autopilot run unattended. (#162)

### Upgrade
- Question handling changed under `nextTask.onQuestion: decide`: product, criterion, contract, stored-format and lower-risk questions, and questions on a branch touching `risk.highPaths`, are now decided instead of blocking. They are recorded with `[needs human review]`, and the PR gets `decisions:review` and `risk:high`, so a human always merges it. Set `"onQuestion": "block"` to keep every question blocking.
- Readiness changed: with `spec.autoReady`, a child becomes ready as soon as each dependency is closed or has an open PR ahead of the base (any risk), and `/devflow:dispatch` stacks it on the parent branch. Hub children and multi-parent children are listed as `stacked` instead of sharing the parent's lane.
- The merge gate script and workflows changed. The gate now has a post-merge mode on `pull_request: closed` and a per-PR concurrency group. Copy-mode projects run `/devflow:init --upgrade`. Reusable-mode callers move their pin from `v3.1.0` to `v3.2.0`, also with `/devflow:init --upgrade`; the caller gains the `pull_request: closed` trigger. No new secret or token permission is needed.
- Run `/devflow:doctor --fix` (check 8) to add the new allow rules for the plugin helpers `devflow-lanes`, `devflow-autopilot` and `devflow-digest`, and for `claude --bg --name devflow-lane-`; `/devflow:init --upgrade` does not change the allow list. Without them an unattended `/devflow:autopilot` loop stops at permission prompts.
- Before the first `/devflow:autopilot` run, set `nextTask.maxAgentCalls` to a non-zero value; with 0 there is no per-issue ceiling, and autopilot only warns. The optional `autopilot.*` keys keep their defaults: `maxLanes` from `dispatch.maxLanes`, then 3; `maxAgentCallsPerTick` 20; `stallHours` 12.
- PR bodies now carry `agentCalls` in the `devflow-run` marker; PRs opened earlier count as unknown cost in the digest.
- Release smoke: not run for 3.2.0, for the same reason as 3.1.0: `bin/devflow-smoke` needs the `gh` CLI, which the release machine does not have. Autopilot has not run on a live epic yet; the first tick on a sandbox epic is the smoke test.

## [3.1.0] - 2026-11-25

### Added
- Follow-up issues filed by Ship have a `Found in: #<pr>` line (the branch name when no PR exists yet) and the `file:line` of the problem when known (#99)
- `/devflow:spec` writes `Resolves: #a, #b` into the epic when the request names existing issues it resolves; Ship of the epic's last open sub-issue adds a `Closes #<n>` line for each listed issue that is still open and skips numbers that do not exist or belong to another repository, with a note in the PR body (#99)
- `bin/devflow-changelog` and the optional config keys `changelog.fragmentsDir` (no default) and `changelog.file` (default `CHANGELOG.md`): `has <n>` checks the fragment `<fragmentsDir>/<n>.md`, `preview` prints the release section (sections in Keep a Changelog order, fragments by issue number, bullets ending ` (#<n>)`) and `assemble` writes it below `## [Unreleased]`, moves the bullets already there into it and deletes the fragments. Invalid fragments or changelog stop with exit 1 and nothing written; an unset `fragmentsDir` or a usage error exits 2. A 3.0.0 config stays valid (#95)
- `/devflow:dispatch --plan` prints the lane plan (lanes, order, shared and ignored hotspots, deferred and waiting issues) and starts no session; "nothing to run" when no issue is ready. `bin/devflow-lanes` adds `ignoredTouched` per lane (ignored hotspots, exact path, that an earlier lane also names, sorted) and the dispatch report prints it as the files where `/devflow:sync` may work (#96)
- `/devflow:doctor` warns when the declared version (`plugin.json` `version`, else the newest changelog version heading) has no tag `<release.tagPrefix><version>`, naming the missing tag, and when the two sources differ. `/devflow:release` refuses to propose a version when the previous released version in the changelog has no tag, names it, and continues only after you say so (#98)
- `/devflow:doctor` ends with a read-only "Waiting on you" section, one line per item with one command: blocked issues (`/devflow:answer #n`), PRs waiting for a human merge, PRs in conflict or behind (`/devflow:sync #pr`), ready issues (`/devflow:next-task` or `/devflow:dispatch`), sub-issues of an open epic without the ready label, and epics to accept (`/devflow:accept #n`). Each issue or PR appears once, an unclassifiable item is listed as "check by hand", and it never changes anything, also with `--fix` (#103)
- QA test rules: the QA prompt forbids changing an existing test or fixture that no Test cases row names (it reports it instead) and tests that depend on branch state (a diff against the base, the branch name, unpushed commits, the date); `/devflow:spec` lists such a row as a review check, not a test row. The weakened-checks scan reports every changed or deleted pre-existing line in a test or fixture file as `changed-existing-test` (new files, added lines, whitespace-only or comment-only changes and pure renames are not hits); it is a warning finding, routed to the QA fix agent for a `qaFiles` file and to the dev Fix agent otherwise, and the reviewer may accept it when a Test cases row names the change (#104)
- Every agent that can ask returns questions as objects (`text`, `tag`, `recommended`, `reason` and ten booleans) and the pure `classifyQuestion` decides or blocks them, failing closed. A blocked run posts all questions in one `<!-- devflow-questions -->` comment, each followed by `Recommended: <option> (<reason>)`; a question that changes a criterion ends with `[changes a criterion: typed answer needed]`. New optional config keys `nextTask.onQuestion` (`decide`|`block`), `nextTask.trustDecisions` (default `false`, read by the merge gate in a separate change) and `labels.decisionsReview`; a 3.0.0 config stays valid (#105)
- `bin/devflow-smoke --repo owner/name --issue <n> --expect low|high`: a read-only release smoke checker (`gh api` GET only) that prints one `ok`/`fail` line per check (issue state, exactly one closing `devflow` PR, `devflow-run` marker with `path` and `reviewRounds`, `## Review` section, `Risk:` line, gate merge for `low` or human merge or open with `risk:high` for `high`) and exits 0 only when all pass, 2 when `gh` is missing or unauthenticated; smoke fixture issue bodies in `docs/smoke/low.md` and `docs/smoke/high.md` (#108)
- `/devflow:doctor` (check 12) lists open `needs-triage` follow-ups as "may be fixed, check and close" when `git log -L` on the base shows a commit to the recorded `file:line` after the issue was created (a deleted file counts as changed), or, without a record, when a merged PR mentions `#<n>`; it never closes an issue. `/devflow:accept` lists the open follow-ups filed from the epic's PRs in its result (#109)
- `/devflow:answer #n accept` answers every open question with its `Recommended:` option and `accept; 2: <answer>` overrides single ones; it refuses a question marked `[changes a criterion: typed answer needed]` (nothing is recorded until all are answered), says so when there are no open questions, and refuses an override number out of range or repeated (#111)
- Fixed rules for branch resume and base conflicts: an existing local or remote branch whose name starts with `<type>/<issue>-` is resumed without a question and named in the PR's Assumptions (several matches: the one with an open devflow PR, else the remote branch with the newest commit; another type prefix or a longer number does not match); a conflict from merging the base into a resumed branch is resolved in Integrate and blocks only for behaviour the issue does not cover; the Branch, Integrate and Implement prompts say a commit-structure question is never asked (#112)
- Every `/devflow:next-task` result entry has a `next` step (`answer`, `merge`, `sync`, `nothing` or `check by hand`), and the result table prints it in a Next column with the exact command (#113)
- Next-task reviews use Sonnet for low-risk issues and Opus for high or unknown risk by default. Configure either model with `nextTask.reviewModel` and set an optional per-issue agent-call budget with `nextTask.maxAgentCalls`. (#141)
- Deterministic workflow checks with per-command timeouts and combined output tails. (#144)
- Deterministic next-task branch naming, branch setup and clean checkout restoration. (#145)
- Approve an epic once with `/devflow:approve` and let dispatch and the merge gate ready eligible sub-issues according to `spec.autoReady`. (#147)

### Changed
- Commit grouping follows CLAUDE.md and the plan: the Plan agent returns `commitRules` (the commit rules of CLAUDE.md) and `separateCommits`; the commit stage and every fix prompt carry the rules and, on the full path, the plan's "Order of commits". When CLAUDE.md asks for separate code, tests and docs commits the commit stage makes the QA test commit, the code commit, then a `docs(<scope>)` commit (repository-root `*.md`, `docs/**`, changelog fragments; never `skills/**` or `agents/**`), skipped when there are none. Otherwise the 3.0.0 grouping stays. No prompt asks to amend, rebase, squash or split a commit (#94)
- `/devflow:accept` no longer stops at preflight without `verify.devServer` or with empty `verify.modes`: it runs in evidence-only mode. Criteria that need a running app are `not checkable`; the others take their result from the merged PRs' checks, test-matrix rows and manual rows recorded as pass in the PR body, and a criterion with no such evidence is `not checkable`. The `<!-- devflow-accept -->` result is still posted on the epic or spec PR (#102)
- `nextTask.onQuestion` defaults to `decide` (3.0.0: every question blocked). A question whose recommended option is reversible and safe (no criterion, contract, stored format, risk or check change, no destructive git, nothing outside the repository, no `risk.highPaths` file in the branch's full diff) is answered by the run, recorded as `- <date> decided by run: <question> -> <option> (<reason>)` under the issue's `## Decisions` and in the PR's new `## Decisions taken` section, and the PR gets `labels.decisionsReview` (`decisions:review`). A review warning still open after `maxReviewRounds` ships the same way; a critical finding still blocks. Set `"nextTask": { "onQuestion": "block" }` for the 3.0.0 behaviour (#105)
- With `changelog.fragmentsDir` set, the implement and fix prompts tell the agent to add the fragment `<fragmentsDir>/<issue>.md` and never edit the changelog file, and the reviewer prompt and `agents/reviewer.md` check the fragment, not the changelog, for the entry; without it the prompts are unchanged. `/devflow:release` shows `devflow-changelog preview` output in its notes when fragments are on and does not write it. This repository now uses `changelog.d` (its `[Unreleased]` bullets moved into fragments) and `dispatch.ignoreHotspots` lists the doc files and the fragment directory, which never needs a lane (#106)
- The Release process at the bottom of `CHANGELOG.md` (and DESIGN.md) is the release task template: it runs `devflow-changelog assemble` when fragments are on, has a smoke run in the sandbox (plugin from the release branch with `--plugin-dir`, two issues from the fixtures started with `/devflow:dispatch` as two lanes, the checker for both, conflicts, "behind" updates and `/devflow:sync` calls recorded in the release PR), merges the release PR only when both checks pass, tags right after the merge, and has the upgrade note of a release that changes a reusable workflow tell callers to move their pin (#108)
- The merge gate skips a `risk:low` PR labelled `labels.decisionsReview` (`decisions:review`) with the reason `decisions:review: waits for a human`, unless `nextTask.trustDecisions` is `true` (default `false`); with trust on, such a PR goes through the usual rules (high paths, conflicts, behind, checks, threads). PRs without the label behave as in 3.0.0, and the reusable workflow's inputs and secrets are unchanged (#110)
- Refresh the README, design and bilingual flow demos for the merged Wave 3 and Wave 4 features, including epic approval and automatic readiness. (#149)
- Run the parallel QA commit stage and Verify locking through `devflow-run`. Check that tests fail at the QA commit in a temporary detached worktree without using the shared stash. (#151)
- Run Ship's protected branch push and PR title and body rendering through `devflow-run`. (#153)

### Removed
- Ten tests that only pinned prose wording, each already covered by a behaviour test (list approved on #114) (#115)

### Fixed
- `/devflow:report` shows the local review ("local review: pass, N round(s)" or "fail") when a PR has no `devflow/review` status, shows Plan and Verify as "skipped (short path)" in a neutral style on the short path and greys missing steps on the full path, and tells who merged: `gate` for the gate marker comment or trailer, `human` for a devflow PR without gate evidence, else the 3.0.0 rule (#100)
- The merge gate clears DevFlow state labels from issues linked to its merges and sweeps recently closed issues. Next-task ignores claims from before the latest block and verifies claim release. Doctor can clean lingering state labels and stale claims with confirmation (#101)
- The `/devflow:report` trace page now renders Plan and Verify as "skipped (short path)" in a neutral style on the short path, and shows Checks and Verify rows (Verify only when `verify` is configured) that are greyed when missing on the full path (#125)
- The next-task scan reports one hit per deleted test or fixture file instead of one per line and ignores weakening keywords in source string literals. Review skips automatic changed-existing-test warnings for test files the plan gives to Dev and retries on the default agent when the `gh` reviewer cannot read the issue. Preflight detects `gh` with `bin/devflow-gh`. (#135)
- Continue on the issue's criteria and Test cases when an epic cannot be read in decide mode, and retry an empty agent result once within the call budget. (#155)

### Upgrade
- `nextTask.onQuestion` now defaults to `decide`: safe questions, an unreadable epic and review warnings left after the last round are recorded as decisions and the PR gets `decisions:review`, which the merge gate holds for a human unless `nextTask.trustDecisions` is `true`. Set `"onQuestion": "block"` for the 3.0.0 behaviour.
- The merge gate script changed (state-label cleanup, `decisions:review` hold, epic auto-ready). Copy-mode projects run `/devflow:init --upgrade`; reusable-mode callers move their pin from `v3.0.0` to `v3.1.0` (also `/devflow:init --upgrade`). `DEVFLOW_GATE_TOKEN` needs Issues read and write for the cleanup and auto-ready.
- Epic auto-ready is off by default: set `spec.autoReady` to `"low"` or `"all"` and approve epics with `/devflow:approve #<epic>`.
- Reviews of `risk:low` issues run on Sonnet (`nextTask.reviewModel`); the engine's mechanical steps (checks, branch, commit, verify lock, push, PR body) now run through `bin/devflow-run`, and `devflow-setup allow` lists its permission rule for background lanes.
- Release smoke: not run for 3.1.0. `bin/devflow-smoke` needs the `gh` CLI, which the release machine does not have; Waves 3 and 4 shipped through more than 20 PRs merged by the gate with run markers instead.

## [3.0.0] - 2026-11-18

Wave 2, the lighter flow: an epic as the spec, an optional GitHub review, and a short path for `risk:low` issues.

### Added
- `/devflow:report` takes an epic and shows per-issue metrics: `/devflow:report #<n>` uses the epic's native sub-issues plus the issues with `Epic: #<n>` (`spec.epic` is `{number,url}`, `spec.pr` is `null`), and each issue gets `metrics` (path, review rounds, times blocked, duration, merged by, plus `claimedAt`/`mergedAt` in the data only) from the `devflow-run` marker, the `devflow-blocked` comments and the merge marker. The trace page shows five metrics per issue, `null` as "unknown"; data without `metrics` still renders (#62)
- `/devflow:accept` takes an epic: `/devflow:accept #<n>` (or `<n>`; a number is always an issue number) uses the union of the epic's native sub-issues and the issues whose body has `Epic: #<n>`, with criteria and http/e2e rows from each sub-issue. The `<!-- devflow-accept -->` comment goes on the epic (edited in place on a re-run) and gap titles use the slug from `[<slug>]` in the epic title, else `[epic #<n>]`. `#<n>` with no sub-issues and no referencing issue stops with `#<n> is not an epic` and posts nothing. A spec path or slug works as in 2.9.0; the skill never closes the epic (#61)
- `/devflow:answer` only appends decisions: `- <date> (Q<k>): <question> → <answer>` to the issue's `## Decisions` (no acceptance criterion or Test cases row is edited; the "(updated by /devflow:answer)" rule is gone), `(#<issue>, Q<k>)` entries to the epic's `## Decisions` when the issue has an `Epic: #<n>` line, and to the spec's `## Decisions` through the spec PR only when the issue has a spec path (no branch or PR otherwise). A failed epic append is reported in the table and the comment; the unblock step is unchanged and its comment says where the decisions were recorded (#60)
- `/devflow:spec` closes open questions and runs one local spec review: the grill continues until no question is open (a deferred one goes into an `## Open questions` section of each affected sub-issue, and in `--file` mode into the spec's Risks and unknowns), and after the QA step a fresh agent (`spec.qaModel`) checks the draft against the brief for missing requirements, contradictions and tasks that are not independent, in epic and `--file` mode. Unlike QA it does not judge testability; only critical findings start another round, at most 2 reviewer calls (#59)
- `/devflow:spec` creates an epic by default: no spec file and no PR; it builds every body first, measures it by JavaScript string `length` (over 65,000 characters creates nothing and points to `--file`), then creates one epic (`[<slug>] <title>`, `type:epic`, from the new `skills/spec/templates/epic.md` with Goal, Design, `## Decisions` and a Tasks table) and one sub-issue per task (`[<slug>] T<n>: <title>`, `Epic: #<n>`, risk label, `type:<type>`, `labels.e2e` when needed, never `labels.ready`), links them with `sub_issue_write`, reuses issues found by exact title on a re-run and fills the Tasks table with the issue numbers. The human approves each sub-issue by setting `labels.ready`. `--file` keeps the 2.9.0 flow (spec file, spec PR, Gate 1, issues labelled ready after the merge) (#58)
- Config key `review.github` (boolean, default `false`): the GitHub review workflow (`devflow-review.yml` and the `claude-code-review.yml` template) starts with a `flag` step that reads `.claude/devflow.json` through the API (the default-branch copy to learn `baseBranch`, then the copy at `baseBranch`, which wins; never the PR head) and runs every other step only when `review.github` is `true`. With the flag off the job still succeeds, makes no Claude call, creates no `devflow/review` status (not even pending) and writes `devflow review is off (review.github is not true)` to the step summary; when no copy can be read it is off with a warning. With the flag on every step runs under the 2.9.0 conditions. Inputs, secrets and permissions are unchanged. Accepted trade-off: with the flag off no independent party confirms the local review (`devflow:reviewer`) (#52)
- Merge gate uses CI checks when the GitHub review is off: the effective required checks are `mergeGate.requiredChecks` without `devflow/review` while `review.github` is off, the list as is when it is on (the bot-creator rule for `devflow/review` stays). Whenever the effective list is empty (flag off with only `devflow/review`, which is the default list, or `requiredChecks: []`) the gate changes nothing, also in a dry run, and reports every candidate as `skipped` with `no required checks (devflow/review is ignored while review.github is off); refusing to merge`. Behaviour change: `requiredChecks: []` used to merge with no check and now refuses. Workflow triggers are unchanged (#53)
- Init and doctor know `review.github`: `/devflow:init` asks for it (`false` recommended, trade-off stated) and proposes `devflow/review` in `mergeGate.requiredChecks` only when it is true; init and `/devflow:doctor` (check 1) warn when `mergeGate.enabled` is true and the effective required list is empty, whatever the flag, listing the `name:` of each workflow in `.github/workflows/` as CI check candidates; `/devflow:init --upgrade` offers `review.github: true` as one plan item when `claude-code-review.yml` is installed, written only after a yes (#54)
- `/devflow:doctor` cleans up branches of merged devflow PRs: check 5 lists the leftover remote branch, local branch and worktree of every devflow-labelled PR with `merged_at` set; `--fix` asks one confirmation for the whole merged list, re-checks each item before deleting it (still merged, no open PR with the branch as base or head, not `baseBranch`, a protected or the current branch, not the current directory) and skips it with the reason when a re-check fails. Worktrees go with `git worktree remove` (no `--force`, dirty ones are kept), local branches with `git branch -d` only (a refusal prints `git branch -D <branch>` for you), remote branches with `git push <remote> --delete`. Branches of PRs closed without merging keep the yes per branch. Doctor also reports the "Automatically delete head branches" repository setting (`warn` when off, `unknown` when unreadable); the README recommends turning it on. The guard hook is unchanged (#63)
- Engine short path for `risk:low` issues: an issue whose labels (read at Claim) include `labels.riskLow`, do not include `labels.riskHigh` or `labels.e2e`, and whose Test cases table has no `http` or `e2e` row takes the short path: no Plan agent and no plan comment, no QA or commit agent (one implement agent writes the failing test first, also with `nextTask.parallelQa`) and no Verify, also when Implement changes the UI. Check with its fix rounds, the weakened-checks scan, Review (`maxReviewRounds`), Risk and Ship run as on the full path; a short path PR escalated to `risk:high` by the Risk step still skips Verify. Every other issue (`risk:high`, both risk labels, no risk label, `needs-e2e`, an `http`/`e2e` row) takes the full path as before. Each result entry carries `path: "short"` or `"full"`. Behaviour change: `risk:low` issues no longer get a plan comment or Verify (#55)
- Ship records the review trace and run markers: every PR body gets a `## Review` section (`Review: pass after <n> round(s) - local devflow reviewer in this run (GitHub review: off|on)`, `Path: short (Plan and Verify skipped)|full`, `Verify: ran|skipped (short path)|not needed|could not run`) and one hidden line `<!-- devflow-run {"path":...,"reviewRounds":<n>,"claimedAt":<ISO or null>} -->`; each result entry carries `reviewRounds`. Exactly one comment per block carries `<!-- devflow-blocked -->`: the questions comment as its second line (the first stays `<!-- devflow-questions -->`), otherwise the reason comment (#56)
- Engine and reviewer read the epic as the spec source: an issue with no spec path and a line `Epic: #<n>` (first match of `^Epic: #(\d+)`) makes the Plan, Implement, QA, Fix and Review stages read epic `#<n>` (GitHub MCP `issue_read`; the `devflow:reviewer` agent with `gh issue view`) for shared design and decisions, with criteria, Test cases and `## Decisions` from the issue winning. `specRead` must contain `#<n>` as a whole token; the stage schemas gain an optional `epicRead`, and `false` blocks the issue with `epic #<n> could not be read`. A spec path still wins over an `Epic:` line, and an issue with neither uses the issue alone (#57)

### Upgrade
- `review.github` defaults to `false`: the devflow GitHub review is off. To turn it on, set `"review": { "github": true }` in `.claude/devflow.json` (`/devflow:init --upgrade` offers it). With it on, the merge gate requires the `devflow/review` check, so keep `devflow/review` in `mergeGate.requiredChecks`; with it off, the gate drops that check and refuses to merge when no required checks remain.
- `/devflow:spec` creates an epic by default (the spec as the epic body, tasks as sub-issues). Use `--file` for the old flow that writes a spec file and a PR.
- The short path for `risk:low` issues: the engine skips the full stage chain for them (`path` is `short` in the run marker, `full` otherwise).
- Copy-mode projects run `/devflow:init --upgrade` for the new merge gate script; reusable-mode projects move to the new workflows when they pin `v3.0.0`. The `v3.0.0` tag is published only after a human merges the release.

## [2.9.0] - 2026-11-16

Wave 1 reliability fixes from the 2.7.0 review: claim and cleanup edge cases, a quieter and safer merge gate, trusted-author handling in sync and answer, stages that read the issue from GitHub, and init and doctor checks for the GitHub MCP server.

### Fixed
- Sync and answer act only on trusted authors' comments: sync handles threads started by the authenticated user, the review bot (`claude`, confirmed by a `claude[bot]` review) or a repository collaborator, uses a summary comment only from `claude[bot]` or the authenticated user, never resolves threads it did not start, and lists everything else as `ignored: not a collaborator`; answer takes the questions comment and answers only from the authenticated user or OWNER, MEMBER, COLLABORATOR authors, never bots. Sync skips updating a behind PR the merge gate updates (gate enabled, not dry run, devflow + `risk:low`, not stacked or blocked), and no longer claims an author reply clears a trusted human's thread. Answer says the engine resumes a branch with commits (#30)
- Merge gate blocks on unresolved collaborator threads: an unresolved, not outdated thread started by a human with association OWNER, MEMBER or COLLABORATOR blocks until it is resolved, even when the PR author replied last (`N unanswered review threads`). Threads started by the PR author or the review bot (`Bot` named `claude`) keep the last-comment rule; threads started by other bots, other associations (CONTRIBUTOR, NONE, ...), a deleted user or with no association do not block. Private organisation membership shows as CONTRIBUTOR and does not block (#32).
- Merge gate updates only the head of the queue: one run calls `updateBranch` once, for the first eligible behind PR in priority order; later behind PRs get `deferred: waits for its turn` (dry run: the first is `would update`). An up-to-date PR with a running required check and none failed holds the slot. Skipped, failed or missing-check PRs and an `updateBranch` error free it; no clock is used. Accepted windows: a `pending` status that never resolves blocks updates until the check is re-run or the status replaced, and an in-flight check can still fail after holding the slot for a run (#31).
- Claim treats an issue as taken only when it has an assignee other than the authenticated user, or the in-progress / blocked / review label; an issue assigned only to the authenticated user is claimed. The claim reports `assignedByRun`, and a blocked run (or a loser of the claim race with a different author) removes the authenticated user from the assignees only when the run added them (#28).
- Engine: a stage agent that throws after the claim was won now runs the blocked cleanup with stage `Error` (reason `Error: <first line>`; the assignee is removed only under the `assignedByRun` rule). A throw from the claim or release agent reports `Workflow error:` with the note `claim may be partial; run /devflow:doctor`; a throw from the cleanup itself reports `Workflow error:` with `cleanup failed; run /devflow:doctor`, and the run goes on with the next issue. `/devflow:doctor --fix` also removes the assignee of a stale in-progress issue, only when it is the authenticated user (#29).
- Engine: the run limit counts issues that were worked on. An issue skipped at Claim (already taken, or the claim race lost) does not count toward `limit`, so the next selected issue is worked on; a blocked issue, or a workflow error after Claim, still counts (#34).
- Engine: the Review loop exits on findings only. A `pass` verdict with a critical or warning finding starts a fix round, and a `changes` verdict with only suggestions ships. Any severity other than `suggestion` counts as blocking (fail closed) (#34).
- Init probes each connected GitHub MCP server by getting the authenticated user before generating the allow list: one answers, its tool prefix is used; several, it asks which; none (an auth error counts), it stops and tells the user to connect one. A different GitHub MCP prefix already allowed is replaced, shown in the diff. Doctor check 3 probes each server the same way, reports the prefix of the server it used and is `warn` only when `.claude/settings.json` allows another GitHub MCP prefix and no allowed prefix belongs to a server that answers (#36).
- Engine: Ship reuses an open PR for the branch. Step 0 looks for an open PR with head `<branch>`; if one exists it pushes, retargets the base when it differs, rewrites the body, adds the computed labels without removing any existing one (never `risk:high`) and opens no new PR. The ship schema gains `reused`, and the report notes `reused open PR #<n>`. Select no longer skips an issue whose only open PR is its own `devflow` PR (unless the issue is labelled `agent:review`) and returns `resumeBranch`, which the Branch stage resumes (#35).
- Engine: stages read the issue from GitHub themselves. The Plan, Integrate, Implement, QA, Fix, Verify and Review prompts no longer carry the Select copy of the issue body: each names issue `#<n>` in `<owner>/<repo>` and tells the agent to read it from GitHub as the source of truth; the Select copy is used only for parsing (Depends on, Test cases levels, spec path, Risk line, acceptance criteria count). With `ghCli` the Review stage runs on `devflow:reviewer` and reads the issue with `gh issue view <n> --repo <owner>/<repo> --json title,body,labels`; the review schema requires `issueRead`, and a reviewer that could not read the issue is re-run on the default agent (sticky for later rounds; a default agent that cannot read it blocks the issue at Review). Without `ghCli` the review runs on the default agent. `devflow-setup allow` adds `Bash(gh issue view:*)` and no broader `gh` rule. All seven stage schemas allow `problem`; an MCP-down `problem` stops the run as at Claim. Claim now returns `labels`, `specPath` and `introducedBy`, which decide risk, fix-issue detection, the e2e label and the spec path (differences are noted); Plan returns `httpOrE2eRows` (triggers Verify) and `acceptanceCriteria`, compared with the count in the Select copy (a mismatch or a missing count is noted, the run continues) (#33).

### Upgrade
- Copy-mode projects run `/devflow:init --upgrade` for the new merge gate script. The engine, sync, answer, init and doctor changes apply as soon as the plugin updates. A `v2.9.0` tag is published after this release is merged, for reusable-mode callers.

## [2.8.0] - 2026-11-11

Hardening release for the auto-merge path: the merge gate, the weakened-checks scan, the verification step and the guard all get stricter. No config change is required; every new config key is optional.

### Added
- Config key `scan.ignore`: globs the weakened-checks scan skips. `.claude/devflow.json` is never ignored.
- `tests/version.test.cjs`: the versions in `plugin.json`, `marketplace.json`, the init template, the README and DESIGN.md, the flows page and the changelog must agree.
- `/devflow:doctor` check 10, guard self-test: it runs the guard on a merge call and expects exit status 2, so a machine where the guard cannot run is reported instead of silently unprotected.
- Scan: new hits for `.github/scripts/**`, `.github/actions/**`, a `Makefile` at any depth when any simple command of a check runs `make`, `package.json` script and tool-config lines only (dependency changes are not hits), Go `t.Skip` in `_test.go`, JUnit `@Disabled` / `@Ignore`, Rust `#[ignore]`, `//nolint`, `# rubocop:disable`, pytest `collect_ignore` / `pytest_ignore_collect`, and hollow assertions (`assert True`, `expect(true).toBe(true)`) in test files. More test-file layouts are recognised.
- Guard: blocks MCP file writes (`push_files`, `create_or_update_file`, `delete_file`) to a protected or unnamed branch; `git commit --no-verify` / `-n` and `git push --no-verify`; `gh api` writes to a protected branch ref or to a commit status; removing the `risk:high` label with `gh pr edit` / `gh issue edit` (adding `risk:low` is allowed); `git add *`; `git checkout -f` and `git switch -f` / `--discard-changes`. `git clean -n` is allowed.

### Changed
- Merge gate: re-reads the PR's files on every run. A PR that touches `risk.highPaths` or the built-in `.github/**` / `.claude/**` is skipped and relabelled `risk:high` (dry run: `would skip`), before any update-branch, whatever its label says. A `devflow/review` commit status counts only when `github-actions[bot]` created it.
- Engine: a required verification that could not run (`ran: false`) raises the PR to `risk:high`, with the reason in the Risk line and in the notes.
- Scan: line patterns no longer run on prose files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `docs/**`).
- Guard: fails closed. An internal error, including unparsable input, blocks with exit 2 instead of disabling the guard.
- Upgrade: copy-mode projects run `/devflow:init --upgrade` for the new merge gate script. The guard, scan and engine changes apply as soon as the plugin updates. A `v2.8.0` tag is published with this release for reusable-mode callers.

## [2.7.0] - 2026-11-10

Minor release: every new config key is optional and existing configs stay valid. Behaviour is stricter (the guard blocks more git commands, accept gaps wait for triage, weakened checks raise risk), but no setup change is required.

### Added
- Plugin hooks: `hooks/formatter.py` (PostToolUse) runs the new `format` config key's per-glob formatters on each edited file, quietly; `hooks/session_start.py` (SessionStart) gives every session the workflow rules built from `.claude/devflow.json`, and is silent without one.
- The `devflow:reviewer` agent (`agents/reviewer.md`), used by the Review stage (`nextTask.reviewerAgent`) and for local reviews.
- Reusable workflows `devflow-review.yml` and `devflow-merge-gate.yml` (`on: workflow_call`) and thin caller templates pinned to a tag; `/devflow:init` chooses reusable or copy mode, `--upgrade` moves the tag.
- `bin/devflow-setup`: the allow list from `checks`, `verify`, `worktree.setup` and the remote; the minimal config (non-default keys only); the leftovers list for doctor.
- `/devflow:doctor` check 9: project files and rules the plugin now owns (`block_git_add_all.py` and its `hook-test` check, deny rules, a maintenance `loop.md`, a project `code-reviewer` agent), reported as removable and never deleted.
- Guard: blocks git commands that discard work (`reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, `stash drop|clear`, `filter-branch`, `update-ref -d`, `reflog expire`) and staging everything (`git add -A`, `--all`, `.`). `git add -u` is allowed. Replaces the per-project `block_git_add_all.py` hook.
- Engine: a deterministic weakened-checks scan of the diff before every review round, run by the shipped `bin/devflow-scan` script (new `noqa`, `type: ignore`, `eslint-disable`, `@ts-ignore`, skipped, focused or deleted tests, removed assertions, empty `except` / `catch`, edited check configuration). Hits are critical findings; hits the reviewer accepts as required by the issue make the PR `risk:high`.
- Review (engine and the `claude-code-review.yml` check): an out-of-scope item that leaves an acceptance criterion unmet is critical. Ship files the remaining real out-of-scope problems as follow-up issues labelled `needs-triage` and links them in the PR.

- Priority labels (`labels.priority`, default `priority:critical|high|normal|low`, no label = normal). `/devflow:next-task` orders by dependencies, then priority, then issue number, and a critical or high issue pulls its open parents forward. The merge gate tries candidates by the linked issue's priority, then PR number. No preemption, and priority never changes who merges.
- `labels.triage` (`needs-triage`): accept gaps and Ship's follow-up issues get it instead of ready, with a comment suggesting priority and risk; next-task and dispatch never pick such issues. Only a human sets ready.
- A shared bug issue template (`skills/spec/templates/bug.md`) and a "Filing a bug" section in the README.
- Fix PRs (bugs, gaps, `type:fix`) carry Root cause, Introduced by and Why it was missed.
- `/devflow:release` lists critical fixes first.

### Changed
- `/devflow:init` writes no deny rules (the guard covers them), generates the allow list, and writes only non-default keys to `devflow.json`.
- `/devflow:accept` no longer labels gaps ready or sets their risk label: a human triages them.
- `/devflow:doctor --fix` prints `git branch -D` for the user instead of running it (the guard blocks it).
- Upgrade: run `/devflow:init --upgrade` in each project for the new review prompt and gate script (or to switch to reusable mode), then `/devflow:doctor` to see which project files can go.

## [2.6.0] - 2026-11-04

### Added
- `/devflow:sync` can run unattended: `/loop 15m /devflow:sync --unattended` works in a temporary worktree that is always removed, asks nothing (threads needing a product decision are left unresolved and listed as "needs a human"), and stops with "nothing to sync" when there are no target PRs.

### Changed
- `/devflow:sync` no longer sets `disable-model-invocation`, because a scheduled `/loop` prompt can only run a skill through the Skill tool and that flag blocked it. Its description limits invocation to a user request or a `/loop` prompt naming it. Other skills are unchanged.

## [2.5.1] - 2026-11-03

### Fixed
- Merge gate: the `<!-- devflow-gate-merged -->` comment is posted right after the merge, before stacked PRs are retargeted and the head branch is deleted. A failure in either step (for example a 422 when GitHub already auto-deleted the branch) no longer loses the marker, which is the only gate marker for `rebase` merges.
- Upgrade: run `/devflow:init --upgrade` in each project to get the fixed gate script.

## [2.5.0] - 2026-11-03

### Added
- The merge gate marks what it merges: the merge commit message ends with `Merged-by: devflow merge gate` and the PR gets a comment starting with `<!-- devflow-gate-merged -->`.
- `/devflow:release all`: every merged devflow or `spec:` PR into the base branch. It is the proposed default when no tag exists yet, so the first release covers everything shipped.
- Release notes start with a "What's new" section written for clients, before the technical changelog.

### Changed
- `spec:` PRs go to Docs in the release notes, not Chores. The `since` form includes them too.
- `/devflow:release` and `/devflow:report` tell gate merges from human merges by the marker. An older PR merged by the gate token owner shows "merger unknown (gate or owner)".
- Upgrade: run `/devflow:init --upgrade` in each project to get the new gate script.

## [2.4.1] - 2026-11-03

### Fixed
- Merged state is read from `pull_request_read` `merged_at` or from git ancestry, never from list results, which report `merged: false` for merged PRs. Affects doctor, accept, report, release, sync and the engine's parent check.

### Changed
- Doctor warns about `devflowVersion` only for a major or minor difference.

## [2.4.0] - 2026-11-03 (wave 4)

### Added
- Engine regression tests (`tests/engine.test.cjs`).
- CI: the `test` workflow runs the Node and hook tests on every PR and on `main`.
- Versioning: `version` in `plugin.json` and `marketplace.json`, and this changelog.
- Report notes from the engine, used by `/devflow:report`.
- `verify.lock`: one session at a time runs Verify on a machine.
- Clear stop when the GitHub MCP is unavailable.
- Resume a blocked branch instead of starting over.
- Manual check results recorded in the PR.
- `dispatch.ignoreHotspots`: README and CHANGELOG hotspots no longer join lanes.
- `/devflow:init --upgrade` and the `devflowVersion` config key.
- `/devflow:doctor [--fix]`.
- `/devflow:accept`, with the `accept` config key.
- `/devflow:release`, with the `release` config key.
- `/devflow:report`.
- Push notifications, with the `notify` config key.

## [2.3.0] - wave 3

### Added
- Parallel QA: a QA agent writes the acceptance tests while the dev agent implements (`nextTask.parallelQa`).
- Merged questions: one comment per blocked issue.
- `/devflow:answer`.
- Flow map.

### Fixed
- QA and implement tests are named by the issue's pattern.

## [2.2.0] - wave 2

### Added
- Isolated worktrees, claim lock, posted plans and lane chaining in `/devflow:next-task`.
- `/devflow:dispatch`: plan lanes by shared hotspots and start one background session per lane.

### Fixed
- A lane keeps going when one of its issues does not ship.
- A parent PR merged while its child is built is handled.
- Workflow templates use `actions/checkout@v7` and `github-script@v9`.

## [2.1.0] - wave 1

### Added
- Risk levels per task and `risk:low|high` labels; the merge gate Action for low-risk PRs.
- Stacked PRs, including on several parents; a PR is held until every dependency of its issue is closed.
- `/devflow:sync` (replaces `/devflow:address-reviews`): retarget, update, conflicts and reviews.
- Review verdict read from a marker in the bot's summary comment; the review became a `devflow/review` status.
- Spec read rule: `next-task` reads the spec before implementing.

### Fixed
- The gate carries over only real review verdicts.

## [2.0.0] - test matrix

### Added
- QA step in `/devflow:spec` that drafts a test matrix from the acceptance criteria (`spec.testMatrix`, `spec.qaModel`).
- `next-task` requires a test for every `must` row.

## [1.0.0] - initial release

### Added
- `/devflow:spec`: idea to reviewed spec and GitHub issues.
- `/devflow:next-task`: implement ready issues test-first, check, verify, review, open PRs.
- `/devflow:init` and the guard hook.

## Release process

This section is the release task template: a release task (an issue, or a human working by hand) copies these steps
for version `X.Y.Z` and ticks them in the release PR. Claude never merges or tags.

1. Open a release branch from `main`. Bump `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
   and every other place `tests/version.test.cjs` checks.
2. Changelog: when `changelog.fragmentsDir` is set, run `node bin/devflow-changelog assemble --version X.Y.Z --date YYYY-MM-DD` and commit the result in the release PR; otherwise move the items under `[Unreleased]` to a new version heading in this file.
3. When the release changes a reusable workflow (`.github/workflows/devflow-review.yml` or `devflow-merge-gate.yml`), the upgrade note of the release tells callers of the reusable workflow to move their pin to the new tag.
4. Open the release PR.
5. Smoke run, with the release candidate, in the sandbox repository (`nhanle-agilityio/devflow-sandbox`):
   1. Load the plugin from the release branch with `claude --plugin-dir <checkout of the release branch>`.
   2. Create two issues from the fixtures: one with the body of `docs/smoke/low.md` (labels `risk:low` and the ready label) and one with the body of `docs/smoke/high.md` (labels `risk:high` and the ready label).
   3. Start both with `/devflow:dispatch` as two lanes (each lane runs `/devflow:next-task` on its issue).
   4. Run the checker for both: `node bin/devflow-smoke --repo nhanle-agilityio/devflow-sandbox --issue <low> --expect low` and `node bin/devflow-smoke --repo nhanle-agilityio/devflow-sandbox --issue <high> --expect high`.
   5. Record in the release PR: the number of conflicts, of "behind" updates and of `/devflow:sync` calls the two lanes needed, and the output of both checker runs.
6. Merge the release PR only when both checks pass (a human merges). A release with a docs or UI change also needs its manual rows checked by a human before the merge.
7. Tag `vX.Y.Z` on `main` right after the release PR merges (a human tags), so pinned callers and `/devflow:doctor` see the new version at once.
