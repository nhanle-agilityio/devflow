"""Tests for formatter.py (PostToolUse) and session_start.py (SessionStart). Run with:

python3 -m unittest discover -s hooks -p 'test_*.py' -v
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import formatter as fmt
import session_start

HERE = Path(__file__).parent


def run(script, payload, project_dir):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=project_dir)
    return subprocess.run(
        ["python3", str(HERE / script)],
        check=False,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )


def write_config(directory, data):
    os.makedirs(os.path.join(directory, ".claude"), exist_ok=True)
    with open(os.path.join(directory, ".claude", "devflow.json"), "w", encoding="utf-8") as fh:
        fh.write(data if isinstance(data, str) else json.dumps(data))


class FormatterMatching(unittest.TestCase):
    def test_commands_for_globs(self):
        rules = {"*.py": "ruff format {file}", "web/**/*.ts": "prettier -w {file}", "*.md": ""}
        self.assertEqual(fmt.commands_for("src/a.py", rules), ["ruff format src/a.py"])
        self.assertEqual(fmt.commands_for("a.py", rules), ["ruff format a.py"])
        self.assertEqual(fmt.commands_for("web/x/y.ts", rules), ["prettier -w web/x/y.ts"])
        self.assertEqual(fmt.commands_for("web/y.ts", rules), ["prettier -w web/y.ts"])
        self.assertEqual(fmt.commands_for("README.md", rules), [])
        self.assertEqual(fmt.commands_for("a.txt", rules), [])

    def test_file_is_shell_quoted(self):
        self.assertEqual(fmt.commands_for("my dir/a b.py", {"*.py": "ruff format {file}"}), ["ruff format 'my dir/a b.py'"])

    def test_no_placeholder_appends_the_file(self):
        self.assertEqual(fmt.commands_for("a.py", {"*.py": "black -q"}), ["black -q a.py"])

    def test_relative_path(self):
        self.assertEqual(fmt.relative("/p/src/a.py", "/p"), "src/a.py")
        self.assertIsNone(fmt.relative("/elsewhere/a.py", "/p"))
        self.assertEqual(fmt.relative("src/a.py", "/p"), "src/a.py")


class FormatterHook(unittest.TestCase):
    def test_runs_the_formatter_on_the_edited_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "a.py")
            Path(target).write_text("x=1\n")
            write_config(tmp, {"format": {"*.py": "sh -c 'echo formatted > \"$0\"' {file}"}})
            result = run("formatter.py", {"tool_name": "Edit", "tool_input": {"file_path": target}, "cwd": tmp}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(Path(target).read_text().strip(), "formatted")

    def test_failing_formatter_never_fails_the_tool_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "a.py")
            Path(target).write_text("x\n")
            write_config(tmp, {"format": {"*.py": "false"}})
            result = run("formatter.py", {"tool_name": "Write", "tool_input": {"file_path": target}}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_missing_formatter_binary_is_quiet(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "a.py")
            Path(target).write_text("x\n")
            write_config(tmp, {"format": {"*.py": "/nonexistent/bin/ruff format {file}"}})
            result = run("formatter.py", {"tool_name": "Edit", "tool_input": {"file_path": target}}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout + result.stderr, "")

    def test_no_config_no_key_bad_json_other_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {"tool_name": "Edit", "tool_input": {"file_path": os.path.join(tmp, "a.py")}}
            self.assertEqual(run("formatter.py", payload, tmp).returncode, 0)
            write_config(tmp, {"baseBranch": "main"})
            self.assertEqual(run("formatter.py", payload, tmp).returncode, 0)
            write_config(tmp, "{not json")
            self.assertEqual(run("formatter.py", payload, tmp).returncode, 0)
            write_config(tmp, {"format": {"*": "touch {file}.ran"}})
            self.assertEqual(run("formatter.py", {"tool_name": "Bash", "tool_input": {"command": "ls"}}, tmp).returncode, 0)
            self.assertEqual(os.listdir(tmp), [".claude"])

    def test_file_outside_the_project_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as other:
            target = os.path.join(other, "a.py")
            Path(target).write_text("x\n")
            write_config(tmp, {"format": {"*.py": "touch {file}.ran"}})
            run("formatter.py", {"tool_name": "Edit", "tool_input": {"file_path": target}}, tmp)
            self.assertFalse(os.path.exists(target + ".ran"))


class SessionStartRules(unittest.TestCase):
    CONFIG = {
        "github": {"owner": "acme", "repo": "shop"},
        "baseBranch": "develop",
        "protectedBranches": ["main"],
        "branchPattern": "{type}/{issue}-{slug}",
        "commitScope": "#{issue}",
        "checks": [{"name": "test", "run": "make test"}],
    }

    def test_rules_text(self):
        text = session_start.rules(self.CONFIG)
        for want in (
            "{type}/{issue}-{slug}",
            "feat(#12): ...",
            "failing test first",
            "Stage files by name",
            "acceptance criteria",
            "ask",
            "Never merge",
            "develop",
            "main",
            "make test",
            "needs-triage",
        ):
            self.assertIn(want, text)

    def test_defaults_when_keys_are_missing(self):
        text = session_start.rules({"baseBranch": "main"})
        self.assertIn("{type}/{issue}-{slug}", text)
        self.assertIn("feat(#12): ...", text)

    def test_hook_prints_additional_context_on_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_config(tmp, self.CONFIG)
            result = run("session_start.py", {"hook_event_name": "SessionStart", "source": "startup"}, tmp)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, "")
            out = json.loads(result.stdout)
            self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")
            self.assertIn("Never merge", out["hookSpecificOutput"]["additionalContext"])

    def test_silent_without_devflow_json_or_with_bad_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run("session_start.py", {"hook_event_name": "SessionStart"}, tmp)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
            write_config(tmp, "{not json")
            result = run("session_start.py", {"hook_event_name": "SessionStart"}, tmp)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))


class HooksJson(unittest.TestCase):
    def test_registers_every_hook(self):
        data = json.loads((HERE / "hooks.json").read_text())["hooks"]
        self.assertIn("guard.py", json.dumps(data["PreToolUse"]))
        self.assertIn("formatter.py", json.dumps(data["PostToolUse"]))
        self.assertIn("Edit", data["PostToolUse"][0]["matcher"])
        self.assertIn("session_start.py", json.dumps(data["SessionStart"]))


if __name__ == "__main__":
    unittest.main()
