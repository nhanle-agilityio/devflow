# Wave 1: reliability fixes from the 2.7.0 review

- **Status:** draft
- **Date:** 2026-11-11
- **Slug:** `wave1-reliability-fixes`

## Problem

The review of devflow 2.7.0 found six reliability problems that the 2.8.0 hardening release did not cover:

1. **Claim lifecycle.** The Claim stage treats any assignee as "already claimed". A blocked run removes `agent:in-progress` and its claim comment but leaves the assignee (only `/devflow:answer` removes it). So an issue blocked without questions, an issue returned to ready by `/devflow:doctor --fix`, or an issue a human self-assigned while triaging is skipped forever. When `runIssue` throws, the main loop reports "Workflow error" and runs no cleanup: the label, the assignee and the claim comment all stay.
2. **Merge gate update storm.** Every candidate that is behind its base gets `update-branch` in the same run, so after each merge all N remaining PRs re-run CI (about N² runs).
3. **Untrusted comments.** `/devflow:sync` acts on review threads from anyone; `/devflow:answer` takes answers from any human comment and writes them into the spec.
4. **Stale issue copy.** The Select stage (haiku) returns each issue body "verbatim" and every later stage uses that copy; a long body can be cut or altered.
5. **Reviewer bypass.** A review thread stops blocking the gate once its last comment is by the PR author, so a "won't fix" reply from `/devflow:sync` lets the gate merge without the reviewer agreeing.
6. **Small fixes.** The run limit counts issues skipped as already claimed; the review loop stops on `verdict: pass` even with a warning finding; `skills/answer/SKILL.md` says a branch with commits must be handled by hand although the engine resumes it; Ship is not idempotent; `/devflow:init` writes a GitHub MCP prefix without checking the server is connected and `/devflow:doctor` check 3 does not say which server it used.

## Goals

- An issue blocked, errored or reset by doctor can be picked up again by a later run; a human's triage self-assignment does not hide an issue.
- The merge gate triggers at most one branch update per run.
- Only trusted authors' comments change code, specs or merge decisions.
- Every stage works from the issue as it is on GitHub.
- A collaborator's review thread blocks the gate until it is resolved.
- The small fixes above behave as described in Decisions.
- Released as 2.9.0.

## Non-goals

