#!/usr/bin/env python3
"""SessionStart hook for the devflow plugin: give Claude the project's devflow workflow rules.

Reads `.claude/devflow.json` from `$CLAUDE_PROJECT_DIR` and prints, on stdout, the JSON
`{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<rules>"}}`, which
Claude Code adds to the session context. Silent (no output, exit 0) when the project has no
devflow.json or it cannot be parsed, so projects without devflow are untouched. Stdlib only, Python 3.9.
"""

import json
import os
import sys


def rules(config):
    """The rules text built from a parsed devflow.json."""
    pattern = config.get("branchPattern") or "{type}/{issue}-{slug}"
    scope = (config.get("commitScope") or "#{issue}").replace("{issue}", "12")
    base = config.get("baseBranch") or "main"
    listed = config.get("protectedBranches")
    protected = sorted(set((listed if isinstance(listed, list) else ["main", "master", "develop"]) + [base]))
    labels = config.get("labels") if isinstance(config.get("labels"), dict) else {}
    triage = labels.get("triage") or "needs-triage"
    ready = labels.get("ready") or "agent:ready"
    checks = [str(c["run"]) for c in config.get("checks") or [] if isinstance(c, dict) and c.get("run")]
    lines = [
        "This project uses the devflow plugin (.claude/devflow.json). Workflow rules for every change:",
        "- Branches: name them %s (type is feat|fix|chore|docs|refactor|test). Start from the remote %s." % (pattern, base),
        "- Commits: Conventional Commits in English with the issue scope, e.g. feat(%s): ...; small commits; no Co-Authored-By or AI attribution unless CLAUDE.md says so." % scope,
        "- Behaviour changes and bug fixes: commit a failing test first, confirm it fails for the right reason, then the implementation.",
        "- Stage files by name; never git add -A, --all or '.'.",
        "- Never edit an issue's acceptance criteria or weaken a test or check (skip, noqa, ignore, deleted assertion) to make something pass.",
        "- If a requirement is ambiguous in a way that changes behaviour or a contract, ask instead of guessing.",
        "- Never merge a pull request and never push to a protected branch (%s); push your own feature branch and open a PR." % ", ".join(protected),
        "- Bugs: file them from the devflow bug template labelled %s only; a human sets %s, priority and risk." % (triage, ready),
    ]
    if checks:
        lines.append("- Checks that must pass before a PR: %s." % "; ".join(checks))
    lines.append("Project rules (architecture, conventions, the Never list) are in CLAUDE.md.")
    return "\n".join(lines)


def main():
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        with open(os.path.join(project_dir, ".claude", "devflow.json"), encoding="utf-8") as fh:
            config = json.load(fh)
        if not isinstance(config, dict):
            return 0
        text = rules(config)
    except (OSError, ValueError, AttributeError, TypeError):
        return 0
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
