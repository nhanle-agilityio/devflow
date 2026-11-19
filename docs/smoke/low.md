<!--
Release smoke fixture (risk:low). Create one issue in the sandbox repository with this body, the title
"smoke: low X.Y.Z" and the labels risk:low and the ready label. See "Release process" in CHANGELOG.md.
Expected: the run ships it on the short path and the merge gate merges the PR, then
`node bin/devflow-smoke --repo <owner>/devflow-sandbox --issue <n> --expect low` passes.
-->

## Context

Release smoke run for a devflow release candidate: a small, low-risk change that the merge gate may merge.

## Risk

Risk: low - one new text file, no code and no configuration

## Acceptance criteria

- [ ] The file `smoke/low-<issue number>.md` exists and holds the single line `smoke low <issue number>`.

## Scope

- `smoke/low-<issue number>.md` (new). Nothing else.

## Hotspots

- None

## Test cases

| Id | Criterion | Case | Given / When / Then | Level | Priority |
| --- | --- | --- | --- | --- | --- |
| S1.1 | File content | happy | Given the branch. When `smoke/low-<issue number>.md` is read. Then it is the single line `smoke low <issue number>`. | manual | must |

## Open questions

None
