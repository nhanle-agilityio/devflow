---
name: spec
description: Turn an idea into an analysed, grilled spec PR with a task list and a QA test matrix, wait for a human to merge it (Gate 1), then create one labelled GitHub issue per task.
argument-hint: <idea, or path to a brief>
disable-model-invocation: true
---

# /devflow:spec

Idea: $ARGUMENTS

Designed for a cloud session on the repo; works locally too. Rules for this skill: all committed content is in English; no `Co-Authored-By` or AI attribution in commits or PRs; never write the review bot's at-sign handle into issues or PRs; use the GitHub MCP server for GitHub operations (load its tools with ToolSearch). Never merge anything.

If `$ARGUMENTS` is empty, ask for the idea. If it is a path, read that file as the brief.

Follow the steps in order. Announce each by number.

## 1. Analyse

- Read `.claude/devflow.json` (if missing, tell the user to run `/devflow:init` and stop) and `CLAUDE.md`.
- Read the code the idea touches.
- Produce a short analysis: current behaviour, affected areas (backend, frontend, infra, data), risks, unknowns.
- Do not write any file yet.

## 2. Grill

- Invoke the `grill-me` skill on the idea plus your analysis.
- Continue until every unknown is decided or explicitly deferred.
- If `grill-me` is not available, run the same interview inline: one question at a time, each with your recommended answer.

**Checkpoint:** list the decisions and deferrals. Proceed only when none is open.

## 3. Spec and tasks

1. Pick a kebab-case `<slug>` (at most 5 words). Create branch `spec/<slug>` from `<remote>/<baseBranch>` (`git fetch` first).
2. Copy `${CLAUDE_SKILL_DIR}/templates/spec.md` and fill it into `<specDir>/<YYYY-MM-DD>-<slug>.md`: problem, goals and non-goals, decisions (with the grill answers), design (API contracts, data model, UI screens and states; mocks go in `<specDir>/<slug>/`), risks, and the task list.
3. Each task has: stable id `T1..Tn`, title, type, area, depends-on, acceptance criteria as checkable behaviour (API: request then response; UI: user action then visible result), files and areas in scope, test plan, needs-e2e yes/no, size S or M, risk and hotspot files. Split anything bigger than M.
4. Risk: judge each task against `risk.highWhen` and `risk.highPaths` in the config (the defaults apply when unset; a task whose scope matches a `highPaths` glob is high). Record `risk: low|high` with a one-line reason. When unsure, high.
5. Hotspot files: list the files likely to be touched by other tasks too (routes, registries, schema, shared config). `/devflow:dispatch` uses them to put tasks that share a hotspot in the same lane, so list real file paths.

## 4. Test matrix (QA)

Skip this step when `spec.testMatrix` is `false` in the config; each task keeps its own test plan. Otherwise it runs by default.

A separate QA agent turns the acceptance criteria into a test matrix. It works from the written spec only, like a QA engineer who was not in the meeting with the client, so it tests what the spec says, not what was meant. Its main job is to find criteria that cannot be tested as written and cases the spec does not cover.

1. Use the Agent tool (general-purpose) with `model` set to `spec.qaModel` (default `opus`). Give it only: the path of the spec file, the project's `CLAUDE.md` (for test conventions and levels), and these instructions:
   - Read the spec. For every acceptance criterion of every task, write test cases: happy path, errors, edge cases and boundaries the criterion implies. One row each: id `<task>.<n>`, task, criterion, case (happy | error | edge | boundary), Given / When / Then with concrete inputs and the observable result, level (unit | integration | http | e2e; use e2e only for tasks with needs-e2e yes), priority (must | should). Every criterion gets at least one must row.
   - Escape `|` inside table cells as `\|`.
   - Name the convention for traceability in the rows' notes: a test for row `T1.2` is named `test_t<task>_<n>_<description>` (for example `test_t1_2_duplicate_name_returns_409`), or carries the comment `# T1.2` where names cannot hold it. In other languages use the same idea with the language's naming style.
   - List every criterion that cannot be turned into a test as written (vague, unmeasurable, contradicts another part of the spec), with the problem and the question that would settle it.
   - List cases the spec does not decide but a tester would hit (for example a deleted or missing parent record, an empty body, a duplicate, a limit), with the question to ask.
   - Do not edit any file. Return the rows, the untestable criteria and the missing cases.
2. If there are untestable criteria or missing cases, ask the user about them one at a time, each with your recommended answer, as in step 2. Update the spec (criteria, decisions, design) with the answers, then run the QA agent again on the updated spec. At most 2 QA rounds: after that, list anything still open under **Risks and unknowns**.
3. Write the final rows into the spec's **Test matrix** table. In each task, set the test plan to `Test cases: T<n>.1-T<n>.<k> (see Test matrix)`, keeping any note the table cannot hold.

**Checkpoint:** report the number of rows (must and should), the questions the QA step raised, how many were resolved, and what is still open.

## 5. Spec PR

Commit with `docs(spec): <title>` (stage the files by name). Push the branch and open a PR to `baseBranch` titled `spec: <title>`; body = summary, a task table with columns task id, title, depends-on, size, risk and risk reason, and when step 4 ran, one line with the test matrix size and the QA questions resolved and still open. No need to ask before pushing the spec branch or opening this PR.

## 6. Gate 1

Ask exactly one question with AskUserQuestion: "Spec PR <url> merged? Merging also approves the risk levels in its table." with options: merged, changes requested, abandon.

- **Changes requested:** read the PR review comments, update the spec on the same branch, commit, push, ask again.
- **Abandon:** close nothing; stop.
- **Merged:** verify through the GitHub MCP server that the PR is merged. If it is not, say so and ask again.

## 7. Issues

Run only after the PR is verified merged.

1. For each task, search existing issues for its title first (open and closed). Skip tasks that already have an issue, so re-running after a partial failure is safe.
2. Create issues in dependency order, so `Depends on` lines can use real numbers. For each task fill `${CLAUDE_SKILL_DIR}/templates/issue.md`:
   - Title: `[<slug>] T<n>: <task title>`.
   - Body: link to the spec file on `baseBranch`, acceptance criteria as a checklist, scope, test cases (the task's rows of the Test matrix, copied as they are; if the spec has no Test matrix, the task's test plan as a list), and one `Depends on #<n>` line per dependency (resolve task ids to issue numbers).
   - Labels: `labels.ready`, plus `labels.riskLow` or `labels.riskHigh` per the task's risk, plus `labels.e2e` when the task needs e2e, plus `type:<type>`. Adding a missing label creates it.
   - Fill the template's Risk line (level and reason) and Hotspots.
3. Comment on the spec PR with the list of created issues.
4. Final message: a table of task id, issue number and title.
