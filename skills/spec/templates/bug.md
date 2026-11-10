<!--
Body of a bug issue: a gap found by /devflow:accept, an out-of-scope problem filed by /devflow:next-task's Ship
stage, or a bug a person asks Claude to file. Title: "[<slug>] Gap: <criterion>" (accept), "[follow-up #<n>] <summary>"
(Ship) or "fix: <summary>" (by hand).
Labels: labels.triage (default needs-triage) only, plus accept.labels for gaps. Never the ready label, never a
priority or risk label: a human triages the issue and sets them. Claude may suggest a priority and a risk in a
comment, each with a one-line reason.
Write "unknown" or "None" where there is nothing to say; keep every heading. English only. Never write the at-sign
handle of the review bot into the body.
-->

## Context

<!-- Where it was found (spec link and criterion, the issue and PR being worked on, or who reported it) and why it matters. -->

## Expected

<!-- The behaviour the spec, the acceptance criteria or the user expects. Quote the criterion id when there is one (e.g. AC2.5). -->

## Actual

<!-- What happens instead, with evidence: request and response, the visible result, an error, a log line. -->

## Repro

<!-- Numbered steps from a clean checkout of the base branch, or a failing command. -->

1. 

## Introduced by

<!-- The PR, commit or acceptance criterion that introduced it (e.g. "PR #54, AC2.5 left as is"), or "unknown". -->

## Risk

<!-- Suggested only: a human sets the risk label. "low" or "high" against risk.highWhen / risk.highPaths; unsure means high. -->

Risk: <low | high> - <reason>

## Acceptance criteria

<!-- Checkable behaviour that proves the bug is fixed. -->

- [ ] 

## Scope

<!-- Files and areas the fix may touch. -->

- 

## Test cases

<!-- At least one "must" row that reproduces the bug; the failing test is committed first. -->

| Id | Criterion | Case | Given / When / Then | Level | Priority |
| --- | --- | --- | --- | --- | --- |
| T1.1 |  | regression |  |  | must |

## Dependencies

<!-- One line per dependency, or "None". -->

None
