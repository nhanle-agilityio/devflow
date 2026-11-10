#!/usr/bin/env python3
"""PostToolUse hook for the devflow plugin: run the project's formatter on the file Claude just edited.

Config key `format` in `.claude/devflow.json`: an object mapping a glob to a shell command, e.g.
`{"*.py": ".venv/bin/ruff format {file}", "web/**/*.ts": "npx prettier -w {file}"}`. `{file}` is
replaced by the shell-quoted path relative to the project root (appended when the command has no
placeholder). A glob without "/" matches the file name in any directory; one with "/" matches the
relative path (`**` crosses directories). Every matching command runs, in order, from the project
root, with a 30 second timeout.

Quiet by design: no output, always exit 0. A missing config, a missing formatter, a failure or a
timeout never fails or blocks the tool call. Files outside the project are skipped. Stdlib only,
Python 3.9.
"""

import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys

EDIT_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})
TIMEOUT_SEC = 30


def relative(path, project_dir):
    """Path relative to the project root, or None when it is outside the project."""
    if not os.path.isabs(path):
        return os.path.normpath(path)
    root = os.path.realpath(project_dir)
    full = os.path.realpath(path)
    if full != root and not full.startswith(root + os.sep):
        return None
    return os.path.relpath(full, root)


def glob_matches(glob, rel):
    if "/" not in glob:
        return fnmatch.fnmatchcase(os.path.basename(rel), glob)
    pattern = ""
    i = 0
    while i < len(glob):
        if glob.startswith("**/", i):
            pattern += "(?:.*/)?"
            i += 3
        elif glob.startswith("**", i):
            pattern += ".*"
            i += 2
        elif glob[i] == "*":
            pattern += "[^/]*"
            i += 1
        elif glob[i] == "?":
            pattern += "[^/]"
            i += 1
        else:
            pattern += re.escape(glob[i])
            i += 1
    return re.fullmatch(pattern, rel) is not None


def commands_for(rel, rules):
    """The shell commands to run for the relative path `rel`, in config order."""
    out = []
    for glob, command in (rules or {}).items():
        if not isinstance(command, str) or not command.strip():
            continue
        if not glob_matches(str(glob), rel):
            continue
        quoted = shlex.quote(rel)
        out.append(command.replace("{file}", quoted) if "{file}" in command else "%s %s" % (command, quoted))
    return out


def load_rules(project_dir):
    try:
        with open(os.path.join(project_dir, ".claude", "devflow.json"), encoding="utf-8") as fh:
            rules = json.load(fh).get("format")
    except (OSError, ValueError, AttributeError):
        return {}
    return rules if isinstance(rules, dict) else {}


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if payload.get("tool_name") not in EDIT_TOOLS:
        return 0
    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    rules = load_rules(project_dir)
    if not path or not rules:
        return 0
    rel = relative(path, project_dir)
    if rel is None or not os.path.isfile(os.path.join(project_dir, rel)):
        return 0
    for command in commands_for(rel, rules):
        try:
            subprocess.run(
                command,
                shell=True,
                cwd=project_dir,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=TIMEOUT_SEC,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # never fail the tool call
        sys.exit(0)
