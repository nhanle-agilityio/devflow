<!--
Release smoke fixture (risk:high). Create one issue in the sandbox repository with this body, the title
"smoke: high X.Y.Z" and the labels risk:high and the ready label. See "Release process" in CHANGELOG.md.
Expected: the run opens a PR labelled risk:high that the merge gate never merges (a human may), then
`node bin/devflow-smoke --repo <owner>/devflow-sandbox --issue <n> --expect high` passes.
-->

## Context

Release smoke run for a devflow release candidate: a change declared high risk, so only a human merges it.

## Risk

Risk: high - smoke fixture for the human-merge path, declared high on purpose

## Acceptance criteria

- [ ] The file `smoke/high-<issue number>.md` exists and holds the single line `smoke high <issue number>`.

## Scope

- `smoke/high-<issue number>.md` (new). Nothing else.

## Hotspots

- None

## Test cases

| Id | Criterion | Case | Given / When / Then | Level | Priority |
| --- | --- | --- | --- | --- | --- |
| S2.1 | File content | happy | Given the branch. When `smoke/high-<issue number>.md` is read. Then it is the single line `smoke high <issue number>`. | manual | must |

## Open questions

None
