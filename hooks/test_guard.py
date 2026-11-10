"""Tests for guard.py. Run with:

python3 -m unittest discover -s hooks -p 'test_*.py' -v
"""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import guard

HOOK = Path(__file__).with_name("guard.py")
PROTECTED = {"main", "develop"}


def reasons_on(command, branch="feature/x", protected=PROTECTED):
    return guard.reasons(command, protected, lambda directory: branch)


def run_hook(payload, project_dir):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=project_dir)
    return subprocess.run(
        ["python3", str(HOOK)], check=False, input=json.dumps(payload), capture_output=True, text=True, env=env
    )


class BlockedCommands(unittest.TestCase):
    CASES = [
        "gh pr merge 12",
        "gh pr merge --squash --auto",
        "gh -R acme/shop pr merge 3",
        "gh api -X PUT repos/acme/shop/pulls/3/merge",
        "gh api repos/acme/shop/pulls/3/merge --method PUT",
        "gh api --method=PUT repos/acme/shop/pulls/3/merge -f merge_method=squash",
        "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
        "git push origin main",
        "git push origin HEAD:main",
        "git push origin feature:main",
        "git push origin feature:refs/heads/main",
        "git push origin develop",
        "git push -u origin main",
        "git push origin :main",
        "git push --delete origin main",
        "git push origin -d main",
        "git push --force origin feature/x",
        "git push -f origin feature/x",
        "git push -fu origin feature/x",
        "git push origin +feature/x",
        "git push origin +HEAD:feature/x",
        "git push --mirror",
        "git push --all origin",
        "git push origin 'refs/heads/*:refs/heads/*'",
        "git status && git push origin main",
        "git -C /repo push origin main",
        "git -c push.default=current push origin main",
        "git push --repo=origin main",
        "env git push origin main",
        "sudo -u root git push -f",
        "bash -c 'git push origin main'",
        "bash -lc 'cd x && git push origin develop'",
        "FOO=1 git push origin main",
        "/usr/bin/git push origin main",
        "git push origin 'main'",
        "git commit -m wip && git push origin HEAD:develop",
        # Unparsable (apostrophe) -> crude fallback still blocks
        "git push origin main && echo it's done",
    ]

    def test_blocked(self):
        for command in self.CASES:
            with self.subTest(command=command):
                self.assertTrue(reasons_on(command), command)

    def test_bare_push_on_protected_branch(self):
        for command in ("git push", "git push origin", "git push -u origin HEAD", "git push origin HEAD"):
            with self.subTest(command=command):
                self.assertTrue(reasons_on(command, branch="main"), command)


class AllowedCommands(unittest.TestCase):
    CASES = [
        "",
        "git status",
        "git push origin feature/x",
        "git push -u origin feature/x",
        "git push origin HEAD",
        "git push",
        "git push --force-with-lease origin feature/x",
        "git push --force-with-lease=feature/x:abc123 origin feature/x",
        "git push --force-if-includes --force-with-lease origin feature/x",
        "git push origin feature/x:feature/y",
        "git push origin --tags",
        "git push origin refs/tags/v1:refs/tags/v1",
        "git push --delete origin feature/old",
        "git push origin :feature/old",
        "git push -o ci.skip origin feature/x",
        "git commit -m 'never git push -f or gh pr merge'",
        "echo git push origin main",
        "gh pr create --base main --title t",
        "gh pr view 12",
        "gh pr list",
        "gh api repos/acme/shop/pulls/3/comments",
        "gh api -X GET repos/acme/shop/pulls/3/merge",
        "git merge origin/main",
        "git fetch origin main",
        "git pull origin main",
        "bash -c 'git push origin feature/x'",
        "sudo -u root git push origin feature/x",
        "cat > notes.md <<'EOF'\nit's done\nEOF",
        "echo it's fine",
    ]

    def test_glob_protected_entry(self):
        self.assertTrue(reasons_on("git push origin feature/x:release/1.2", protected={"release/*"}))

    def test_allowed(self):
        for command in self.CASES:
            with self.subTest(command=command):
                self.assertEqual(reasons_on(command), [], command)

    def test_bare_push_on_other_branch_is_allowed(self):
        self.assertEqual(reasons_on("git push", branch="fix/12-bug"), [])

    def test_detached_head_bare_push_is_allowed(self):
        self.assertEqual(reasons_on("git push", branch=""), [])