- No new config key.
- No change to the reusable workflows' inputs or secrets.
- No change to how a claim race is decided (claim comments and `pickClaimWinner` stay as they are); only the loser's release also drops its own assignee (Decisions).
- Threads started by the devflow review bot (`claude[bot]`) keep today's gate rule (last comment by the PR author answers them).
- Threads the PR author starts on their own PR keep today's rule: the author's own reply answers them. In a single-maintainer repository the maintainer is usually the PR author, so a note they leave on their own PR can be answered by sync under the same login; that note is theirs to answer. The review bot's threads are not affected.
- The existing Claim failure paths (`The claim agent failed.`, `Our claim comment ... was not found`) keep today's blocked cleanup.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| When is an issue "taken" at Claim? | Only when it has an assignee other than the authenticated user, or the label `labels.inProgress`, `labels.blocked` or `labels.review`. An issue assigned only to the authenticated user with none of these labels is free. | Leftover self-assignments must not hide issues forever; an issue whose PR is in review must not be reworked. |
| Which assignee does cleanup remove? | Only the one this run added: the claim agent returns `assignedByRun` (true when it added the authenticated user, false when that user was already assigned). Blocked cleanup removes the authenticated user only when `assignedByRun` is true. | A human's own self-assignment from before the run is kept. |
| How does a thrown error get cleaned up? | `runIssue` wraps the stage work after a won claim in try/catch; a throw calls the normal blocked cleanup with stage `Error` and the message. If the cleanup itself throws, the report entry is `Workflow error:` with the note `cleanup failed; run /devflow:doctor`. A throw from the claim or release agent (claim not won) runs no cleanup; the entry is `Workflow error:` with the note `claim may be partial; run /devflow:doctor`. | The branch is known inside `runIssue`; cleanup never touches an issue this run does not own, and the user is told when a claim may be left behind. |
| `doctor --fix` for a stale claim | Besides the label swap and claim comment removal, removes the assignee only when it is the authenticated user. | Doctor cannot know which run assigned; other people's assignments are theirs. |
| Gate: which behind PR is updated? | Per run, only the first candidate in priority order that is behind and passes every earlier rule. Later behind candidates get action `deferred`, reason `deferred: waits for its turn`. In dry run the first gets `would update`, the rest `deferred` the same way. | Avoids N² CI runs. |
| Gate: can a PR merge in the same run as an update? | Yes. At most one update and one merge per run; an up-to-date green PR later in the queue still merges. | An update does not change other PRs. |
| Who is trusted for sync and answer? | Sync (review threads): the thread's first comment author is the authenticated user, `claude[bot]` (the author of the devflow review's comments and threads; `github-actions[bot]` only creates the `devflow/review` status), or a login returned by the MCP `list_repository_collaborators` tool. The MCP review-thread output carries no `author_association`, so the collaborator list is the source; a login not found there is untrusted. Answer (issue comments): the authenticated user, or `author_association` OWNER, MEMBER or COLLABORATOR, never a bot. Other comments are listed as `ignored: not a collaborator`. | Bots report as non-collaborators; sync must still act on devflow's own review, and the trust check must use data the tools actually return. |
| Gate: threads started by a non-collaborator human | Ignored (do not block), same trust rule as sync. | A stranger's comment must not stall the gate; sync ignores them too. |
| Gate: threads started by a trusted human other than the PR author | Block until resolved or outdated, whoever commented last. Threads started by `claude[bot]` keep today's rule. Threads started by any other bot (GraphQL author `__typename` `Bot`, e.g. Copilot, CodeRabbit) do not block: sync ignores them too, so one trust rule covers both. | The reviewer must agree; a "won't fix" reply is not agreement. |
| Which stages read the issue themselves? | All seven that embed it today: Plan, Integrate, Implement, QA, Fix, Verify, Review. They read the issue (body, labels; comments not needed) from GitHub and treat it as the source of truth. The `devflow:reviewer` agent has no MCP tools (Read, Grep, Glob, Bash), so its prompt says to run `gh issue view <n> --repo <owner>/<repo> --json title,body,labels`, and it returns `issueRead` (boolean). `bin/devflow-setup allow` adds the read-only rule `Bash(gh issue view:*)` so background sessions may run it. When `ghCli` is false, the round runs on the default agent (which has the GitHub MCP server) with the note `review ran on the default agent: gh is not installed`; when the reviewer returns `issueRead: false`, the engine re-runs that round on the default agent with the note `review ran on the default agent: the reviewer could not read the issue`, and every later round of that issue goes straight to the default agent (like `reviewerMissing`). When the default agent returns `issueRead: false`, the issue blocks at Review with the reason `the review could not read the issue`. `agents/reviewer.md` is not changed. | No stage should see a possibly altered copy, and Review must still work where `gh` is refused or missing. |
| Plan's acceptance-criteria count | Plan returns `acceptanceCriteria` (count of checklist items under the issue's Acceptance criteria heading it read). The engine counts the same in the Select copy; on mismatch it logs and adds a report note, never blocks. | The copy is only a hint; GitHub wins. |
| Run limit | An issue skipped at Claim (taken or claim lost) does not count toward the limit. | The limit is about work done. |
| Review loop exit | Exit only when no critical or warning finding remains (after injecting unaccepted scan hits). `verdict` is ignored for the decision. | A pass verdict with a warning finding is inconsistent; findings win. |
| Ship when a PR is already open | Ship first looks for an open PR with head = the branch. If one exists: push normally, rewrite its body from current data, add its labels (removing none), then continue with the issue labels; never open a second PR. Return the existing PR number and URL. | Re-running after a failed Ship must not block with a PR open. |
| Init: GitHub MCP prefix | Init probes each connected GitHub MCP server (get the authenticated user). One answers: use its prefix. Several answer: ask the user which. None: stop with a message to connect one. | The allow list must name a working server. |
| Doctor check 3 | Names the server (tool prefix) it used, and warns when `.claude/settings.json` allows a different GitHub MCP prefix and not this one. | Points straight at a broken allow list. |
| CHANGELOG | Each task adds its entry under `## [Unreleased]` (create the section if missing). The release task moves it to `2.9.0`. | Keep a Changelog. |
| Hotspots | Code files only. DESIGN.md, README.md and CHANGELOG.md are not hotspots (also not for T10); `/devflow:sync` resolves their conflicts. | Listing them would force every task into one lane. |
| Stale text in the answer skill | Fixed in T3 (which edits the same skill). | Same file. |
| Scope of the try/catch in `runIssue` | The try wraps the stage work after a won claim; a stage that blocks still returns `block(...)` from inside it. The per-issue flags live on the issue object: `issue.claimWon` (set before the try) and `issue.inCleanup` (set while `block()` runs); the catch rethrows when `issue.inCleanup` is set, so a normal block is never cleaned up twice, and otherwise calls `block('Error', message)`. A throw from the cleanup reaches the main loop, which reports `Workflow error:` plus `cleanup failed; run /devflow:doctor` when `issue.claimWon`, or `claim may be partial; run /devflow:doctor` when not. The notes collected so far are kept on the issue object and copied into that report entry. The `Error:` reason uses the first line of the message, as other reasons do. | One cleanup per issue, and the main loop can see what happened. |
| Claim edge cases | `assignedByRun` missing counts as false. A run that loses the claim race removes its authenticated user from the assignees only when `assignedByRun` is true and the winner's claim comment was posted by a different login; with the same login it touches no assignee. The claim agent returns each claim comment's author login. An issue assigned to the authenticated user and to another user is taken. The authenticated user is trusted even when it is a GitHub App. | Safe defaults; a loser's leftover assignee would otherwise hide the issue forever under the new taken rule. |
| What counts toward the run limit | Every issue worked past Claim, including `blocked` and `Workflow error` results. Only Claim skips (taken, claim lost) do not count. | Work was attempted. |
| Gate update slot | The slot is taken by the first candidate (priority label, then PR number, as today) that passes every earlier rule and either is behind (it is updated; its checks are not looked at, as today, since the update re-runs them) or is up to date and holds the slot under the check rule below, or has `mergeable: null` on a fresh head (see the age rule). Later behind candidates are deferred. `state.updated` is set before `updateBranch` is called. If `updateBranch` fails with a 5xx, or with a 422 after which a re-read of the PR shows a different `head.sha` (the head moved), the slot is used (action `error`, no retry in this run); a 422 with the head unchanged, and any other error (for example 403 or 404: a fork the token cannot push to, a missing workflows permission, a protected head) gives action `error` and frees the slot, so the next behind candidate is updated. | The head keeps its turn while its CI runs; a PR that can never be updated must not stop the queue. |
| Gate: unknown thread author | A first comment with no author (deleted user) or no association counts as untrusted: it does not block. A trusted human's thread blocks whoever authored the PR (also a bot PR). | Same trust rule everywhere. |
| Trusted content inside a thread | Sync acts only on the trusted comments of a trusted thread; untrusted replies are ignored. In answer, the latest trusted answer per question wins. | Untrusted text never reaches code or specs. |
| Acceptance criteria count | Top-level `- [ ]` and `- [x]` items under the first heading or bold line containing `Acceptance criteria`, up to the next heading or bold line; no heading counts as 0. Plan omitting the count or returning a non-integer gives the note `plan did not report the acceptance criteria count`. A stage that cannot read the issue follows the existing MCP-down rule; there is no fallback to the Select copy. The log line only needs both counts. | Deterministic and simple. |
| Review severities | A finding with a severity other than `suggestion` blocks (unknown severities included). A warning still open after `maxReviewRounds` blocks with today's reason. | Fail closed. |
| Ship: which open PR is reused | The open PR in the same repository whose head is the branch; if its base differs from the intended base, Ship retargets it. `prNumber` stays required in the schema. | One PR per branch. |
| Doctor check 3 edge cases | Both the used prefix and another one allowed: ok. No GitHub MCP prefix allowed: left to check 8. A server that fails the probe (for example an auth error) counts as not answering. | Check 8 already owns missing rules. |
| Docs criteria | Checked by keyword tests plus review. README is changed only where it already has a matching section. | Prose is judged in review. |
| Test files for docs and skill text | `tests/docs.test.cjs` (DESIGN.md, README.md, CHANGELOG keywords) and `tests/skills.test.cjs` (SKILL.md text) are new; whichever task lands first creates each, the others append their cases. Like the docs, these shared test files are not hotspots. | Append-only; sync resolves conflicts. |
| Changelog entries | Each entry cites its issue number `(#NN)`. | T10 can check all nine are present. |
| "Blocks at any stage" | Tested on a sample: Plan, Review and the `Error` stage of T2. | One code path for all stages. |
| Gate: check states and the slot hold | Each required check gets one state. **green**: its latest check run completed with conclusion `success`, or its latest commit status (from the review bot for `devflow/review`, as today) is `success`. Otherwise the latest check run decides when there is one, else the latest status. **failed**: a completed run with any other conclusion (`failure`, `cancelled`, `timed_out`, `skipped`, `neutral`, `action_required`, `stale`, `startup_failure` or anything unknown), or a status `failure` or `error`. **pending**: a run with status `queued`, `in_progress`, `waiting`, `requested` or `pending`, or a status `pending`. **missing**: no run and no status. The PR's state is the worst over all required checks: failed > pending > missing > green. An up-to-date candidate holds the slot only while its state is pending and the deciding check started less than 60 minutes ago (`PENDING_HOLD_MS`), or missing (or `mergeable: null`) and the head is less than 15 minutes old (`MISSING_HOLD_MS`). Both are constants in the gate script, not config keys. Otherwise (failed, or a hold past its limit) the PR is skipped with the deciding check's reason and the slot passes on. After a merge, no update happens in that run (`deferred: one merge per run`, as today). | Every hold is bounded: an approval that never comes, a check that never starts or a stuck run cannot stop updates for longer than the limit. 15 minutes covers the gap between a push or `update-branch` and the first check appearing. |
| Gate: bot logins | Logins are compared after stripping a `[bot]` suffix (REST and GraphQL spell bots differently). A thread with no comments does not block. | Bot PRs must match their own replies. |
| Throw during parallel QA and Implement | The engine runs them with the workflow `parallel()` helper; each thunk catches its own error, so `parallel()` waits for both, and the first caught error is then handled as a throw. Cleanup therefore runs after both agents have finished. A non-Error throw or an empty message gives the reason `Error: unknown`. | No agent may still be committing while cleanup runs. |
| Counting syntax | Heading match is case-insensitive; `- [ ]`, `- [x]` and `- [X]` count; `*` and `+` bullets and numbered items do not. When Plan blocks, the count is still compared and the note added. | Matches the issue template. |
| Labels on a reused PR | Ship adds the computed labels and never removes `risk:high` or any label already on the PR. | A human's label wins. |
| Re-running init with a stale prefix | The stale GitHub MCP prefix in the allow list is replaced, shown in the diff before writing. | As init does today. |
| Release changelog | No empty `[Unreleased]` section is left after the release; the date is the day the release PR is opened. T10.2 and T10.3 are checked once on the release branch, not kept in the suite; tagging after the human merge (T10.6) is a manual check. | A permanent "no [Unreleased]" test would fail on the next feature PR. |
| Gate: hold ages | Pending age: now minus the deciding check run's `started_at` (its `created_at` when it has not started), or the pending status's `created_at`. Head age (missing, `mergeable: null`): now minus the later of the head commit's committer date (`repos.getCommit` on `pr.head.sha`) and the PR's `created_at`, so a PR opened long after its last commit still gets the full window. A date later than now is ignored; when no usable date is left, the candidate does not hold the slot. | Committer dates are set on the committer's machine and an engine commit can be old when Ship first pushes it; a future date must not make a hold unbounded. |
| Stages that cannot read the issue | Every stage that reads the issue (the seven above) gets `MCP_NOTE` in its prompt (today `fixPrompt`, `verifyPrompt` and `reviewPrompt` lack it) and an optional `problem` string in its schema. After each such stage the engine calls `mcpDown(problem)`; when true it stops the run exactly as at Claim (no cleanup, remaining issues skipped). | The MCP-down rule must reach every stage that now depends on GitHub. |
| Risk and verify inputs | Claim (which already reads the issue) returns the issue's `labels`, `specPath` (the first `<specDir>/<name>.md` in the body, '' when none) and `introducedBy` (the body has a `## Introduced by` heading); the engine uses them, not the Select copy, for the risk level, the spec path, `isFixIssue` and the e2e label. When labels or spec path differ from the Select copy, the report notes contain `labels differ from the selection: <claim labels>` or `spec path differs from the selection: <claim path>`. Plan returns `httpOrE2eRows` (boolean: the issue's Test cases table has a row with Level `http` or `e2e`); Verify runs when Plan or the Select copy says so. The Risk line's reason text still comes from the Select copy (text only, it never lowers risk). | The safety-relevant inputs come from GitHub; any doubt errs toward running Verify. |
| Ship reuse is reachable | Select no longer skips an issue whose only open PR is labelled `labels.devflow` and has the line `Closes #<n>` for it, as long as the issue does not carry `labels.review`. Select returns that PR's head branch as `resumeBranch`; the Branch stage then resumes exactly that branch (it does not derive a name from `branchPattern`), and Ship reuses the PR. Any other open PR referencing the issue, or an issue in review, still skips it. | Branch names come from an agent-picked slug and are not reproducible; the `Closes` line is. An issue in review must not be reworked. |
| Sync and branch updates | `/devflow:sync` step 2 skips the update of a PR that is only behind only when the gate will update it itself: `mergeGate.enabled` is true, `mergeGate.dryRun` is false, and the PR is labelled `labels.devflow` and `labels.riskLow`, targets `baseBranch` (not stacked) and is not labelled `labels.blocked`. Every other behind PR is updated as before. Sync still retargets stacked PRs and resolves conflicts, and never resolves a review thread it did not start. | The gate updates one PR at a time only for the PRs it can merge; dry-run projects and high-risk, stacked or blocked PRs would otherwise never be updated. |
| Trusted questions comment | `/devflow:answer` step 1 takes the latest `<!-- devflow-questions -->` comment only when its author is the authenticated user or a trusted author (as for answers); others are ignored. | A forged questions comment must not put untrusted text into the spec. |
| Review bot match | The gate treats a thread as started by the review bot only when the first comment's author has `__typename` `Bot` and login `claude`. | A human account named `claude` is not the review bot. |
| Gate wake-up for expired holds | The merge gate caller template (`skills/init/templates/github/callers/devflow-merge-gate.yml`) and the copy-mode workflow template (`skills/init/templates/github/workflows/devflow-merge-gate.yml`) gain `schedule: - cron: '23 * * * *'` (hourly) next to their existing triggers. A scheduled run has no `inputs.pr`, so it evaluates every candidate, like a `workflow_run` run. The reusable workflow (`.github/workflows/devflow-merge-gate.yml`) keeps its `workflow_call` inputs and secrets unchanged. Projects get the trigger with `/devflow:init --upgrade`; this repository's own caller is upgraded the same way after the release. | A hold that expires must be acted on without waiting for an unrelated event. Hourly costs about 24 short jobs a day (about 720 billed minutes a month at the one-minute minimum, also when `mergeGate.enabled` is false); every 15 minutes would cost about 2,900, more than GitHub Free's 2,000 private-repo minutes. The bound is about an hour plus GitHub's scheduling delay. |
| Where docs tests look in the changelog | `tests/docs.test.cjs` finds each task's entry by its issue number `(#NN)` anywhere in CHANGELOG.md, under `[Unreleased]` or any version heading, so the tests keep passing through T10 and after the next `[Unreleased]` section is added. | Section headings move; the issue number does not. |

## Design

### Other areas

**Engine (`workflows/next-task-engine.js`).**

