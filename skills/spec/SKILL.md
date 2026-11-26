---
name: spec
description: Turn an idea into an analysed, grilled epic issue with one sub-issue per task (default), or with --file into a spec PR with a task list and QA test matrix, Gate 1, then one labelled issue per task.
argument-hint: <idea, or path to a brief> [--file]
disable-model-invocation: true
---

# /devflow:spec

Idea: $ARGUMENTS

Designed for a cloud session on the repo; works locally too. Rules for this skill: all committed content is in English; no `Co-Authored-By` or AI attribution in commits or PRs; never write the review bot's at-sign handle into issues or PRs; use the GitHub MCP server for GitHub operations (load its tools with ToolSearch). Never merge anything.

`--file` (anywhere in the arguments, removed before the rest is read as the idea or brief path) selects `--file` mode. Without it the skill runs in epic mode. If the rest of `$ARGUMENTS` is empty, ask for the idea. If it is a path, read that file as the brief.

Two modes share steps 1 and 2:

- **Epic mode (default):** no spec file and no PR. One epic issue holds the goal, design and decisions; one sub-issue per task. The human approves each sub-issue by setting the ready label (see Final message).
- **`--file` mode:** the spec file, spec PR, Gate 1 and issues labelled ready after the merge.

Follow the steps in order. Announce each by number.

## 1. Analyse

- Read `.claude/devflow.json` (if missing, tell the user to run `/devflow:init` and stop) and `CLAUDE.md`.
- Read the code the idea touches.
- Produce a short analysis: current behaviour, affected areas (backend, frontend, infra, data), risks, unknowns.
- Do not write any file yet.

## 2. Grill

- Invoke the `grill-me` skill on the idea plus your analysis.
- Continue until no question is open: every unknown is decided or explicitly deferred by the user.
- No issue is created and no spec PR is opened while a question is open, unless the user defers it. A deferred question is written into an `## Open questions` section of each affected sub-issue. In `--file` mode it also goes into the spec's `Risks and unknowns`, and the issues created after the merge get the same section.
- If `grill-me` is not available, run the same interview inline: one question at a time, each with your recommended answer.

**Checkpoint:** list the decisions and deferrals. Proceed only when none is open.

## Epic mode (default)

Writes no spec file and opens no PR. The grill decisions, design and tasks live in GitHub issues. Task fields are the same as in `--file` mode (stable id `T1..Tn`, title, type, area, depends-on, acceptance criteria as checkable behaviour, files in scope, test plan, needs-e2e, size S or M, risk and hotspots), judged against `risk.highWhen` and `risk.highPaths`; unsure means high.

### E1. Tasks

 Pick a kebab-case `<slug>` (at most 5 words). Draft the epic from `${CLAUDE_SKILL_DIR}/templates/epic.md` (Goal, Design, `## Decisions` with the grill answers, and the Tasks table with risk and reason, depends-on and an empty issue column) and the task list. When the request names existing issues it resolves, write a line `Resolves: #a, #b` into the epic body (see the template); the Ship stage of the epic's last open sub-issue then adds a `Closes #<n>` line for each of them that is still open. Without such issues, write no `Resolves:` line. Split anything bigger than M. Record each task's risk with a one-line reason and its hotspot files (real file paths, as `/devflow:dispatch` uses them).

Extract shared groundwork (auth, schema, layout or config) into a small foundation task. Add a `Depends on` line only when a task calls or imports another task's code or uses a schema or file it creates. A shared topic or preferred work order alone does not justify a dependency.

### E2. Draft and test matrix (QA)

 Fill `${CLAUDE_SKILL_DIR}/templates/spec.md` into a scratchpad file `<slug>.draft.md` from the epic and tasks of E1. It is never committed. Then run the same QA step as F2 below (skipped when `spec.testMatrix` is `false`), giving the QA agent the path of the draft in place of the spec file, and writing the answers and the final rows back into the draft. Put the final rows in each task's Test cases.

### E3. Spec review

Run the spec review defined in "Review of the draft (both modes)" below on the draft of E2, giving the reviewer the path of the draft. Fix the draft for each critical finding before E4.

