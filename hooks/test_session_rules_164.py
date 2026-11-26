"""Issue #164 session-start policy, tested through the hook's stdout."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SessionRules164Test(unittest.TestCase):
    def test_A3_11_ambiguous_requirements_and_stop_conditions(self):
        hook = Path(__file__).with_name("session_start.py")
        with tempfile.TemporaryDirectory() as project:
            config = Path(project) / ".claude" / "devflow.json"
            config.parent.mkdir()
            config.write_text("{}", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(hook)],
                input='{"hook_event_name":"SessionStart","source":"startup"}',
                text=True,
                capture_output=True,
                env={**os.environ, "CLAUDE_PROJECT_DIR": project},
                check=True,
            )

        rules = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
        with self.subTest(rule="retire the old ask policy"):
            self.assertNotIn("ask instead of guessing", rules.lower())
        with self.subTest(rule="decide, record and flag the ambiguous requirement"):
            paragraph = next(
                (line for line in rules.splitlines() if "ambigu" in line.lower()), ""
            )
            self.assertRegex(paragraph.lower(), r"\bdecid(?:e|es|ed|ing)\b")
            self.assertRegex(paragraph.lower(), r"\brecord(?:s|ed|ing)?\b")
            self.assertIn("## Decisions", paragraph)
            self.assertRegex(paragraph.lower(), r"\bflag(?:s|ged|ging)?\b")
            self.assertIn("human review", paragraph.lower())
        with self.subTest(rule="name the exclusive stop conditions"):
            stops = next(
                (line.lower() for line in rules.splitlines()
                 if "only" in line.lower() and "stop" in line.lower()),
                "",
            )
            self.assertRegex(stops, r"\birreversible\b")
            self.assertRegex(stops, r"\bweaken\w*\b[^.]*\b(?:tests?|checks?)\b")
            self.assertRegex(stops, r"\b(?:secrets?|credentials?)\b")
            self.assertRegex(stops, r"\bpermissions?\b")
