<!--
PR body filled from the workflow stage results. Keep every heading; write "None" for an empty section.
Title: <type>(<scope>): <summary>. Never write the at-sign handle of the review bot into the body.
-->

## What

<!-- One or two sentences on the user-visible change. -->

## How

<!-- The approach, and why it is the smallest change that satisfies the acceptance criteria. -->

## Risk

<!-- One line: "Risk: low|high - <reason>". Low PRs are merged by the merge gate when it is enabled and its checks are green; high PRs wait for a human. -->

Risk: 

<!-- Only when the PR is stacked on other open PRs, one line listing every parent. One parent: "Stacked on #<pr> (<branch>); it retargets to <base> when that PR merges." Several parents: "Stacked on #<pr> (<branch>) and #<pr> (<branch>); merged into this branch at <short sha>. The merge gate waits until every dependency is closed." Otherwise delete this comment. -->

## Tests

<!-- Test name: what it proves. State which tests were committed first and failed for the right reason. When the issue has a Test cases table, start each line with the row id it covers (e.g. "T1.2 test_name: ..."), and list any "must" row without a test. -->

- 

## Checks

<!-- Each configured check and its result. -->

| Check | Result |
| --- | --- |
|  |  |

## Verification

<!-- Evidence from running the app: mode (http or browser), each acceptance criterion, expected vs actual. Write "Not run: <reason>" if it was skipped. -->

## Review notes

<!-- Suggestions from the automated review that were not applied, with severity. "None" if empty. -->

## Assumptions

<!-- Decisions made on minor ambiguity that the spec did not answer. "None" if empty. -->

## Out of scope

<!-- Related problems noticed but not changed. "None" if empty. Never an acceptance criterion of the linked issue: those are in scope. Each real problem is filed as a follow-up issue labelled needs-triage and listed as "- <item>: #<number>"; remarks stay as plain text. -->

Closes #<issue>