- `CLAIM_SCHEMA` gains `assignedByRun: boolean`. `claimPrompt` step 1 uses the new taken rule; step 2 adds the authenticated user only when not already assigned and reports `assignedByRun`.
- Each entry of `claims` in `CLAIM_SCHEMA` gains `author` (login). The engine decides `removeAssignee = assignedByRun && winner.author !== ours.author` (ours = the claim with this run's `claimId`; a missing author counts as equal, so nothing is removed) and passes it to `releasePrompt(issue, removeAssignee)`, which then tells the agent to remove the authenticated user from the assignees. `pickClaimWinner` is unchanged.
- `blockedPrompt(…, assignedByRun)` step 4 also removes the authenticated user from the assignees when `assignedByRun` is true.
- `runIssue` keeps `assignedByRun` and `labels` from the claim; the stage work after a won claim is wrapped in try/catch → `block('Error', message)`.
- `CLAIM_SCHEMA` gains `labels` (string array, as read), `specPath` and `introducedBy`; `PLAN_SCHEMA` gains `httpOrE2eRows` (boolean). Risk, `isFixIssue` and the e2e label use the claim's labels (Decisions).
- The seven stage prompts include `MCP_NOTE`; their schemas gain an optional `problem`; the engine checks `mcpDown(problem)` after each.
- `selectPrompt`: the open-PR skip rule excepts a devflow PR on the issue's own branch (Decisions).
- Main loop: `worked++` is undone for results with status `skipped` that come from Claim. If `runIssue` throws, the report keeps "Workflow error" and adds the note `cleanup failed; run /devflow:doctor` when the claim was won, or `claim may be partial; run /devflow:doctor` when it was not (`runIssue` marks the claim as won before the try).
- `issueBlock(issue)` is replaced in the seven stage prompts by an instruction to read issue `#n` in `owner/repo` with the GitHub MCP server and use it as the source of truth (number and title stay inline for context). `PLAN_SCHEMA` gains `acceptanceCriteria: integer`. Review: `gh issue view` with `issueRead` in `REVIEW_SCHEMA`; the default agent instead of `nt.reviewerAgent` when `ghCli` is false or `issueRead` is false (Decisions).

**Setup (`bin/devflow-setup`).** `allow` adds `Bash(gh issue view:*)` to the generated rules.
- Review loop: `if (blocking.length === 0) break`.
- `shipPrompt` gains step 0: look for an open PR with head `<branch>`; if found, reuse it as described in Decisions. `SHIP_SCHEMA` gains `reused: boolean`; the engine adds the note `reused open PR #<n>` when true.

**Merge gate (`skills/init/templates/github/scripts/devflow-merge-gate.cjs`).**

- `state.updated` (boolean). In the behind branch of `evaluate`: if `state.updated`, return `{action: 'deferred', reason: 'deferred: waits for its turn'}`; otherwise set `state.updated = true`, then update (or not, in dry run). On an `updateBranch` error the gate re-reads the PR for a 422; a 5xx, or a 422 with a changed `head.sha`, keeps `state.updated`; any other error resets it to false. The action is `error` either way.
- `mergeable: null` on a head younger than `MISSING_HOLD_MS` sets `state.updated = true` (action stays `skipped`, reason `mergeability not computed yet`).
- `checksGreen` maps every required check to green, failed, pending or missing as the Decisions table says. It evaluates all of them (no early return) and returns `{ok, state, reason}`: the worst state (failed > pending > missing > green) and the reason of the check that decided it (`waiting for <name>: <run conclusion, run status or status state, or missing>`, as today).
- `checksGreen` also returns, for a pending state, the deciding run's `started_at` (or `created_at`) or the pending status's `created_at`. For an up-to-date candidate whose state is pending or missing, `evaluate` computes the age as the Decisions table says and holds the slot (`state.updated = true`) when it is under `PENDING_HOLD_MS` (60 min) for pending or `MISSING_HOLD_MS` (15 min) for missing. The action stays `skipped` with the check reason, as today. The gate may use the clock; the engine still does not.
- `unresolvedThreads` queries the first comment's `author { login __typename }` and `authorAssociation` plus the last comment's author. A thread blocks when not resolved or outdated and:
  - started by the review bot (`__typename` `Bot` and login `claude`): last comment is not by the PR author (today's rule);
  - started by any other `Bot`: never blocks;
  - started by the PR author: today's rule;
  - started by another user with association OWNER, MEMBER or COLLABORATOR: always blocks;
  - started by another user with any other association: never blocks.
- The gate reason stays `<n> unanswered review threads`.
- Both merge gate trigger templates gain an hourly `schedule` (Decisions); `gate()` already treats a run without `inputs.pr` as "evaluate every candidate", so the script needs no change for it.

**Skills.**

- `skills/sync/SKILL.md` step 2: skip the update of a behind-only PR only when the gate will update it (Decisions). Step 4: use a review summary comment only from `claude[bot]` or the authenticated user. Step 4: keep only threads whose first comment's author is trusted (Decisions: authenticated user, `claude[bot]`, or a login from `list_repository_collaborators`); list the rest in the final table as `ignored: not a collaborator`; never resolve a thread it did not start. Update the sentence about how the gate treats author replies.
- `skills/answer/SKILL.md` step 1: only a questions comment by the authenticated user or a trusted author. Step 2.2: only comments by trusted humans; list ignored ones. Step 6: say that a branch with commits from an earlier blocked run is resumed by the engine.
- `skills/doctor/SKILL.md` check 6 `--fix` (assignee) and check 3 (server name, allow-list mismatch warn).
- `skills/init/SKILL.md` background-sessions paragraph: probe connected servers before generating the allow list.

**Docs.** DESIGN.md sections for the engine, sync, answer, doctor, init and "Risk and the merge gate"; README.md where user-visible; CHANGELOG `[Unreleased]`.

## Risks and unknowns

- T4 and T5 change the gate every reusable-mode project runs at the next tag: released as a minor (2.9.0), never moved into an existing tag.
- `author_association` for a user who is a member of a private org may read `CONTRIBUTOR` when membership is private; such a user's threads are ignored by sync and the gate. Mitigation: documented in DESIGN.md; the owner can make membership public or add them as collaborator.
- Reading the issue in seven stages adds MCP calls per issue; acceptable for correctness.
- A CI run longer than 60 minutes lets the gate update the next PR while it still runs (two CI runs at once). Documented in DESIGN.md; the limit is a constant that can be raised in a later release.
- The collaborator list from `list_repository_collaborators` and the gate's `authorAssociation` can disagree for an org member without collaborator status; such a member's thread blocks the gate but is ignored by sync until they are added as a collaborator. Documented in DESIGN.md.
- An expired hold is acted on at the next gate run; the hourly schedule bounds that wait to about an hour plus GitHub's scheduling delay. The schedule costs about 720 billed Actions minutes a month per project (also with the gate disabled); DESIGN.md and README say so. Until a project runs `/devflow:init --upgrade`, its caller has no schedule and an expired hold waits for the next gate event (`workflow_dispatch` is the manual way out); DESIGN.md says so.
- QA: two rounds; every question they raised is settled in Decisions. The spec PR review raised 3 warnings (gate slot with a missing check, claim race assignee, T10 vs docs tests) and the review bot's identity; a second review raised the gap right after an update (missing checks now hold the slot for 15 minutes), a third the worst-state rule in `checksGreen` and one bot rule for sync and the gate, and a fourth the mapping of check states. A full self-review and a no-context review then settled the check-state mapping with bounded holds, how Review reads the issue (the reviewer agent has no MCP tools), T3's risk level, the release-step and parallel-stage details, background-session permissions for `gh issue view`, MCP-down handling in every stage, risk inputs from Claim, reachable Ship reuse, bounded and correctly timed holds, permanent update errors, sync's trust source and update rule, forged questions comments, and T9's risk. All are settled in Decisions. Nothing is open.

## Tasks

| Id | Title | Type | Area | Depends on | Size | Needs e2e | Risk | Risk reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Claim treats only others' assignees as taken and cleanup removes its own assignee | fix | backend | - | M | no | low | engine prompt and schema change, no highPaths file |
| T2 | Clean up the claim when a run throws, and doctor removes a stale assignee | fix | backend | T1 | S | no | low | engine and doctor skill, no highPaths file |
| T3 | Sync and answer act only on trusted authors' comments | fix | docs | - | S | no | high | security-sensitive input handling (risk.highWhen): changes whose comments sync and answer act on |
| T4 | Merge gate updates only the head of the queue | fix | infra | - | S | no | high | touches skills/init/templates/github/** (highPaths) |
| T5 | Merge gate blocks on unresolved collaborator threads | fix | infra | - | S | no | high | touches skills/init/templates/github/** (highPaths) |
| T6 | Stages read the issue from GitHub themselves | fix | backend | - | M | no | high | changes the generated permission allow list (`bin/devflow-setup`; risk.highWhen: authentication or permissions) |
| T7 | Run limit counts worked issues and review exits on findings only | fix | backend | - | S | no | low | engine logic, no highPaths file |
| T8 | Ship reuses an open PR for the branch | fix | backend | - | S | no | low | engine prompt and schema change, no highPaths file |
| T9 | Init and doctor check the connected GitHub MCP server | fix | docs | - | S | no | high | changes how init writes the permission allow list (risk.highWhen: authentication or permissions) |
| T10 | Release 2.9.0 | chore | docs | T1, T2, T3, T4, T5, T6, T7, T8, T9 | S | no | high | release: moves the reusable workflows' tag for every project; human merges |

### T1: Claim treats only others' assignees as taken and cleanup removes its own assignee

- **Type:** fix
- **Area:** backend
- **Depends on:** none
- **Size:** M
- **Needs e2e:** no
- **Risk:** low - engine prompt and schema change, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs

**Acceptance criteria**

- [ ] The claim prompt says an issue is taken only when it has an assignee other than the authenticated user, or the label `labels.inProgress`, `labels.blocked` or `labels.review`; an issue assigned only to the authenticated user with none of these labels is claimed.
- [ ] The claim prompt adds the authenticated user only when not already assigned, and the claim schema requires `assignedByRun` (boolean) and, for each claim item, `author`.
- [ ] When the claim returns `assignedByRun: true` and the run blocks at any stage, the blocked cleanup prompt tells the agent to remove the authenticated user from the assignees.
- [ ] When the claim returns `assignedByRun: false` and the run blocks, the blocked cleanup prompt does not tell the agent to remove any assignee.
- [ ] Each claim returned by the claim agent carries `author` (login). When the run loses the claim race with `assignedByRun: true` and the winning claim's author differs from the loser's own claim author, the release prompt tells the agent to remove the authenticated user from the assignees; when the authors are the same login, or `assignedByRun` is false, the release prompt does not touch any assignee.
- [ ] DESIGN.md (engine Claim and blocked cleanup), README.md where it describes claims, and the CHANGELOG describe the new rule.

**Scope** (files and areas this task may touch)

- workflows/next-task-engine.js (claimPrompt, CLAIM_SCHEMA, releasePrompt, blockedPrompt, runIssue claim and block handling)
- tests/engine.test.cjs, tests/docs.test.cjs
- DESIGN.md, README.md, CHANGELOG.md

**Test plan**

- Test cases: T1.1-T1.11 (see Test matrix). Engine tests with stub agents: inspect the claim prompt text and schema, and the blocked prompt with `assignedByRun` true and false.

### T2: Clean up the claim when a run throws, and doctor removes a stale assignee

- **Type:** fix
- **Area:** backend
- **Depends on:** T1
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - engine and doctor skill, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs, skills/doctor/SKILL.md

**Acceptance criteria**

- [ ] When a stage agent throws after the claim was won, the engine runs the blocked cleanup agent with stage `Error` and the error message, and the report entry has status `blocked` with reason starting `Error:`.
- [ ] The cleanup for a throw removes the assignee under the same `assignedByRun` rule as T1.
- [ ] When the claim agent or the release agent throws (claim not won), no blocked cleanup agent runs, the report entry is `blocked` with reason starting `Workflow error:`, and its notes contain `claim may be partial; run /devflow:doctor`.
- [ ] When the blocked cleanup agent itself throws (after a stage threw, or after a normal block), the cleanup is not attempted a second time, the report entry is `blocked` with reason starting `Workflow error:` and its notes contain `cleanup failed; run /devflow:doctor`, and the run continues with the next issue.
- [ ] `skills/doctor/SKILL.md` check 6 `--fix` removes the assignee of a stale in-progress issue only when it is the authenticated user.
- [ ] DESIGN.md (engine, doctor) and the CHANGELOG describe both.

**Scope**

- workflows/next-task-engine.js (runIssue, main loop)
- tests/engine.test.cjs
- skills/doctor/SKILL.md, tests/skills.test.cjs
- DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T2.1-T2.15 (see Test matrix). Engine tests: a stub stage that throws after claim, a claim stub that throws, and a blocked stub that throws.

### T3: Sync and answer act only on trusted authors' comments

- **Type:** fix
- **Area:** docs
- **Depends on:** none
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - security-sensitive input handling (risk.highWhen): changes whose comments sync and answer act on
- **Hotspot files:** skills/answer/SKILL.md, skills/sync/SKILL.md

**Acceptance criteria**

- [ ] `skills/sync/SKILL.md` step 4 handles only threads whose first comment's author is the authenticated user, `claude[bot]` (the devflow review bot), or a login returned by `list_repository_collaborators`; a login not in that list is untrusted. Every other thread is listed in the final table as `ignored: not a collaborator` and gets no reply or commit.
- [ ] `skills/sync/SKILL.md` acts only on the trusted comments of a trusted thread and never resolves a review thread it did not start.
- [ ] `skills/sync/SKILL.md` step 4 uses a review summary comment only when its author is `claude[bot]` or the authenticated user; any other summary-like comment (including one with a `<!-- devflow-verdict` marker) is listed as `ignored: not a collaborator` and never acted on.
- [ ] `skills/sync/SKILL.md` no longer says the gate ignores threads whose last comment is by the PR author for human threads; it says a trusted human's thread blocks the gate until the human resolves it.
- [ ] `skills/sync/SKILL.md` step 2 skips the update of a PR that is only behind exactly when `mergeGate.enabled` is true, `mergeGate.dryRun` is false, and the PR is labelled devflow and `risk:low`, targets `baseBranch` and is not labelled blocked; every other behind PR (gate off, dry run, `risk:high`, stacked, blocked) is updated as before. Retargets and conflict resolution still run.
- [ ] `skills/answer/SKILL.md` step 1 uses a `<!-- devflow-questions -->` comment only when its author is the authenticated user or has `author_association` OWNER, MEMBER or COLLABORATOR.
- [ ] `skills/answer/SKILL.md` step 2.2 takes answers only from comments by the authenticated user or authors with `author_association` OWNER, MEMBER or COLLABORATOR, never bots; the latest trusted answer per question wins; ignored comments are listed as `ignored: not a collaborator` in the report.
- [ ] `skills/answer/SKILL.md` step 6 says a branch with commits from an earlier blocked run is resumed by the engine (no manual handling).
- [ ] DESIGN.md (sync, answer) and the CHANGELOG describe the trust rule.

**Scope**

- skills/sync/SKILL.md, skills/answer/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T3.1-T3.11 (see Test matrix). Node text test over the two SKILL.md files.

### T4: Merge gate updates only the head of the queue

- **Type:** fix
- **Area:** infra
- **Depends on:** none
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - touches skills/init/templates/github/** (highPaths)
- **Hotspot files:** skills/init/templates/github/scripts/devflow-merge-gate.cjs, tests/merge-gate.test.cjs, skills/init/templates/github/callers/devflow-merge-gate.yml, skills/init/templates/github/workflows/devflow-merge-gate.yml

**Acceptance criteria**

- [ ] With three eligible candidates all behind their base, one run calls `updateBranch` once, for the first in priority order (priority label, then PR number) (action `updated`); the other two get action `deferred`, reason `deferred: waits for its turn`.
- [ ] A candidate that is behind but skipped by an earlier rule (draft, risk, blocked, stacked, open dependency, high-risk file, conflict) does not take the update slot: the next eligible behind candidate is updated.
- [ ] When the first eligible candidate is up to date and a required check is pending (run status `queued`, `in_progress`, `waiting`, `requested` or `pending`, or status `pending`) and started less than 60 minutes ago, it holds the slot: a later behind candidate is `deferred` with reason `deferred: waits for its turn` and `updateBranch` is not called.
- [ ] When that pending check started 60 minutes ago or more, the candidate is skipped with the pending check's reason and does not hold the slot: the next behind candidate is `updated`.
- [ ] When the first eligible candidate is up to date, a required check has no run and no status, and the head age (later of head commit committer date and PR `created_at`) is under 15 minutes, it holds the slot; at 15 minutes or more it is skipped with reason `waiting for <name>: missing` and the next behind candidate is `updated`.
- [ ] A date later than now is ignored for the age; with no usable date left, the candidate does not hold the slot.
- [ ] A candidate with `mergeable: null` holds the slot while the head age is under 15 minutes, and is skipped without holding it at 15 minutes or more.
- [ ] Every required check is evaluated and the worst state wins (failed > pending > missing > green): with one check pending and another failed, in either order, the candidate is skipped with the failed check's reason and does not hold the slot.
- [ ] A completed check run with conclusion `cancelled`, `skipped`, `neutral` or `timed_out`, and a commit status `error`, count as failed: the candidate does not hold the slot.
- [ ] When `updateBranch` fails with a 5xx, or a 422 after which the PR's `head.sha` changed, for the first behind candidate, its action is `error` and later behind candidates are still `deferred`; with a 422 and an unchanged head, or any other error (for example 403), its action is `error` and the next behind candidate is `updated`.
- [ ] After one candidate is updated, a later candidate that is up to date with green checks and no blocking thread still merges in the same run.
- [ ] In dry run, the first behind candidate gets `would update`, later behind ones `deferred` with the same reason, and `updateBranch` is never called.
- [ ] The merge gate caller template and the copy-mode merge gate workflow template both have a `schedule` trigger with cron `23 * * * *` (hourly) in addition to their existing `workflow_run`, `status` and `workflow_dispatch` triggers; the reusable workflow's `workflow_call` inputs and secrets are unchanged. A run without `inputs.pr` evaluates every candidate.
- [ ] DESIGN.md (Risk and the merge gate), README.md where it lists gate actions, and the CHANGELOG describe it, including the hold limits, the hourly scheduled run and its Actions cost, and that projects get it with `/devflow:init --upgrade`.

**Scope**

- skills/init/templates/github/scripts/devflow-merge-gate.cjs (evaluate, checksGreen, gate state)
- skills/init/templates/github/callers/devflow-merge-gate.yml, skills/init/templates/github/workflows/devflow-merge-gate.yml (add the `schedule` trigger only)
- tests/merge-gate.test.cjs, tests/reusable.test.cjs, tests/docs.test.cjs
- DESIGN.md, README.md, CHANGELOG.md

**Test plan**

- Test cases: T4.1-T4.24 (see Test matrix). Gate tests with the existing stub `github` object.

### T5: Merge gate blocks on unresolved collaborator threads

- **Type:** fix
- **Area:** infra
- **Depends on:** none
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - touches skills/init/templates/github/** (highPaths)
- **Hotspot files:** skills/init/templates/github/scripts/devflow-merge-gate.cjs, tests/merge-gate.test.cjs

**Acceptance criteria**

- [ ] An unresolved, not outdated thread started by a user (not the PR author) with association OWNER, MEMBER or COLLABORATOR blocks the merge even when its last comment is by the PR author (reason `1 unanswered review threads`).
- [ ] The same thread once resolved, or outdated, does not block.
- [ ] An unresolved thread started by a user with any other association (for example CONTRIBUTOR or NONE) does not block.
- [ ] An unresolved thread whose first comment has no author (deleted user) or no association does not block.
- [ ] When the PR author is a bot, an unresolved thread started by a trusted human blocks.
- [ ] An unresolved thread started by the review bot (`__typename` `Bot` and login `claude`) blocks when its last comment is not by the PR author and does not block when it is (today's rule).
- [ ] An unresolved thread whose first author has login `claude` but `__typename` `User` is judged as a human by its association, not as the review bot.
- [ ] An unresolved thread started by any other bot (for example `copilot-pull-request-reviewer`, `coderabbitai`) does not block, whoever commented last.
- [ ] An unresolved thread started by the PR author blocks only when its last comment is not by the PR author (today's rule).
- [ ] DESIGN.md (Risk and the merge gate), README.md and the CHANGELOG describe the rule.

**Scope**

- skills/init/templates/github/scripts/devflow-merge-gate.cjs (unresolvedThreads query and filter)
- tests/merge-gate.test.cjs, tests/docs.test.cjs
- DESIGN.md, README.md, CHANGELOG.md

**Test plan**

- Test cases: T5.1-T5.14 (see Test matrix). Gate tests feeding GraphQL thread nodes through the stub.

### T6: Stages read the issue from GitHub themselves

- **Type:** fix
- **Area:** backend
- **Depends on:** none
- **Size:** M
- **Needs e2e:** no
- **Risk:** high - changes the generated permission allow list (`bin/devflow-setup`; risk.highWhen: authentication or permissions)
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs, bin/devflow-setup

**Acceptance criteria**

- [ ] The Plan, Integrate, Implement, QA, Fix, Verify and Review prompts no longer contain the Select copy of the issue body; each tells the agent to read issue `#<n>` in `<owner>/<repo>` from GitHub and to treat it as the source of truth.
- [ ] With `ghCli` true, the Review stage runs on `nextTask.reviewerAgent`, its prompt tells it to read the issue with `gh issue view <n> --repo <owner>/<repo> --json title,body,labels`, and the review schema requires `issueRead` (boolean). With `ghCli` false, the round runs on the default agent (no `agentType`), its prompt tells it to read the issue with the GitHub MCP server, and the notes contain `review ran on the default agent: gh is not installed`.
- [ ] When the reviewer returns `issueRead: false`, the engine re-runs that review round on the default agent and uses that result; the notes contain `review ran on the default agent: the reviewer could not read the issue`; later rounds go straight to the default agent. When the default agent returns `issueRead: false`, the issue blocks at Review with reason `Review: the review could not read the issue`.
- [ ] `node bin/devflow-setup allow` output contains `Bash(gh issue view:*)` and no broader `gh` rule.
- [ ] The Plan, Integrate, Implement, QA, Fix, Verify and Review prompts contain the MCP note, and their schemas allow `problem`; when a stage returns a `problem` that `mcpDown` recognises, the run stops as at Claim (no blocked cleanup, remaining issues skipped).
- [ ] The claim schema requires `labels`, `specPath` and `introducedBy`; risk, the spec path in every stage prompt, fix-issue detection and the e2e label use the claim's values. When labels differ from the Select copy's, the notes contain `labels differ from the selection: <labels>`; when the spec path differs, `spec path differs from the selection: <path>`.
- [ ] The plan schema requires `httpOrE2eRows` (boolean); Verify runs when it is true even if the Select copy has no such row.
- [ ] The Select prompt still asks for the full body; the engine still takes the spec path, Depends on lines, Test cases levels and the Risk line from it.
- [ ] The plan schema requires `acceptanceCriteria` (integer). The engine counts top-level `- [ ]` and `- [x]` items under the first heading or bold line containing `Acceptance criteria` in the Select copy, up to the next heading or bold line (0 when there is no such heading). When the counts differ, the engine logs it and the report notes contain `acceptance criteria: plan read <a>, selection had <b>`; the run continues.
- [ ] When the counts match, no such note is added.
- [ ] When the plan result omits `acceptanceCriteria` or it is not an integer, the report notes contain `plan did not report the acceptance criteria count` and the run continues.
- [ ] DESIGN.md (engine stages) and the CHANGELOG describe it.

**Scope**

- workflows/next-task-engine.js (issueBlock and the seven prompts, MCP_NOTE use, stage schemas, CLAIM_SCHEMA labels, PLAN_SCHEMA, REVIEW_SCHEMA, risk and verify inputs, runIssue Plan and Review handling)
- bin/devflow-setup (`allow`: `Bash(gh issue view:*)`), tests/setup.test.cjs
- tests/engine.test.cjs, tests/docs.test.cjs
- DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T6.1-T6.21 (see Test matrix). Engine tests: a Select body with a unique marker string that must not appear in any of the seven prompts; plan stubs returning a matching and a different count.

### T7: Run limit counts worked issues and review exits on findings only

- **Type:** fix
- **Area:** backend
- **Depends on:** none
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - engine logic, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs

**Acceptance criteria**

- [ ] With limit 1 and two selected issues where the first is already taken at Claim, the second is worked on (reaches Ship).
- [ ] With limit 1 and two selected issues where the first loses the claim race, the second is worked on.
- [ ] With limit 1 and two selected issues where the first blocks after Claim, the second is skipped with reason `over limit (1)`.
- [ ] A review returning `verdict: pass` with one warning finding starts a fix round; the issue ships only after a review with no critical or warning finding.
- [ ] A review returning `verdict: changes` with only suggestion findings ends the review loop and ships.
- [ ] A finding with a severity other than `critical`, `warning` or `suggestion` counts as blocking.
- [ ] DESIGN.md (engine) and the CHANGELOG describe both.

**Scope**

- workflows/next-task-engine.js (main loop, review loop)
- tests/engine.test.cjs, tests/docs.test.cjs
- DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T7.1-T7.11 (see Test matrix). Engine tests with stub claim and review results.

### T8: Ship reuses an open PR for the branch

- **Type:** fix
- **Area:** backend
- **Depends on:** none
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - engine prompt and schema change, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs

**Acceptance criteria**

- [ ] The ship prompt's first step tells the agent to look for an open PR with head `<branch>` in `<owner>/<repo>` and, when one exists, to push normally, retarget its base when it differs from the intended base, rewrite its body from the data, add the computed labels without removing any label already on it (never `risk:high`), not open a new PR, and continue with the issue labels.
- [ ] The Select prompt does not skip an issue whose only open PR is labelled `labels.devflow` and contains `Closes #<n>` for it, unless the issue carries `labels.review`; it returns that PR's head branch as `resumeBranch`. Any other open PR referencing the issue still skips it.
- [ ] When an issue has `resumeBranch`, the Branch prompt tells the agent to resume exactly that branch (fetch it from the remote when it is only there) instead of building a name from `branchPattern`.
- [ ] The ship schema has `reused` (boolean). When the ship stub returns `reused: true`, the report entry has status `pr` with that PR number and its notes contain `reused open PR #<n>`.
- [ ] When the ship stub returns `reused: false` or omits it, no such note is added.
- [ ] DESIGN.md (engine Ship) and the CHANGELOG describe it.

**Scope**

- workflows/next-task-engine.js (selectPrompt open-PR rule, SELECT_SCHEMA `resumeBranch`, branchPrompt, shipPrompt, SHIP_SCHEMA, runIssue Ship handling)
- tests/engine.test.cjs, tests/docs.test.cjs
- DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T8.1-T8.10 (see Test matrix). Engine tests over the ship prompt text and stub results.

### T9: Init and doctor check the connected GitHub MCP server

- **Type:** fix
- **Area:** docs
- **Depends on:** none
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - changes how init writes the permission allow list (risk.highWhen: authentication or permissions)
- **Hotspot files:** skills/doctor/SKILL.md, skills/init/SKILL.md

**Acceptance criteria**

- [ ] `skills/init/SKILL.md` tells init to probe each connected GitHub MCP server by getting the authenticated user before generating the allow list: one answers → use its tool prefix; several answer → ask the user which; none → stop and tell the user to connect one.
- [ ] `skills/doctor/SKILL.md` check 3 reports the tool prefix of the server it used, and is `warn` when `.claude/settings.json` allows a GitHub MCP prefix other than that one and not that one.
- [ ] DESIGN.md (init, doctor), README.md where it describes the allow list, and the CHANGELOG describe it.

**Scope**

- skills/init/SKILL.md, skills/doctor/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- DESIGN.md, README.md, CHANGELOG.md

**Test plan**

- Test cases: T9.1-T9.7 (see Test matrix). Node text test over the two SKILL.md files.

### T10: Release 2.9.0

- **Type:** chore
- **Area:** docs
- **Depends on:** T1, T2, T3, T4, T5, T6, T7, T8, T9
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - release: moves the reusable workflows' tag for every project; human merges
- **Hotspot files:** .claude-plugin/plugin.json, .claude-plugin/marketplace.json, .github/workflows/devflow-merge-gate.yml

**Acceptance criteria**

- [ ] The version is 2.9.0 in plugin.json, marketplace.json, the init template, README, DESIGN.md, the flows page, the changelog and the `devflow-ref` example in `.github/workflows/devflow-merge-gate.yml` (description text only), and `node --test tests/version.test.cjs` passes.
- [ ] CHANGELOG `[Unreleased]` is renamed `[2.9.0] - <release date>` with every entry from T1-T9, and a new empty `[Unreleased]` is not left behind.
- [ ] The PR is labelled `risk:high`; the tag `v2.9.0` is created only after a human merges it.
- [ ] The full suite, including every docs test from T1-T9 (which find entries by issue number), passes on the release branch.

**Scope**

- version files listed in CLAUDE.md, CHANGELOG.md, docs/devflow-flows.html
- .github/workflows/devflow-merge-gate.yml (the `devflow-ref` example in a description only; no input or secret change)

**Test plan**

- Test cases: T10.1-T10.6 (see Test matrix). `node --test tests/*.test.cjs` and the hook tests pass.

## Test matrix

| Id | Task | Criterion | Case | Given / When / Then | Level | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| T1.1 | T1 | Claim prompt states the new taken rule | happy | Given a run on issue #1 / When the claim agent is called / Then its prompt says the issue is taken only when it has an assignee other than the authenticated user, or label `agent:in-progress` (labels.inProgress), labels.blocked or `agent:review` (labels.review) | integration | must |
| T1.2 | T1 | Self-assigned only means free | edge | Given a run on #1 / When the claim prompt is captured / Then it says an issue assigned only to the authenticated user with neither label is claimed (not taken) | integration | must |
| T1.3 | T1 | Mixed assignees means taken | edge | Given a run on #1 / When the claim prompt is captured / Then it says an issue assigned to the authenticated user and another user is taken | integration | should |
| T1.4 | T1 | Add self only when not assigned; schema has assignedByRun and claim authors | happy | Given a run on #1 / When claim is called / Then the prompt says to add the authenticated user only when not already assigned and to report `assignedByRun`, the claim schema's `required` contains `assignedByRun` with type `boolean`, and `claims.items.required` contains `author` | integration | must |
| T1.5 | T1 | assignedByRun true: cleanup removes self (Plan block) | happy | Given the claim stub returns `assignedByRun: true` and the plan stub returns `status: blocked` / When the blocked agent runs / Then its prompt tells it to remove the authenticated user from the assignees | integration | must |
| T1.6 | T1 | assignedByRun true: cleanup removes self (later stage) | boundary | Given `assignedByRun: true` and the review stub always returns a warning finding until maxReviewRounds / When the run blocks at Review / Then the blocked prompt has the remove-assignee instruction | integration | should |
| T1.7 | T1 | assignedByRun false: no assignee removal | error | Given the claim stub returns `assignedByRun: false` and Plan blocks / When the blocked agent runs / Then its prompt has no instruction to remove any assignee | integration | must |
| T1.8 | T1 | assignedByRun missing counts as false | edge | Given the claim stub omits `assignedByRun` and Plan blocks / When the blocked agent runs / Then the prompt has no remove-assignee instruction | integration | must |
| T1.9 | T1 | Lost claim, same login: assignee untouched | edge | Given `lose: true` for #1, `assignedByRun: true`, and both claims with author `me` (and separately the winning claim with no author) / When the run ends / Then no blocked agent is called and the release prompt has no assignee removal | integration | must |
| T1.10 | T1 | Docs describe the new rule | happy | Given the T1 branch / When DESIGN.md (Claim, blocked cleanup) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then each contains `assignedByRun` or "authenticated user"; the CHANGELOG entry cites the issue number; README is changed only if it has a claims section | unit | must |
| T1.11 | T1 | Lost claim, other login: loser removes its own assignee | happy | Given `lose: true` for #1, `assignedByRun: true`, our claim author `me` and the winning claim author `other` / When the run ends / Then the release prompt tells the agent to remove the authenticated user from the assignees, and no blocked agent is called; with `assignedByRun: false` / Then the release prompt has no assignee removal | integration | must |
| T2.1 | T2 | Stage throw after claim runs cleanup with Error | happy | Given claim won and the implement stub throws `new Error('boom')` / When the run ends / Then the blocked agent is called once with stage `Error` and `boom` in its prompt; the report entry is `{status:'blocked'}` with reason starting `Error: boom` | integration | must |
| T2.2 | T2 | Error reason uses the first line | boundary | Given the plan stub throws `new Error('line1\nline2')` / When the run ends / Then the reason is `Error: line1` and does not contain `line2` | integration | should |
| T2.3 | T2 | Throw cleanup follows the assignedByRun rule (true) | happy | Given `assignedByRun: true` and the QA stub throws / When cleanup runs / Then the blocked prompt has the remove-assignee instruction | integration | must |
| T2.4 | T2 | Throw cleanup follows the assignedByRun rule (false) | error | Given `assignedByRun: false` and the QA stub throws / When cleanup runs / Then the blocked prompt has no remove-assignee instruction | integration | must |
| T2.5 | T2 | Claim throw: no cleanup, partial-claim note | error | Given the claim stub throws `new Error('mcp')` / When the run ends / Then no blocked agent is called, the entry is `blocked` with reason starting `Workflow error:`, its notes contain `claim may be partial; run /devflow:doctor` and not `cleanup failed` | integration | must |
| T2.6 | T2 | Release throw after a lost claim: no cleanup, partial-claim note | edge | Given `lose: true` and the release stub throws / When the run ends / Then no blocked agent is called, the reason starts `Workflow error:` and the notes contain `claim may be partial; run /devflow:doctor` | integration | must |
| T2.7 | T2 | Cleanup throws after a stage throw | error | Given the implement stub throws and the blocked stub throws / When the run ends / Then the blocked agent was called exactly once; the reason starts `Workflow error:`; notes contain `cleanup failed; run /devflow:doctor` | integration | must |
| T2.8 | T2 | Cleanup throws after a normal block | error | Given Plan returns blocked and the blocked stub throws / When the run ends / Then blocked was called exactly once; the reason starts `Workflow error:`; notes contain `cleanup failed; run /devflow:doctor` | integration | must |
| T2.9 | T2 | Run continues after a cleanup failure | happy | Given issues [1,2] with limit 3, #1 Plan blocked and the blocked stub throwing for #1 only / When the run ends / Then #2 reaches Ship (status `pr`) | integration | must |
| T2.10 | T2 | A normal block is not cleaned up twice | edge | Given Plan returns blocked and blocked succeeds / When the run ends / Then the blocked agent is called exactly once and the reason is the Plan reason (not `Error:`) | integration | must |
| T2.11 | T2 | Parallel QA/Implement throw waits for both | edge | Given parallelQa true, the QA stub throws and the implement stub resolves later / When the run ends / Then the blocked agent is called after the implement stub settled, once, with stage `Error` | integration | should |
| T2.12 | T2 | Non-Error or empty throw | edge | Given the plan stub throws `undefined`, then `new Error('')` / When the run ends / Then the reason is `Error: unknown` | integration | should |
| T2.13 | T2 | Doctor --fix removes the assignee only if it is the authenticated user | happy | Given `skills/doctor/SKILL.md` (tests/skills.test.cjs) / When check 6 `--fix` is read / Then it removes the assignee of a stale in-progress issue only when it is the authenticated user and says other assignees are kept | unit | must |
| T2.14 | T2 | Docs describe both | happy | Given the T2 branch / When DESIGN.md (engine, doctor) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then they mention cleanup on a thrown error (`Error:`), `cleanup failed; run /devflow:doctor`, and doctor removing only its own assignee | unit | must |
| T2.15 | T2 | Notes survive a throw | edge | Given a resumed branch (the branch stub returning `resumed: true`) and the blocked stub throwing after Plan blocks / When the run ends / Then the entry's notes contain both the resumed-branch note and `cleanup failed; run /devflow:doctor` | integration | should |
| T3.1 | T3 | Sync handles only trusted thread starters | happy | Given `skills/sync/SKILL.md` / When step 4 is read / Then it names the authenticated user, `claude[bot]` and `list_repository_collaborators` as the sources of trusted first-comment authors, says a login not in the list is untrusted, and does not trust `github-actions[bot]` or any other bot | unit | must |
| T3.2 | T3 | Sync: untrusted thread listed, no reply or commit | error | Given the sync skill / When step 4 and the final table are read / Then other threads are listed as `ignored: not a collaborator`, and the skill says they get no reply and no commit | unit | must |
| T3.3 | T3 | Sync acts only on trusted comments and never resolves others' threads | edge | Given the sync skill / When step 4 is read / Then it says untrusted replies inside a trusted thread are ignored and that sync never resolves a review thread it did not start | unit | must |
| T3.4 | T3 | Sync no longer claims an author reply clears human threads | error | Given the sync skill / When it is searched / Then no sentence says the gate ignores human threads whose last comment is by the PR author; a sentence says a trusted human's thread blocks the gate until resolved | unit | must |
| T3.5 | T3 | Answer takes answers and questions from trusted authors only | happy | Given `skills/answer/SKILL.md` / When steps 1 and 2.2 are read / Then step 1 uses a questions comment only from the authenticated user or OWNER, MEMBER, COLLABORATOR, and step 2.2 names the authenticated user and OWNER, MEMBER, COLLABORATOR and says bots are never used | unit | must |
| T3.6 | T3 | Answer lists ignored comments; latest trusted answer wins | edge | Given the answer skill / When step 2.2 and the report section are read / Then ignored comments are reported as `ignored: not a collaborator`, and the latest trusted answer per question wins | unit | must |
| T3.7 | T3 | Answer step 6: the engine resumes a branch with commits | happy | Given the answer skill / When step 6 is read / Then it says a branch with commits from an earlier blocked run is resumed by the engine, and "must be handled by hand" is gone | unit | must |
| T3.8 | T3 | Docs describe the trust rule | happy | Given the T3 branch / When DESIGN.md (sync, answer) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then both name OWNER/MEMBER/COLLABORATOR and `ignored: not a collaborator` | unit | must |
| T3.9 | T3 | Sync ignores other bots' threads | error | Given the sync skill / When step 4 is read / Then a thread started by a bot other than `claude[bot]` (for example Copilot or CodeRabbit) is listed as `ignored: not a collaborator` with no reply and no commit | unit | must |
| T3.10 | T3 | Sync leaves behind-only updates to the gate only where the gate updates | happy | Given the sync skill / When step 2 is read / Then it skips the update only when the gate is enabled, not in dry run, and the PR is devflow + `risk:low`, not stacked and not blocked; it updates as before in dry run, with the gate off, and for `risk:high`, stacked or blocked PRs | unit | must |
| T3.11 | T3 | Sync ignores a summary comment from anyone else | error | Given the sync skill / When step 4 is read / Then it uses the latest review summary comment only when its author is `claude[bot]` or the authenticated user, and says any other summary-like comment, even with a `<!-- devflow-verdict` marker, is listed as `ignored: not a collaborator` | unit | must |
| T4.1 | T4 | Three behind PRs: only the first is updated | happy | Given PRs #1, #2, #3, all eligible, `behind_by: 2`, not dry run / When the gate runs / Then `pulls.updateBranch` is called once, for #1 (action `updated`); #2 and #3 are `deferred` with reason `deferred: waits for its turn` | integration | must |
| T4.2 | T4 | Priority order picks the slot holder | boundary | Given behind PRs #1 (no priority) and #5 (linked issue labelled `priority:critical`) / When the gate runs / Then #5 is `updated` and #1 is `deferred` | integration | must |
| T4.3 | T4 | A skipped behind PR does not take the slot (draft) | edge | Given #1 draft and behind, and #2 eligible and behind / When the gate runs / Then #1 is `skipped`/`draft`, #2 is `updated`, and updateBranch is called once, for #2 | integration | must |
| T4.4 | T4 | Each earlier rule leaves the slot free | edge | Given (one test per rule) a first PR that is behind and either risk:high, labelled blocked, stacked, with an open dependency, touching a highPaths file, or in conflict (`mergeable:false`), followed by an eligible behind PR / When the gate runs / Then the second PR is `updated` | integration | should |
| T4.5 | T4 | Mergeability not computed on an old head does not take the slot | edge | Given #1 with `mergeable: null`, head commit and PR created 20 minutes ago, and #2 behind / When the gate runs / Then #1 is `skipped` with `mergeability not computed yet` and #2 is `updated` | integration | must |
| T4.6 | T4 | Up to date with pending checks holds the slot | happy | Given #1 up to date with `devflow/review` started 5 minutes ago in status `in_progress` (and separately run status `queued`, `waiting`, `requested` and `pending`, and separately a `pending` commit status created 5 minutes ago), and #2 behind / When the gate runs / Then #2 is `deferred` with `deferred: waits for its turn` and updateBranch is not called | integration | must |
| T4.7 | T4 | Up to date with failed checks does not hold the slot | edge | Given #1 up to date with `devflow/review` failure, and #2 behind / When the gate runs / Then #1 is `skipped` with the check reason and #2 is `updated` | integration | must |
| T4.8 | T4 | updateBranch transient error: the slot is still used | error | Given #1 and #2 behind and updateBranch rejecting for #1 with status 502 (and separately 422 with `pulls.get` then returning a different `head.sha`) / When the gate runs / Then #1 is `error`, #2 is `deferred` with `deferred: waits for its turn`, and updateBranch is called exactly once | integration | must |
| T4.9 | T4 | Update and merge in one run | happy | Given #1 behind, and #2 up to date, green, with no threads / When the gate runs / Then #1 is `updated` and pulls.merge is called for #2 | integration | must |
| T4.10 | T4 | No update after a merge | boundary | Given #1 up to date and green, #2 behind / When the gate runs / Then #1 is merged and #2 is `deferred: one merge per run`; updateBranch is not called | integration | should |
| T4.11 | T4 | Dry run: would update plus deferred, no calls | happy | Given dryRun true and #1, #2 behind / When the gate runs / Then #1 is `would update`, #2 is `deferred` with `deferred: waits for its turn`, and updateBranch is never called | integration | must |
| T4.12 | T4 | Docs describe it | happy | Given the T4 branch / When DESIGN.md "Risk and the merge gate", the README gate section (if present) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then each contains `deferred: waits for its turn`, and DESIGN.md also names the 60- and 15-minute limits, the hourly schedule with its Actions cost, and `/devflow:init --upgrade` | unit | must |
| T4.13 | T4 | A missing check on an old head does not hold the slot | edge | Given #1 up to date with no `devflow/review` run and no status, head commit and PR created 20 minutes ago (and separately exactly 15 minutes ago), and #2 behind / When the gate runs / Then #1 is `skipped` with reason `waiting for devflow/review: missing`, #2 is `updated`, and updateBranch is called once, for #2 | integration | must |
| T4.14 | T4 | A missing check on a fresh head holds the slot | boundary | Given #1 up to date with no `devflow/review` run and no status, head commit dated 3 hours ago but the PR created 1 minute ago (and separately head commit 14 minutes 59 seconds old and PR older), and #2 behind / When the gate runs / Then #2 is `deferred` with `deferred: waits for its turn` and updateBranch is not called | integration | must |
| T4.15 | T4 | Worst check state wins | edge | Given `requiredChecks: ["devflow/review", "test"]`, #1 up to date with `devflow/review` in progress and `test` failed (and separately the order reversed, and separately `devflow/review` missing on a fresh head with `test` failed), and #2 behind / When the gate runs / Then #1 is `skipped` with reason `waiting for test: failure`, #2 is `updated`, and updateBranch is called once | integration | must |
| T4.16 | T4 | A pending hold ends after 60 minutes | boundary | Given #1 up to date with `devflow/review` in progress, started 60 minutes ago (and separately 59 minutes ago), head commit 5 minutes old, and #2 behind / When the gate runs / Then at 60 minutes #1 is `skipped` with `waiting for devflow/review: in_progress` and #2 is `updated`; at 59 minutes #2 is `deferred` | integration | must |
| T4.17 | T4 | Non-success conclusions and status error count as failed | edge | Given #1 up to date, head 5 minutes old, with `devflow/review` run completed `cancelled` (and separately `skipped`, `neutral`, `timed_out`, and a commit status `error` with no run), and #2 behind / When the gate runs / Then #1 is `skipped` with the check reason and #2 is `updated` | integration | must |
| T4.18 | T4 | Both gate templates run on an hourly schedule | happy | Given `skills/init/templates/github/callers/devflow-merge-gate.yml` and `skills/init/templates/github/workflows/devflow-merge-gate.yml` / When parsed (tests/reusable.test.cjs) / Then each has `schedule` with cron `23 * * * *` and still has `workflow_run`, `status` and `workflow_dispatch`; `.github/workflows/devflow-merge-gate.yml` still has only `workflow_call` with unchanged inputs and secrets | unit | must |
| T4.19 | T4 | A scheduled run evaluates every candidate | happy | Given a gate run whose `context.payload` has no `inputs` (as for `schedule`), #1 up to date with `devflow/review` in progress, started 61 minutes ago, and #2 behind / When the gate runs / Then both PRs are evaluated, #1 is `skipped` and #2 is `updated` | integration | must |
| T4.20 | T4 | updateBranch permanent error frees the slot | error | Given #1 and #2 behind and updateBranch rejecting for #1 with status 403 (and separately 404) / When the gate runs / Then #1 is `error`, updateBranch is called for #2, and #2 is `updated` | integration | must |
| T4.21 | T4 | A future date is ignored | edge | Given #1 up to date with no `devflow/review` run and no status, head commit dated 2 hours in the future and PR created 30 minutes ago (and separately both dates in the future), and #2 behind / When the gate runs / Then #1 does not hold the slot and #2 is `updated` | integration | must |
| T4.22 | T4 | mergeable null on a fresh head holds the slot | boundary | Given #1 with `mergeable: null`, PR created 2 minutes ago, and #2 behind / When the gate runs / Then #1 is `skipped` with `mergeability not computed yet`, #2 is `deferred`, and updateBranch is not called | integration | must |
| T4.23 | T4 | The flag is set before updateBranch | edge | Given #1 and #2 behind and an updateBranch stub that records whether a second call happens while the first is still pending / When the gate runs / Then only one call is made | integration | should |
| T4.24 | T4 | 422 with an unchanged head frees the slot | error | Given #1 and #2 behind and updateBranch rejecting for #1 with status 422 while `pulls.get` still returns the same `head.sha` / When the gate runs / Then #1 is `error` and #2 is `updated` | integration | must |
| T5.1 | T5 | A collaborator thread blocks even after an author reply | happy | Given PR author `author`, and one unresolved thread first by `rev` (`COLLABORATOR`, `__typename: User`) with last comment by `author` / When the gate runs / Then the action is `skipped` with reason `1 unanswered review threads` | integration | must |
| T5.2 | T5 | OWNER and MEMBER also block | boundary | Given the same thread with association `OWNER`, then `MEMBER` / When the gate runs / Then each is `1 unanswered review threads` | integration | must |
| T5.3 | T5 | Resolved or outdated does not block | happy | Given the collaborator thread with `isResolved: true`, then with `isOutdated: true` / When the gate runs / Then the PR merges | integration | must |
| T5.4 | T5 | Untrusted association does not block | error | Given an unresolved thread started by `stranger` with `CONTRIBUTOR`, then `NONE`, then `FIRST_TIME_CONTRIBUTOR`, last comment by `stranger` / When the gate runs / Then the PR merges | integration | must |
| T5.5 | T5 | No author, no association or no comments does not block | edge | Given an unresolved thread whose first comment has `author: null`, one with `authorAssociation` missing, and one with no comment nodes / When the gate runs / Then the PR merges | integration | must |
| T5.6 | T5 | Bot PR author: a trusted human's thread blocks | happy | Given a PR with `user.login: 'devflow-bot[bot]'` and an unresolved thread started by an OWNER human, last comment by `devflow-bot` / When the gate runs / Then the action is `skipped` with `1 unanswered review threads` | integration | must |
| T5.7 | T5 | claude[bot]-started thread follows today's rule | happy | Given a thread first by `claude` (`__typename: Bot`), with last comment by `rev` / When the gate runs / Then it blocks; with last comment by the PR author / Then it does not block | integration | must |
| T5.8 | T5 | Bot login suffix is ignored when comparing | edge | Given a PR by `renovate[bot]` and a thread started by `claude` (`__typename: Bot`) whose last comment author login is `renovate` / When the gate runs / Then it does not block | integration | should |
| T5.9 | T5 | Author-started thread follows today's rule | happy | Given a thread first by `author`, last by `rev` / Then it blocks; last by `author` / Then it does not block | integration | must |
| T5.10 | T5 | The count includes only blocking threads | boundary | Given 4 unresolved threads (collaborator; NONE stranger; claude[bot] answered by the author; author-started with a reviewer reply) / When the gate runs / Then the reason is `2 unanswered review threads` | integration | should |
| T5.11 | T5 | The query asks for first-comment author type and association | happy | Given the stub `github.graphql` / When the gate runs / Then the query text contains `__typename` and `authorAssociation`, and asks for both the first and the last comment | integration | should |
| T5.12 | T5 | Docs describe the rule | happy | Given the T5 branch / When DESIGN.md (Risk and the merge gate), README (if present) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then they say a collaborator's thread blocks until resolved, and DESIGN.md mentions the private-membership `CONTRIBUTOR` caveat | unit | must |
| T5.13 | T5 | Other bots' threads do not block | happy | Given an unresolved thread first by `coderabbitai` (`__typename: Bot`), last comment by `coderabbitai` (and separately one by `copilot-pull-request-reviewer`) / When the gate runs / Then the PR merges | integration | must |
| T5.14 | T5 | A human named claude is not the review bot | edge | Given an unresolved thread first by login `claude` with `__typename: User` and association NONE, last comment by the PR author / When the gate runs / Then it does not block (untrusted human), and with association COLLABORATOR it blocks (trusted human) | integration | must |
| T6.1 | T6 | Seven prompts drop the Select body | happy | Given the select stub body contains `MARKER-7f3a` / When the issue runs through Plan, QA, Implement, Fix (after a failing check), Integrate, Verify and Review / Then no prompt for those labels contains `MARKER-7f3a` | integration | must |
| T6.2 | T6 | Seven prompts say to read the issue from GitHub | happy | Given the same run / When each of the seven prompts is read / Then each contains `#1`, `o/r` and an instruction to read the issue from GitHub and treat it as the source of truth; the title stays inline | integration | must |
| T6.3 | T6 | Select still gets the full body; engine parsing uses it | happy | Given a select body with spec path `docs/specs/x.md`, `Depends on #9`, a Test cases table with an `http` level and a Risk line / When the run proceeds / Then the select prompt still asks for the full body, and the engine uses that spec path, dependency, test level and risk reason | integration | must |
| T6.4 | T6 | Plan schema requires an integer acceptanceCriteria | happy | Given a run / When the plan agent is called / Then the plan schema's `required` has `acceptanceCriteria` with type `integer` | integration | must |
| T6.5 | T6 | Count mismatch: note and log, run continues | error | Given a select body with `## Acceptance criteria` and `- [ ] a`, `- [x] b` (count 2), and plan returning `acceptanceCriteria: 3` / When the run ends / Then the status is `pr`, the notes contain `acceptance criteria: plan read 3, selection had 2`, and a log line has both 3 and 2 | integration | must |
| T6.6 | T6 | Counts match: no note | happy | Given the same body and plan returning `acceptanceCriteria: 2` / When the run ends / Then no note starts with `acceptance criteria:` | integration | must |
| T6.7 | T6 | Counting rules: top level only, section ends at the next heading | boundary | Given a body with `**Acceptance criteria**`, 2 top-level items, 1 indented `  - [ ] sub`, then `## Scope` with `- [ ] z` / When plan returns 2 / Then there is no mismatch note | integration | must |
| T6.8 | T6 | Syntax: capital X, case-insensitive heading, other bullets | edge | Given `### ACCEPTANCE CRITERIA` with `- [X] a`, `- [ ] b`, `* [ ] c`, `1. [ ] d` / When plan returns 2 / Then there is no mismatch note | integration | must |
| T6.9 | T6 | Only the first matching heading counts | edge | Given two `Acceptance criteria` headings with 1 and 3 items, and plan returning 1 / When the run ends / Then there is no mismatch note | integration | should |
| T6.10 | T6 | No heading counts 0 | edge | Given a body without an Acceptance criteria heading and plan returning 0 / Then there is no note; with plan returning 2 / Then the note is `acceptance criteria: plan read 2, selection had 0` | integration | must |
| T6.11 | T6 | Plan omits or mistypes the count | error | Given plan stubs returning no `acceptanceCriteria`, then `"2"`, then `2.5` / When each run ends / Then the notes contain `plan did not report the acceptance criteria count` and the status is `pr` | integration | must |
| T6.12 | T6 | Count compared when Plan blocks | edge | Given plan returns `status: blocked` with `acceptanceCriteria: 5` and the body has 2 items / When the run ends / Then the blocked entry's notes contain `acceptance criteria: plan read 5, selection had 2` | integration | should |
| T6.13 | T6 | Docs describe it | happy | Given the T6 branch / When DESIGN.md (engine stages) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then they say the stages read the issue from GitHub and the Select copy is used only for parsing | unit | must |
| T6.14 | T6 | Review reads the issue with gh, or runs on the default agent | happy | Given `ghCli: true` / When the review agent is called / Then `agentType` is `devflow:reviewer` and the prompt contains `gh issue view 1 --repo o/r`. Given `ghCli: false` / Then the review call has no `agentType`, the prompt tells it to read the issue with the GitHub MCP server, and the notes contain `review ran on the default agent: gh is not installed` | integration | must |
| T6.15 | T6 | Reviewer could not read the issue: re-run on the default agent | error | Given `ghCli: true` and the reviewer stub returning `issueRead: false` with no findings / When the run proceeds / Then a second review call without `agentType` is made for the same round, its result decides the loop, and the notes contain `review ran on the default agent: the reviewer could not read the issue` | integration | must |
| T6.16 | T6 | Setup allows gh issue view only | happy | Given a config / When `node bin/devflow-setup allow` runs (tests/setup.test.cjs) / Then the rules contain `Bash(gh issue view:*)` and no `Bash(gh:*)`, `Bash(gh pr merge:*)` or other `gh` rule | unit | must |
| T6.17 | T6 | A stage that cannot reach GitHub stops the run | error | Given issues [1,2] and the plan stub (and separately the fix and review stubs) returning `problem` starting with the MCP-down marker / When the run ends / Then no blocked agent is called for #1, its entry has `mcpDown`, and #2 is skipped with the stop reason; the prompts of all seven stages contain the MCP note | integration | must |
| T6.18 | T6 | Claim labels decide risk | error | Given the Select copy labels `risk:low` and the claim stub returning labels `risk:high` / When the run ships / Then the ship prompt's Risk line says high and the notes contain `labels differ from the selection: risk:high`; with equal labels no such note | integration | must |
| T6.19 | T6 | Plan's http/e2e flag triggers Verify | edge | Given a Select copy with no http or e2e row and the plan stub returning `httpOrE2eRows: true` / When the run proceeds / Then the verify agent is called | integration | must |
| T6.20 | T6 | Claim's spec path wins over a cut Select copy | error | Given a Select body without the spec link and the claim stub returning `specPath: 'docs/specs/a.md'` and `introducedBy: true` / When the run proceeds / Then the plan, implement, QA and review prompts name `docs/specs/a.md` (not "The issue links no spec"), the ship prompt has the Root cause sections, and the notes contain `spec path differs from the selection: docs/specs/a.md` | integration | must |
| T6.21 | T6 | The default-agent fallback sticks and fails closed | error | Given `ghCli: true` and the reviewer stub returning `issueRead: false` in round 1 / When a second review round runs / Then it goes straight to the default agent (one reviewer call in total); and given the default agent also returning `issueRead: false` / Then the issue is blocked at Review with reason `Review: the review could not read the issue` | integration | must |
| T7.1 | T7 | Taken at Claim does not count | happy | Given limit 1, issues [1,2] and `taken` for #1 / When the run ends / Then #1 is `skipped` and #2 has status `pr` | integration | must |
| T7.2 | T7 | Lost claim does not count | happy | Given limit 1, issues [1,2] and `lose` for #1 / When the run ends / Then #2 has status `pr` | integration | must |
| T7.3 | T7 | Blocked after Claim counts | error | Given limit 1, issues [1,2] and Plan blocked for #1 / When the run ends / Then #2 is `skipped` with reason `over limit (1)` | integration | must |
| T7.4 | T7 | Workflow error after Claim counts | edge | Given limit 1, issues [1,2], and #1 with Plan blocked and the blocked stub throwing / When the run ends / Then #2 is `skipped` with `over limit (1)` | integration | should |
| T7.5 | T7 | Several Claim skips in a row | boundary | Given limit 1, issues [1,2,3], #1 taken and #2 lost / When the run ends / Then #3 has status `pr` | integration | should |
| T7.6 | T7 | A pass verdict with a warning starts a fix round | happy | Given review round 1 returns `{verdict:'pass', findings:[{severity:'warning'}]}` and round 2 returns no findings / When the run ends / Then a fix agent is called after the first review, and Ship is called only after the second | integration | must |
| T7.7 | T7 | A changes verdict with only suggestions ships | happy | Given review returns `{verdict:'changes', findings:[{severity:'suggestion'}]}` / When the run ends / Then no review fix agent runs and the status is `pr` | integration | must |
| T7.8 | T7 | An unknown severity blocks | error | Given review findings `[{severity:'major'}]`, then `[{severity:'Suggestion'}]` / When the run ends / Then each starts a fix round (fail closed) | integration | must |
| T7.9 | T7 | A warning left after maxReviewRounds blocks with today's reason | boundary | Given maxReviewRounds 2 and review always returning a warning / When the run ends / Then the status is `blocked` with a reason starting `Review: Review still has critical/warning findings after 2 fix round(s)` | integration | must |
| T7.10 | T7 | An unaccepted scan hit counts as blocking | edge | Given review `verdict:'pass'` with no findings, but an unaccepted scan hit injected / When the loop runs / Then a fix round starts | integration | should |
| T7.11 | T7 | Docs describe both | happy | Given the T7 branch / When DESIGN.md (engine) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then they say Claim skips do not count toward the limit and the review exits on findings only | unit | must |
| T8.1 | T8 | Ship step 0 reuses an open PR | happy | Given a run with branch `feat/1-x` / When the ship prompt is captured / Then its first step tells the agent to look for an open PR in `o/r` with head `feat/1-x`; if one exists, push normally, retarget the base if it differs, rewrite the body, add the computed labels without removing existing ones, never open a new PR, and continue with the issue labels | integration | must |
| T8.2 | T8 | Intended base in step 0 follows stacking | boundary | Given a chain where #2 stacks on #1's branch / When #2's ship prompt is captured / Then the retarget step names #1's branch as the intended base | integration | should |
| T8.3 | T8 | reused true adds a note | happy | Given the ship stub returns `{prNumber:42, reused:true}` / When the run ends / Then the entry has status `pr`, PR 42, and notes containing `reused open PR #42` | integration | must |
| T8.4 | T8 | Ship schema fields | happy | Given a run / When the ship agent is called / Then the schema has `reused` of type `boolean` and `prNumber` is still required | integration | must |
| T8.5 | T8 | reused false or missing: no note | error | Given ship stubs returning `reused:false`, then without `reused` / When each run ends / Then no note starts with `reused open PR` | integration | must |
| T8.6 | T8 | Reuse never removes labels | edge | Given the ship prompt / When step 0 is read / Then it says never to remove `risk:high` or a label already on the PR | integration | must |
| T8.7 | T8 | Docs describe it | happy | Given the T8 branch / When DESIGN.md (engine Ship) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then they mention reusing an open PR for the branch | unit | must |
| T8.8 | T8 | Select keeps an issue whose open PR is its own devflow PR | happy | Given the select prompt / When it is captured / Then it says an issue is not skipped when its only open PR has the `devflow` label and `Closes #<n>` for it and the issue is not labelled `agent:review`, that `resumeBranch` is that PR's head branch, and that the issue is still skipped for any other open PR referencing it | integration | must |
| T8.9 | T8 | Branch resumes the PR's branch even with another slug | edge | Given the select stub returning issue #1 with `resumeBranch: 'fix/1-old-slug'` and title words that would give another slug / When the branch agent is called / Then its prompt names `fix/1-old-slug` as the branch to resume and does not ask it to derive a name from `branchPattern` | integration | must |
| T8.10 | T8 | An issue in review is not selected or claimed | error | Given the select prompt / Then it says an issue labelled `agent:review` is skipped even when its only open PR is its own devflow PR; and given the claim prompt / Then `agent:review` makes the issue taken | integration | must |
| T9.1 | T9 | Init probes the servers: one answers | happy | Given `skills/init/SKILL.md` / When the background-sessions paragraph is read / Then, before the allow list is generated, it says to probe each connected GitHub MCP server by getting the authenticated user, and to use the tool prefix of the one that answers | unit | must |
| T9.2 | T9 | Init: several answer | edge | Given the init skill / Then it says to ask the user which server to use when several answer | unit | must |
| T9.3 | T9 | Init: none answers | error | Given the init skill / Then it says to stop and tell the user to connect a GitHub MCP server when none answers (an auth error counts as not answering) | unit | must |
| T9.4 | T9 | Init replaces a stale prefix | edge | Given the init skill / Then it says a GitHub MCP prefix in the allow list other than the chosen one is replaced, shown in the diff before writing | unit | should |
| T9.5 | T9 | Doctor check 3 names the prefix | happy | Given `skills/doctor/SKILL.md` / When check 3 is read / Then it reports the tool prefix of the server it used | unit | must |
| T9.6 | T9 | Doctor check 3 warns on an allow-list mismatch | error | Given the doctor skill / When check 3 is read / Then it is `warn` when `.claude/settings.json` allows another GitHub MCP prefix but not this one; ok when both are allowed; no allowed prefix is left to check 8 | unit | must |
| T9.7 | T9 | Docs describe it | happy | Given the T9 branch / When DESIGN.md (init, doctor), README (allow-list section, if present) and the CHANGELOG entry citing the task's issue number are read (tests/docs.test.cjs) / Then they mention the probe and the check 3 prefix warning | unit | must |
| T10.1 | T10 | Versions agree at 2.9.0 | happy | Given the release branch / When `node --test tests/version.test.cjs` runs and plugin.json is read / Then it passes and the version is `2.9.0` | unit | must |
| T10.2 | T10 | Changelog heading moved, no empty Unreleased (release-time check, not kept in the suite) | happy | Given CHANGELOG.md / Then the first `## [` heading matches `## [2.9.0] - YYYY-MM-DD` and no `## [Unreleased]` heading exists | unit | must |
| T10.3 | T10 | Release date is valid (release-time check, not kept in the suite) | boundary | Given the `[2.9.0]` heading / Then the date parses and is not earlier than 2.8.0's date | unit | should |
| T10.4 | T10 | Entries from T1-T9 are present | happy | Given the `[2.9.0]` section / Then it cites the issue number of each of T1-T9 | unit | must |
| T10.5 | T10 | The full suite passes | happy | Given the release branch with `[Unreleased]` renamed to `[2.9.0]` / When `node --test tests/*.test.cjs` (including tests/docs.test.cjs) and the hook unittest discovery run / Then both pass | unit | must |
| T10.6 | T10 | risk:high label; tag only after merge (manual check, not a suite test) | happy | Given the release PR / Then it has the `risk:high` label, and `v2.9.0` does not exist before the merge (manual check after the human merge) | integration | must |
