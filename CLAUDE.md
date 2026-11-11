# devflow

Claude Code plugin: spec-to-PR workflow. DESIGN.md is the source of truth for behaviour; README.md is the user guide.

## Architecture
- `skills/<name>/SKILL.md` — slash commands; `skills/init/templates/` — files installed into projects.
- `workflows/next-task-engine.js` — the next-task engine workflow.
- `hooks/` — plugin hooks (`guard.py`, `formatter.py`, `session_start.py`), Python ≥ 3.9, stdlib only.
- `bin/` — Node CLIs (`devflow-setup`, `devflow-scan`, `devflow-lanes`), no npm dependencies.
- `.github/workflows/devflow-review.yml`, `devflow-merge-gate.yml` — reusable workflows (`workflow_call`) that
  project callers pin by tag. Changing them changes behaviour for every reusable-mode project at the next tag.
- `agents/reviewer.md` — the `devflow:reviewer` agent.
- A behaviour change updates code, DESIGN.md, README.md and (when user-visible) CHANGELOG.md together.
- Config keys: schema in `skills/init/templates/devflow.schema.json`, annotated example in `devflow.json` beside it; keep both in sync.

## Conventions
- English. Conventional Commits. Work on an issue (devflow runs included) uses the issue as scope, as `commitScope` says: `fix(#12): …`, `test(#12): …`. Work without an issue uses the area: `docs(scan): …`, `chore(release): X.Y.Z`.
- Small commits: code, tests and docs as separate commits in one PR.
- SemVer; CHANGELOG follows Keep a Changelog. The version in `plugin.json`, `marketplace.json`, the init template, README, DESIGN.md, the flows page and the changelog must agree (`tests/version.test.cjs`).
- New config keys are optional with a default; existing configs must stay valid.

## Tests
- Node: `node --test tests/*.test.cjs` (`node:test` + `node:assert`, one `<area>.test.cjs` per bin/workflow).
- Hooks: `python3 -m unittest discover -s hooks -p 'test_*.py' -v` (`unittest`, files `hooks/test_*.py`).
- Every fix adds a test that fails without it; guard and scan rules get a case for both the blocked and the allowed form.

## Never
- Weaken the guard to make a test pass; the guard fails closed.
- Add runtime dependencies (npm or pip) to hooks or bin.
- Edit a published tag or change a reusable workflow's inputs/secrets incompatibly within a minor version.
- Let Claude merge PRs; only the merge gate Action merges, and only risk:low.