### E4. Build and size check

 For any task that needs a human step before it can be worked on, include a standalone `Ready: manual` line in its body and explain the step in Context. Include it when measuring body size.

 Build every body in memory first, from the draft: the epic and one sub-issue per task from `${CLAUDE_SKILL_DIR}/templates/issue.md` (the Context line `Epic: #<epic>`, which must start at column 0 with no other text on the line, acceptance criteria as a checklist, scope, the task's Test cases rows copied as they are, the Risk line with reason, Hotspots, one `Depends on #<n>` line per dependency, and the `## Open questions` section: the deferred questions that affect the task, else `None`). Issue numbers are not known yet: fill each with a number at its widest expected width (for example `#99999`). Measure each body with the JavaScript string `length` (not bytes). If any body is longer than 65,000 characters, create nothing, tell the user which body is too long, and tell them to run `/devflow:spec --file` instead; stop.

### E5. Create

 Only after E4 passed. Create with the GitHub MCP `issue_write` tool (method `create`).
1. For each title, search existing issues (open and closed) for an exact match of the trimmed, case-sensitive title: epic `[<slug>] <title>`, sub-issues `[<slug>] T<n>: <task title>`. Reuse a match as it is: do not edit its body, labels or state (the one exception is a reused epic's Tasks table, which E7 fills with the issue numbers). Create only what is missing, so a re-run after a partial failure makes no duplicates.
2. Create the epic with label `type:epic` only: no ready label and no risk label.
3. Create the sub-issues in dependency order so `Depends on` lines use real numbers and `Epic: #<epic>` the real epic number. Labels per sub-issue: `labels.riskLow` or `labels.riskHigh` per the task's risk, `labels.e2e` when the task needs e2e, and `type:<type>`. Never add the ready label during creation. A human can set it directly, or approve the epic for configured auto-readying with `/devflow:approve`. Adding a missing label creates it.

### E6. Link

 Link each sub-issue to the epic with the GitHub MCP `sub_issue_write` tool, method `add`. First read the epic's existing sub-issues and skip a link that already exists. A failed link is reported in the final message and does not stop the run.

### E7. Update the epic

Edit the epic body so the Tasks table has the issue numbers (reused issues included). Nothing else in the body changes.

## `--file` mode

The 2.9.0 flow: a spec file and spec PR, a human merge (Gate 1), then one issue per task labelled ready.

### F1. Spec and tasks

1. Pick a kebab-case `<slug>` (at most 5 words). Create branch `spec/<slug>` from `<remote>/<baseBranch>` (`git fetch` first).
2. Copy `${CLAUDE_SKILL_DIR}/templates/spec.md` and fill it into `<specDir>/<YYYY-MM-DD>-<slug>.md`: problem, goals and non-goals, decisions (with the grill answers), design (API contracts, data model, UI screens and states; mocks go in `<specDir>/<slug>/`), risks, and the task list.
3. Each task has: stable id `T1..Tn`, title, type, area, depends-on, acceptance criteria as checkable behaviour (API: request then response; UI: user action then visible result), files and areas in scope, test plan, needs-e2e yes/no, size S or M, risk and hotspot files. Split anything bigger than M.
4. Risk: judge each task against `risk.highWhen` and `risk.highPaths` in the config (the defaults apply when unset; a task whose scope matches a `highPaths` glob is high). Record `risk: low|high` with a one-line reason. When unsure, high.
5. Hotspot files: list the files likely to be touched by other tasks too (routes, registries, schema, shared config). `/devflow:dispatch` uses them to put tasks that share a hotspot in the same lane, so list real file paths.
6. Extract shared groundwork (auth, schema, layout or config) into a small foundation task. Add a `Depends on` line only when a task calls or imports another task's code or uses a schema or file it creates. A shared topic or preferred work order alone does not justify a dependency.

### F2. Test matrix (QA)

Skip this step when `spec.testMatrix` is `false` in the config; each task keeps its own test plan. Otherwise it runs by default.

A separate QA agent turns the acceptance criteria into a test matrix. It works from the written spec only, like a QA engineer who was not in the meeting with the client, so it tests what the spec says, not what was meant. Its main job is to find criteria that cannot be tested as written and cases the spec does not cover.

1. Use the Agent tool (general-purpose) with `model` set to `spec.qaModel` (default `opus`). Give it only: the path of the spec file, the project's `CLAUDE.md` (for test conventions and levels), and these instructions:
   - Read the spec. For every acceptance criterion of every task, write test cases: happy path, errors, edge cases and boundaries the criterion implies. One row each: id `<task>.<n>`, task, criterion, case (happy | error | edge | boundary), Given / When / Then with concrete inputs and the observable result, level (unit | integration | http | e2e; use e2e only for tasks with needs-e2e yes), priority (must | should). Every criterion gets at least one must row.
   - Escape `|` inside table cells as `\|`.
   - Name the convention for traceability in the rows' notes: a test for row `T1.2` is named `test_t<task>_<n>_<description>` (for example `test_t1_2_duplicate_name_returns_409`), or carries the comment `# T1.2` where names cannot hold it. In other languages use the same idea with the language's naming style.
   - A row that can be checked only against branch state (a diff against the base branch, the current branch name, unpushed commits, the current date) is listed as a review check, not a test row: tests must not depend on branch state.
   - List every criterion that cannot be turned into a test as written (vague, unmeasurable, contradicts another part of the spec), with the problem and the question that would settle it.
   - List cases the spec does not decide but a tester would hit (for example a deleted or missing parent record, an empty body, a duplicate, a limit), with the question to ask.
   - Do not edit any file. Return the rows, the untestable criteria and the missing cases.
2. If there are untestable criteria or missing cases, ask the user about them one at a time, each with your recommended answer, as in step 2. Update the spec (criteria, decisions, design) with the answers, then run the QA agent again on the updated spec. At most 2 QA rounds: after that, list anything still open under **Risks and unknowns**.
3. Write the final rows into the spec's **Test matrix** table. In each task, set the test plan to `Test cases: T<n>.1-T<n>.<k> (see Test matrix)`, keeping any note the table cannot hold.

**Checkpoint:** report the number of rows (must and should), the questions the QA step raised, how many were resolved, and what is still open.

### F3. Spec review

Run the spec review defined in "Review of the draft (both modes)" below on the spec file, before the spec PR. Fix the spec for each critical finding. A question the review raises that the user defers goes into the spec's `Risks and unknowns`.

### F4. Spec PR

Commit with `docs(spec): <title>` (stage the files by name). Push the branch and open a PR to `baseBranch` titled `spec: <title>`; body = summary, a task table with columns task id, title, depends-on, size, risk and risk reason, and when F2 ran, one line with the test matrix size and the QA questions resolved and still open. No need to ask before pushing the spec branch or opening this PR.

### F5. Gate 1

Ask exactly one question with AskUserQuestion: "Spec PR <url> merged? Merging also approves the risk levels in its table." with options: merged, changes requested, abandon.

- **Changes requested:** read the PR review comments, update the spec on the same branch, commit, push, ask again.
- **Abandon:** close nothing; stop.
- **Merged:** verify through the GitHub MCP server that the PR is merged. If it is not, say so and ask again.

### F6. Issues

Run only after the PR is verified merged.

1. For each task, search existing issues for its title first (open and closed). Skip tasks that already have an issue, so re-running after a partial failure is safe.
2. Create issues in dependency order, so `Depends on` lines can use real numbers. For each task fill `${CLAUDE_SKILL_DIR}/templates/issue.md`:
   - Title: `[<slug>] T<n>: <task title>`.
   - Body: link to the spec file on `baseBranch`, acceptance criteria as a checklist, scope, test cases (the task's rows of the Test matrix, copied as they are; if the spec has no Test matrix, the task's test plan as a list), and one `Depends on #<n>` line per dependency (resolve task ids to issue numbers).
   - Labels: `labels.ready` (this mode only, after any required human step), plus `labels.riskLow` or `labels.riskHigh` per the task's risk, plus `labels.e2e` when the task needs e2e, plus `type:<type>`. Adding a missing label creates it.
   - If a human must act before work starts, write a standalone `Ready: manual` line, explain the step in Context and leave the ready label for the human to add afterwards.
   - Fill the template's Risk line (level and reason), Hotspots and `## Open questions` (the deferred questions that affect the task, from the spec's Risks and unknowns, else `None`).
3. Comment on the spec PR with the list of created issues.
4. Then the final message below.

## Review of the draft (both modes)

The spec review runs in both modes, after the QA step and before any issue is created (epic mode) or the spec PR is opened (`--file` mode). It is not the QA step: QA writes the test rows and lists criteria that cannot be tested; the spec review checks the draft against the user's brief only and does not judge testability.

1. Use the Agent tool (general-purpose) with `model` set to `spec.qaModel` (default `opus`; no separate config key). A fresh agent: give it only the brief (the idea or the brief file) and the path of the draft or spec file, not the grill conversation.
2. It reads the draft against the brief and reports findings of three kinds:
   - missing requirement: something the brief asks for that no task or criterion covers;
   - contradiction: two parts of the draft that disagree, or a part that disagrees with the brief;
   - not independent: a task that claims independence (no depends-on) but needs another task's result.
   Each finding is `critical`, `warning` or `suggestion`. It does not edit any file.
3. Only critical findings start another round: fix the draft (asking the user when the fix is a decision), then run the review again. At most 2 reviewer calls in total (the first review plus one after a fix). After the second, list the remaining critical findings to the user, who chooses to proceed or stop.
4. Warnings and suggestions are shown to the user once and never start a round.
5. For each task with 3 or more dependents, show a warning in the draft summary naming the task and its dependents. Suggest extracting shared groundwork into a foundation task. The warning never blocks review and needs no answer.

## Final message

A table of task id, issue number and title, plus the epic number in epic mode and any link that failed.

- Epic mode: explain that the human can set the ready label on each sub-issue or use `/devflow:approve #<epic>` when `spec.autoReady` is enabled. Next-task picks up issues with the ready label.
- `--file` mode: report which issues already carry `labels.ready` and which need the human step first.