class LoadProtected(unittest.TestCase):
    def write_config(self, directory, data):
        os.makedirs(os.path.join(directory, ".claude"))
        with open(os.path.join(directory, ".claude", "devflow.json"), "w", encoding="utf-8") as fh:
            fh.write(data if isinstance(data, str) else json.dumps(data))

    def test_missing_file_uses_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(guard.load_protected(tmp), {"main", "master", "develop"})

    def test_invalid_json_uses_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_config(tmp, "{not json")
            self.assertEqual(guard.load_protected(tmp), {"main", "master", "develop"})

    def test_config_adds_base_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_config(tmp, {"baseBranch": "trunk", "protectedBranches": ["release"]})
            self.assertEqual(guard.load_protected(tmp), {"trunk", "release"})

    def test_base_branch_only_keeps_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_config(tmp, {"baseBranch": "trunk"})
            self.assertEqual(guard.load_protected(tmp), {"trunk", "main", "master", "develop"})


class HookProcess(unittest.TestCase):
    def test_mcp_merge_is_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            for tool in ("mcp__github__merge_pull_request", "mcp__0322__merge_pull_request"):
                result = run_hook({"tool_name": tool, "tool_input": {}}, tmp)
                self.assertEqual(result.returncode, 2)
                self.assertIn("never merges", result.stderr)

    def test_other_mcp_tool_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook({"tool_name": "mcp__github__update_pull_request_branch", "tool_input": {}}, tmp)
            self.assertEqual(result.returncode, 0)

    def test_pull_request_update_tools_are_allowed(self):
        # /devflow:sync retargets and updates PR branches; only merge_pull_request is blocked.
        with tempfile.TemporaryDirectory() as tmp:
            for tool in ("mcp__github__update_pull_request_branch", "mcp__github__update_pull_request"):
                result = run_hook({"tool_name": tool, "tool_input": {}}, tmp)
                self.assertEqual(result.returncode, 0, tool)

    def test_bash_block_message_and_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook({"tool_name": "Bash", "tool_input": {"command": "gh pr merge 1"}}, tmp)
            self.assertEqual(result.returncode, 2)
            self.assertIn("devflow guard", result.stderr)

    def test_config_protected_branch_is_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".claude"))
            with open(os.path.join(tmp, ".claude", "devflow.json"), "w", encoding="utf-8") as fh:
                json.dump({"baseBranch": "trunk"}, fh)
            blocked = run_hook({"tool_name": "Bash", "tool_input": {"command": "git push origin trunk"}}, tmp)
            self.assertEqual(blocked.returncode, 2)

    def test_bare_push_uses_real_current_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            subprocess.run(["git", "-C", tmp, "symbolic-ref", "HEAD", "refs/heads/main"], check=True)
            payload = {"tool_name": "Bash", "tool_input": {"command": "git push"}, "cwd": tmp}
            self.assertEqual(run_hook(payload, tmp).returncode, 2)
            subprocess.run(["git", "-C", tmp, "symbolic-ref", "HEAD", "refs/heads/feat/x"], check=True)
            self.assertEqual(run_hook(payload, tmp).returncode, 0)

    def test_non_bash_tool_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run_hook({"tool_name": "Read", "tool_input": {}}, tmp).returncode, 0)


