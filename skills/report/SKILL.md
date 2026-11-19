---
name: report
description: Build a demo-ready trace page of one spec - ticket, plan, PR, review, tests, merge, acceptance, release - for every issue, from GitHub data, and publish it as an artifact. Read-only on the repository.
argument-hint: <spec path, slug or #epic>
disable-model-invocation: true
---

# /devflow:report

Arguments: $ARGUMENTS

Shows the flow, not slides: for each issue of a spec or epic, the path ticket, plan, PR, review, tests, merged, accepted, released, with who acted at each step and a link to the evidence, plus five metrics per issue (path, review rounds, times blocked, duration, merged by; `claimedAt` and `mergedAt` stay in the data only). Rules: use the GitHub MCP server for every GitHub read (load its tools with ToolSearch); `gh` only if MCP is unavailable. This skill only reads GitHub and the repository, and posts nothing on GitHub. Never merge, never push. Everything written is English. Never write the review bot's at-sign handle in the page. Follow `.claude/devflow.json`.

**Merged state:** never trust a `merged` field from a PR list or search result; the GitHub MCP list tools report `merged: false` for merged PRs. A PR is merged when `pull_request_read` (method `get`) returns a non-null `merged_at`, or when `git merge-base --is-ancestor <head sha> <remote>/<baseBranch>` succeeds after a fetch. Closed with neither: closed without merging. Take "merged by" and "merged at" from `pull_request_read`, not from a list.

## 0. Preflight

1. `.claude/devflow.json` exists and parses as JSON; else tell the user to run `/devflow:init`.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. `git fetch <remote> <baseBranch>` succeeds.
4. `$ARGUMENTS` is `#<n>` (an epic issue, see Epic mode) or names a spec (path under `specDir`, default `docs/specs`, or a slug). If empty, list the specs on the base branch and ask. Read it with `git show <remote>/<baseBranch>:<specDir>/<file>`; if it is not on the base branch, say the spec PR is not merged and stop.

**Epic mode** (`#<n>`): a number is always an issue number. The issues are the union of the epic's native sub-issues and the issues whose body has the line `Epic: #<n>`, as `/devflow:accept` does; an issue with neither stops with `#<n> is not an epic`. There is no spec file and no spec PR: `spec.epic` is `{ "number", "url" }`, `spec.pr` is `null`, `spec.path` and `spec.url` are the epic's, `spec.slug` is the slug from `[<slug>]` in the epic title, else `epic-<n>`, and acceptance is the `<!-- devflow-accept -->` comment on the epic. With a spec path or slug, `spec.epic` is `null`.

## 1. Collect

Gather everything with the GitHub MCP server. Use `null` for what does not exist; never invent a value.

