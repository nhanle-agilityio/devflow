---
name: report
description: Build a demo-ready trace page of one spec - ticket, plan, PR, review, tests, merge, acceptance, release - for every issue, from GitHub data, and publish it as an artifact. Read-only on the repository.
argument-hint: <spec path or slug>
disable-model-invocation: true
---

# /devflow:report

Arguments: $ARGUMENTS

Shows the flow, not slides: for each issue of a spec, the path ticket, plan, PR, review, tests, merged, accepted, released, with who acted at each step and a link to the evidence. Rules: use the GitHub MCP server for every GitHub read (load its tools with ToolSearch); `gh` only if MCP is unavailable. This skill only reads GitHub and the repository, and posts nothing on GitHub. Never merge, never push. Everything written is English. Never write the review bot's at-sign handle in the page. Follow `.claude/devflow.json`.

## 0. Preflight

1. `.claude/devflow.json` exists and parses as JSON; else tell the user to run `/devflow:init`.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. `git fetch <remote> <baseBranch>` succeeds.
4. `$ARGUMENTS` names a spec (path under `specDir`, default `docs/specs`, or a slug). If empty, list the specs on the base branch and ask. Read it with `git show <remote>/<baseBranch>:<specDir>/<file>`; if it is not on the base branch, say the spec PR is not merged and stop.

## 1. Collect

Gather everything with the GitHub MCP server. Use `null` for what does not exist; never invent a value.

- **Spec PR**: the PR that added the spec file: number, url, merged at, who merged it (this is Gate 1) and whether the merger is the merge gate (a bot or the `DEVFLOW_GATE_TOKEN` owner) or a human.
- **Issues**: those whose body links the spec file: number, url, title, labels, risk (`labels.riskLow` or `labels.riskHigh`; none means `unknown`).
- **Plan**: the comment starting with `<!-- devflow-plan -->`: url and its first 3 lines.
- **Questions**: the comment starting with `<!-- devflow-questions -->`: url, number of questions, whether human answers followed (a later human comment, or a `## Decisions` section in the issue body) and the answer link. The blocked label on an issue with unanswered questions means `blocked`.
- **PR**: the PR that closes the issue: number, url, base branch, stacked or not (`labels.stacked` or base other than `baseBranch`), state, merged at, merged by and whether by the gate or a human.
- **Review**: the `devflow/review` commit status on the PR head (success, failure, pending) with its description, the number of review rounds (count of distinct head SHAs that got a `devflow-verdict` marker in the bot summary comments, at least 1 when a verdict exists) and the url of the bot summary comment.
- **Tests**: from the PR diff the test files changed and the number of test functions added or changed (by the project's test naming), and the Test matrix row ids covered (from the PR body, else the `T<n>.<k>` ids found in test names or comments).
- **Commits** in order (sha, message) and whether the first commit of the PR is a `test(...)` commit (`testFirst`).
- **Acceptance**: the comment starting with `<!-- devflow-accept -->` on the spec PR, with its pass, fail and not-checkable counts and, per issue, the result when the table names it.
- **Release**: the release whose notes mention the PR, or the latest release tag after the PRs merged: tag, url, draft.

## 2. Build the data

Make one JSON object with exactly this shape (the template reads it; every key is required, use `null` or `[]` when empty):

```json
{
  "generatedAt": "2026-11-03T10:00:00Z",
  "spec": { "slug": "", "title": "", "path": "", "url": "", "pr": { "number": 0, "url": "", "mergedAt": "", "mergedBy": "", "byGate": false } },
  "acceptance": { "url": "", "pass": 0, "fail": 0, "notCheckable": 0 },
  "release": { "tag": "", "url": "", "draft": false },
  "issues": [
    {
      "number": 0, "url": "", "title": "", "labels": [""], "risk": "low",
      "plan": { "url": "", "excerpt": "" },
      "questions": { "url": "", "count": 0, "answered": false, "answerUrl": "" },
      "blocked": false,
      "pr": { "number": 0, "url": "", "base": "", "stacked": false, "state": "merged", "mergedAt": "", "mergedBy": "", "byGate": false },
      "review": { "state": "success", "description": "", "rounds": 1, "url": "" },
      "tests": { "files": [""], "count": 0, "rows": [""], "testFirst": true },
      "commits": [ { "sha": "", "message": "" } ],
      "accepted": { "result": "pass", "url": "" }
    }
  ]
}
```

`risk` is `low`, `high` or `unknown`. `pr.state` is `merged`, `open` or `closed`. `review.state` is `success`, `failure`, `pending` or `none`. `accepted.result` is `pass`, `fail` or `na`. Dates are ISO 8601. Keep all text values plain (no markup).

## 3. Render

1. Read `${CLAUDE_SKILL_DIR}/templates/trace.html`. Replace the literal text `{{TRACE_JSON}}` (inside `<script type="application/json" id="data">`) with the JSON, after replacing every `</` in it with `<\/` and every `<!--` with `<\!--`. Change nothing else in the template.
2. Write the result to a scratch file (the session's scratchpad directory) named `<slug>.trace.html`.
3. Publish it with the Artifact tool: load the `artifact-design` skill first when the Artifact tool asks for it, title `<slug> trace`, an icon such as `timeline`, a one-sentence description. If the user gave an existing artifact URL, pass it as `url` to update that artifact in place. The page makes network requests only to Google Fonts.
4. Save it to `<specDir>/<slug>.trace.html` in the repository only if the user asks; this skill makes no commit.

## 4. Report

Give the artifact link and a short summary: issues, PRs merged by the gate versus by a human, blocked issues, review rounds, whether acceptance and a release were found, and any step that had no data (shown grey on the page). Say that the page reads the same data whenever it is opened, and that running the command again with the same URL refreshes it.