class McpBranchWrites(unittest.TestCase):
    TOOLS = (
        "mcp__github__push_files",
        "mcp__0322__create_or_update_file",
        "mcp__github__delete_file",
    )

    def call(self, tool, tool_input, config=None):
        with tempfile.TemporaryDirectory() as tmp:
            if config is not None:
                os.makedirs(os.path.join(tmp, ".claude"))
                with open(os.path.join(tmp, ".claude", "devflow.json"), "w", encoding="utf-8") as fh:
                    json.dump(config, fh)
            return run_hook({"tool_name": tool, "tool_input": tool_input}, tmp)

    def test_protected_branch_is_blocked(self):
        for tool in self.TOOLS:
            for branch in ("main", "develop"):
                with self.subTest(tool=tool, branch=branch):
                    result = self.call(tool, {"branch": branch})
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("protected branch", result.stderr)

    def test_missing_or_empty_branch_is_blocked(self):
        for tool in self.TOOLS:
            for tool_input in ({}, {"branch": ""}, {"branch": None}):
                with self.subTest(tool=tool, tool_input=tool_input):
                    result = self.call(tool, tool_input)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("default branch", result.stderr)

    def test_feature_branch_is_allowed(self):
        for tool in self.TOOLS:
            with self.subTest(tool=tool):
                self.assertEqual(self.call(tool, {"branch": "feat/12-x"}).returncode, 0)

    def test_glob_protected_entry_is_blocked(self):
        result = self.call(self.TOOLS[0], {"branch": "release/1.2"}, {"protectedBranches": ["release/*"]})
        self.assertEqual(result.returncode, 2)

    def test_configured_base_branch_is_blocked(self):
        self.assertEqual(self.call(self.TOOLS[0], {"branch": "trunk"}, {"baseBranch": "trunk"}).returncode, 2)

    def test_matcher_covers_bash_and_mcp_tools(self):
        hooks_json = json.loads(Path(__file__).with_name("hooks.json").read_text(encoding="utf-8"))
        matcher = hooks_json["hooks"]["PreToolUse"][0]["matcher"]
        for tool in ("Bash", "mcp__github__merge_pull_request") + self.TOOLS:
            self.assertTrue(re.fullmatch(matcher, tool), tool)
        self.assertFalse(re.fullmatch(matcher, "Read"))


class DestructiveGit(unittest.TestCase):
    BLOCKED = [
        "git reset --hard",
        "git reset --hard origin/main",
        "git reset -q --hard HEAD~1",
        "git clean -f",
        "git clean -fd",
        "git clean -dfx",
        "git clean -xdf",
        "git clean --force -d",
        "git clean -d -f",
        "git branch -D feature/old",
        "git branch -Dr origin/x",
        "git branch -d -f feature/old",
        "git branch --delete --force feature/old",
        "git branch -df feature/old",
        "git checkout .",
        "git checkout -- .",
        "git checkout HEAD -- .",
        "git checkout ./",
        "git restore .",
        "git restore --worktree .",
        "git restore -SW .",
        "git restore --source=HEAD :/",
        "git stash drop",
        "git stash drop stash@{1}",
        "git stash clear",
        "git filter-branch --tree-filter 'rm x' HEAD",
        "git update-ref -d refs/heads/x",
        "git update-ref --delete refs/heads/x",
        "git reflog expire --expire=now --all",
        # global options before the subcommand
        "git -C /repo reset --hard",
        'git -C "my dir" clean -fd',
        "git -c core.quotepath=off checkout .",
        "git --no-pager stash clear",
        "git --git-dir=.git --work-tree=. reset --hard",
        "git status && git reset --hard",
        "bash -c 'git clean -fdx'",
        "sudo -u git git reset --hard",
        "GIT_TRACE=1 git branch -D x",
    ]
    ALLOWED = [
        "git reset",
        "git reset --soft HEAD~1",
        "git reset HEAD file.py",
        "git reset --mixed",
        "git clean -n",
        "git clean -nd",
        "git clean --dry-run",
        "git branch -d feature/old",
        "git branch --delete feature/old",
        "git checkout feature/x",
        "git checkout -b feature/x",
        "git checkout -- src/a.py",
        "git checkout main -- docs/a.md",
        "git restore src/a.py",
        "git restore --staged .",
        "git restore --staged -- .",
        "git stash push -u -m devflow-red-12 -- src/x.py",
        "git stash pop",
        "git stash list",
        "git stash apply abc123",
        "git update-ref refs/heads/x HEAD",
        "git reflog",
        "git reflog show",
        "git commit -m 'never git reset --hard or git clean -fdx'",
        "echo git reset --hard",
    ]

    def test_blocked(self):
        for command in self.BLOCKED:
            with self.subTest(command=command):
                self.assertTrue(reasons_on(command), command)

    def test_allowed(self):
        for command in self.ALLOWED:
            with self.subTest(command=command):
                self.assertEqual(reasons_on(command), [], command)

    def test_reason_names_the_command(self):
        self.assertIn("git reset --hard", reasons_on("git -C x reset --hard")[0])
        self.assertIn("git stash clear", reasons_on("git stash clear")[0])


