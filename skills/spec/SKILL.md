---
name: spec
description: Turn an idea into an analysed, grilled spec PR with a task list, wait for a human to merge it (Gate 1), then create one labelled GitHub issue per task.
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
3. Each task has: stable id `T1..Tn`, title, type, area, depends-on, acceptance criteria as checkable behaviour (API: request then response; UI: user action then visible result), files and areas in scope, test plan, needs-e2e yes/no, size S or M. Split anything bigger than M.
4. Commit with `docs(spec): <title>` (stage the files by name). Push the branch and open a PR to `baseBranch` titled `spec: <title>`; body = summary plus a task table (id, title, depends-on, size). No need to ask before pushing the spec branch or opening this PR.

## 4. Gate 1

Ask exactly one question with AskUserQuestion: "Spec PR <url> merged?" with options: merged, changes requested, abandon.

- **Changes requested:** read the PR review comments, update the spec on the same branch, commit, push, ask again.
- **Abandon:** close nothing; stop.
- **Merged:** verify through the GitHub MCP server that the PR is merged. If it is not, say so and ask again.

## 5. Issues

Run only after the PR is verified merged.

1. For each task, search existing issues for its title first (open and closed). Skip tasks that already have an issue, so re-running after a partial failure is safe.
2. Create issues in dependency order, so `Depends on` lines can use real numbers. For each task fill `${CLAUDE_SKILL_DIR}/templates/issue.md`:
   - Title: `[<slug>] T<n>: <task title>`.
   - Body: link to the spec file on `baseBranch`, acceptance criteria as a checklist, scope, test plan, and one `Depends on #<n>` line per dependency (resolve task ids to issue numbers).
   - Labels: `labels.ready`, plus `labels.e2e` when the task needs e2e, plus `type:<type>`. Adding a missing label creates it.
3. Comment on the spec PR with the list of created issues.
4. Final message: a table of task id, issue number and title.