- **Spec PR** (spec mode only; `null` in epic mode): the PR that added the spec file: number, url, merged at, who merged it (this is Gate 1) and whether the merger is the merge gate or a human, by the who-merged rule below.
- **Issues**: those whose body links the spec file: number, url, title, labels, risk (`labels.riskLow` or `labels.riskHigh`; none means `unknown`).
- **Plan**: the comment starting with `<!-- devflow-plan -->`: url and its first 3 lines.
- **Questions**: the comment starting with `<!-- devflow-questions -->`: url, number of questions, whether human answers followed (a later human comment, or a `## Decisions` section in the issue body) and the answer link. The blocked label on an issue with unanswered questions means `blocked`.
- **PR**: the merged PR that closes the issue, else the latest one that closes it: number, url, base branch, stacked or not (`labels.stacked` or base other than `baseBranch`), state, merged at, merged by and whether by the gate or a human, by the who-merged rule below.
- **Review**: the `devflow/review` commit status on the PR head (success, failure, pending) with its description, the number of review rounds (count of distinct head SHAs that got a `devflow-verdict` marker in the bot summary comments, at least 1 when a verdict exists) and the url of the bot summary comment; with a `devflow/review` status the status is used; with no `devflow/review` status (a run without the review workflow), read the PR's `## Review` section and the `devflow-run` marker: `review.state` is `success` and `review.description` is "local review: pass, N round(s)", or `failure` and "local review: fail, N round(s)", N from the marker's `reviewRounds`, else the verdict-marker count; write the literal `round(s)`, never a singular or plural chosen by the count. Without a `## Review` section either, the state is `none`.
- **Steps shown as skipped or missing**: on the short path, Plan and Verify show "skipped (short path)" in a neutral style, not grey, since the path never runs them. On the full path Plan, Review, Checks and Verify (Verify only when `verify` is configured) should exist and are grey when missing. The template draws this from `metrics.path`, `plan`, `review`, `checks`, `verify` and the top-level `verifyConfigured`: `checks` and `verify` are `{ "url": "" }` when the PR shows a checks or verify result (the PR body's Checks and Verify sections), else `null`; `verifyConfigured` is true when the project config has `verify`.
- **Tests**: from the PR diff the test files changed and the number of test functions added or changed (by the project's test naming), and the Test matrix row ids covered (from the PR body, else the `T<n>.<k>` ids found in test names or comments).
- **Commits** in order (sha, message) and whether the first commit of the PR is a `test(...)` commit (`testFirst`).
- **Acceptance**: the comment starting with `<!-- devflow-accept -->` on the spec PR, with its pass, fail and not-checkable counts and, per issue, the result when the table names it.
- **Metrics** per issue, from the PR used above and the issue comments; never invent a value:
  - `path` (`short`, `full`) and `claimedAt` from the hidden `<!-- devflow-run {...} -->` marker in the PR body; `unknown` / `null` when absent.
  - `reviewRounds` from the same marker; else the verdict-marker count of the Review item; else `null`.
  - `blocked`: the number of issue comments containing `<!-- devflow-blocked -->`.
  - `mergedAt` from `pull_request_read` (`null` when not merged); `mergedBy` is `gate`, `human` or `unknown` by the who-merged rule below.
  - `durationHours`: `claimedAt` to `mergedAt` in hours, one decimal; `null` when either is missing.
- **Release**: the release whose notes mention the PR, or the latest release tag after the PRs merged: tag, url, draft.

**Who merged** (for `byGate` of the spec PR and of each issue PR): `byGate` is true when the PR has a comment starting with `<!-- devflow-gate-merged -->` or its merge commit message contains `Merged-by: devflow merge gate`; `mergedByKnown` is true. `mergedBy` is `gate` when the PR has a `<!-- devflow-gate-merged -->` comment or its merge commit has the `Merged-by: devflow merge gate` trailer; otherwise `human` when the PR body has a `devflow-run` marker (a devflow PR without gate evidence was merged by a person), with `byGate` false and `mergedByKnown` true; otherwise the 3.0.0 rule below, which gives `human` when a user other than the gate token owner merged it, else `unknown`. The 3.0.0 rule, for a PR without marker or gate evidence: when `merged_by` equals the gate token owner (the authenticated user), set `byGate` false and `mergedByKnown` false (the gate and the owner look the same); when a different user merged it, set `byGate` false and `mergedByKnown` true.

## 2. Build the data

Make one JSON object with exactly this shape (the template reads it, and a page built from data without `spec.epic` or `metrics` still renders; every key is required, use `null` or `[]` when empty):

```json
{
  "generatedAt": "2026-11-03T10:00:00Z",
  "spec": { "slug": "", "title": "", "path": "", "url": "", "epic": { "number": 0, "url": "" }, "pr": { "number": 0, "url": "", "mergedAt": "", "mergedBy": "", "byGate": false, "mergedByKnown": true } },
  "acceptance": { "url": "", "pass": 0, "fail": 0, "notCheckable": 0 },
  "release": { "tag": "", "url": "", "draft": false },
  "verifyConfigured": false,
  "issues": [
    {
      "number": 0, "url": "", "title": "", "labels": [""], "risk": "low",
      "plan": { "url": "", "excerpt": "" },
      "questions": { "url": "", "count": 0, "answered": false, "answerUrl": "" },
      "blocked": false,
      "pr": { "number": 0, "url": "", "base": "", "stacked": false, "state": "merged", "mergedAt": "", "mergedBy": "", "byGate": false, "mergedByKnown": true },
      "review": { "state": "success", "description": "", "rounds": 1, "url": "" },
      "checks": { "url": "" },
      "verify": { "url": "" },
      "tests": { "files": [""], "count": 0, "rows": [""], "testFirst": true },
      "commits": [ { "sha": "", "message": "" } ],
      "accepted": { "result": "pass", "url": "" },
      "metrics": { "path": "short", "reviewRounds": 1, "blocked": 0, "claimedAt": "2026-11-03T08:00:00Z", "mergedAt": "2026-11-03T09:30:00Z", "durationHours": 1.5, "mergedBy": "gate" }
    }
  ]
}
```

`spec.epic` is `null` for a spec file; `spec.pr` is `null` in epic mode. `metrics.path` is `short`, `full` or `unknown`; `metrics.mergedBy` is `gate`, `human` or `unknown`; `reviewRounds`, `claimedAt`, `mergedAt` and `durationHours` are `null` when missing. `risk` is `low`, `high` or `unknown`. `pr.state` is `merged`, `open` or `closed`. `review.state` is `success`, `failure`, `pending` or `none`. `accepted.result` is `pass`, `fail` or `na`. Dates are ISO 8601. Keep all text values plain (no markup).

## 3. Render

1. Read `${CLAUDE_SKILL_DIR}/templates/trace.html`. Replace the literal text `{{TRACE_JSON}}` (inside `<script type="application/json" id="data">`) with the JSON, after replacing every `</` in it with `<\/` and every `<!--` with `<\!--`. Change nothing else in the template.
2. Write the result to a scratch file (the session's scratchpad directory) named `<slug>.trace.html`.
3. Publish it with the Artifact tool: load the `artifact-design` skill first when the Artifact tool asks for it, title `<slug> trace`, an icon such as `timeline`, a one-sentence description. If the user gave an existing artifact URL, pass it as `url` to update that artifact in place. The page makes network requests only to Google Fonts.
4. Save it to `<specDir>/<slug>.trace.html` in the repository only if the user asks; this skill makes no commit.

## 4. Report

Give the artifact link and a short summary: issues, PRs merged by the gate versus by a human, blocked issues, review rounds, whether acceptance and a release were found, and any step that had no data (shown grey on the page). Say that the page reads the same data whenever it is opened, and that running the command again with the same URL refreshes it.