class StageEverything(unittest.TestCase):
    """Cases ported from TaskBoard's .claude/hooks/test_block_git_add_all.py."""

    BLOCKED = [
        "git add -A",
        "git add .",
        "git add --all",
        "git add ./",
        "git add :/",
        "git add -vA",
        "git status && git add .",
        "cd x; git add . && git commit -m y",
        "git status\ngit add .",
        'git add . && git commit -m "msg"',
        "git -C /x add -A",
        "git add -Av",
        "git add -An",
        'git add "."',
        "git add '.'",
        'git -C "my dir" add -A',
        "git -c core.quotepath=off add -A",
        "git --no-pager add .",
        "git --git-dir=.git add -A",
        "GIT_TRACE=1 git add .",
        "git add -- .",
        "bash -c 'git add -A'",
        'sh -c "cd x && git add ."',
        "env git add .",
        "env -i git add -A",
        "sudo git add .",
        "command git add .",
        "sudo -u root git add .",
        "sudo -uroot git add .",
        "sudo -Eu root git add .",
        "nice -n 5 git add -A",
        "env -u FOO git add .",
        "xargs -I {} git add .",
        "sudo -u root env -u FOO git add -A",
        "bash -lc 'git add .'",
        "bash -e -c 'git add -A'",
        "xargs -J % git add .",
        "sudo -R / git add .",
        "sudo --user root git add .",
        "sudo -u git git add .",
        "env -S 'git add .'",
        "bash -c -- 'git add .'",
        "bash -o pipefail -c 'git add -A'",
        "sudo -s git add .",
        "sudo -P git add .",
        "sudo -E git add .",
        "nice git add -A",
        # Unparsable (apostrophe) -> crude fallback still blocks
        "git add . && echo it's done",
    ]
    ALLOWED = [
        "git add .gitignore",
        "git add docs/a.md taskboard/services.py",
        "git add 'my file.md'",
        "git add -p",
        "git add -u",
        "git add src/*.py",
        "git commit -m 'add . files'",
        'git commit -q -m "chore: block git add -A and git add . with a hook"',
        "echo git add -A is forbidden",
        "git status",
        "ls *",
        "",
        "bash -c 'git add docs/a.md'",
        "sudo -u root git add docs/a.md",
        "bash -lc 'git status'",
        "bash script.sh -c 'git add .'",
        "sudo echo 'git add .'",
        "cat > notes.md <<'EOF'\nit's done\nEOF",
        "echo it's fine",
    ]

    def test_blocked(self):
        for command in self.BLOCKED:
            with self.subTest(command=command):
                found = reasons_on(command)
                self.assertTrue(found, command)
                self.assertIn("stage the files you changed by name", found[0])

    def test_allowed(self):
        for command in self.ALLOWED:
            with self.subTest(command=command):
                self.assertEqual(reasons_on(command), [], command)

    def test_hook_process_blocks_with_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook({"tool_name": "Bash", "tool_input": {"command": "git add -A"}}, tmp)
            self.assertEqual(result.returncode, 2)
            self.assertIn("stage the files you changed by name", result.stderr)

    def test_destructive_hook_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_hook({"tool_name": "Bash", "tool_input": {"command": "git reset --hard"}}, tmp)
            self.assertEqual(result.returncode, 2)
            self.assertIn("discards work", result.stderr)


if __name__ == "__main__":
    unittest.main()
