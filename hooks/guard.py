#!/usr/bin/env python3
"""PreToolUse guard for the devflow plugin: humans own merges and protected branches.

Exit 2 blocks the call and sends the reason on stderr back to Claude. Blocked:

- any MCP tool whose name ends with `merge_pull_request`;
- Bash `gh pr merge`, `gh api .../merge` (unless an explicit GET) and the GraphQL merge mutations;
- Bash `git push` that forces (`--force`, `-f`, `+refspec`; `--force-with-lease` is allowed),
  mirrors or pushes `--all`, or targets a protected branch (explicit refspec, `--delete`, or a
  bare `git push` while the current branch is protected).

Protected branches = `protectedBranches` + `baseBranch` from `.claude/devflow.json` in
`$CLAUDE_PROJECT_DIR` (default: the hook's cwd); `main`, `master`, `develop` when the file is
missing or unreadable.

Commands are split like a shell would (shlex) so quoted arguments are seen and a commit message
that merely mentions `git push -f` is not blocked. Wrappers (`env`, `sudo`, `bash -c '...'`) are
looked through. When shlex cannot parse the command (an apostrophe in a heredoc), a cruder
whitespace split of each simple command is analysed instead. This guards against habit, not
against evasion: `eval`, `$(...)` inside double quotes and other interpreters are not covered.
Stdlib only, Python 3.9.
"""

import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys

DEFAULT_PROTECTED = ("main", "master", "develop")
OPERATORS = frozenset({";", "&", "&&", "|", "||", "(", ")"})
WRAPPERS = frozenset(
    {"env", "sudo", "command", "nice", "xargs", "time", "nohup", "exec"}
)
SHELLS = frozenset({"bash", "sh", "zsh"})
SHELL_COMMAND_FLAG = re.compile(r"-[a-zA-Z]*c[a-zA-Z]*")
SHELL_OPTIONS_WITH_VALUE = frozenset({"-o", "+o", "-O", "+O"})
GIT_OPTIONS_WITH_VALUE = frozenset(
    {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
)
GH_OPTIONS_WITH_VALUE = frozenset({"-R", "--repo", "--hostname"})
PUSH_OPTIONS_WITH_VALUE = frozenset(
    {
        "--repo",
        "--receive-pack",
        "--exec",
        "-o",
        "--push-option",
        "--recurse-submodules",
    }
)
GH_MERGE_ENDPOINT = re.compile(r"(^|/)merges?(\?.*)?$")
GRAPHQL_MERGE = re.compile(r"mergePullRequest|enablePullRequestAutoMerge")


def load_protected(project_dir):
    """Return the set of protected branch names for the project."""
    names = set()
    try:
        with open(
            os.path.join(project_dir, ".claude", "devflow.json"), encoding="utf-8"
        ) as fh:
            config = json.load(fh)
        listed = config.get("protectedBranches")
        if isinstance(listed, list):
            names.update(str(n) for n in listed if n)
        base = config.get("baseBranch")
        if base:
            names.add(str(base))
        if not isinstance(listed, list):
            names.update(DEFAULT_PROTECTED)
    except (OSError, ValueError, AttributeError):
        names.update(DEFAULT_PROTECTED)
    return names


def current_branch(directory):
    """Name of the checked-out branch in `directory`, or '' (detached HEAD, not a repo, no git)."""
    try:
        out = subprocess.run(
            ["git", "-C", directory, "symbolic-ref", "--short", "-q", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def segments(command):
    """Yield the token list of each simple command, split at shell operators."""
    lexer = shlex.shlex(command.replace("\n", ";"), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    segment = []
    for token in lexer:
        if token in OPERATORS:
            yield segment
            segment = []
        else:
            segment.append(token)
    yield segment


def crude_segments(command):
    """Fallback when shlex fails: split at operators and whitespace, drop quote characters."""
    for piece in re.split(r"[;&|()\n]+", command):
        yield [t.strip("'\"") for t in piece.split() if t.strip("'\"")]


def base_name(token):
    return token.rsplit("/", 1)[-1]


def iter_commands(tokens, split):
    """Yield every `git` / `gh` token list reachable from `tokens`, looking through wrappers."""
    while tokens and "=" in tokens[0] and not tokens[0].startswith("-"):
        tokens = tokens[1:]  # leading VAR=value assignments
    if not tokens:
        return
    head = base_name(tokens[0])
    if head in ("git", "gh"):
        yield [head] + tokens[1:]
    elif head in WRAPPERS:
        for i in range(1, len(tokens)):
            if base_name(tokens[i]) in ("git", "gh") or base_name(tokens[i]) in SHELLS:
                yield from iter_commands(tokens[i:], split)
                break
            if head == "env" and tokens[i - 1] in ("-S", "--split-string"):
                for seg in split(tokens[i]):
                    yield from iter_commands(seg, split)
    elif head in SHELLS:
        i = 1
        while i < len(tokens) and tokens[i][:1] in ("-", "+"):
            if SHELL_COMMAND_FLAG.fullmatch(tokens[i]):
                i += 2 if i + 1 < len(tokens) and tokens[i + 1] == "--" else 1
                if i < len(tokens):
                    for seg in split(tokens[i]):
                        yield from iter_commands(seg, split)
                return
            i += 2 if tokens[i] in SHELL_OPTIONS_WITH_VALUE else 1


def strip_options(tokens, with_value):
    """Return (positional-start index, directory from -C) after leading options of `tokens[0]`."""
    i, directory = 1, None
    while i < len(tokens) and tokens[i].startswith("-"):
        if tokens[i] == "-C" and i + 1 < len(tokens):
            directory = tokens[i + 1]
        i += 2 if tokens[i] in with_value else 1
    return i, directory


def check_gh(tokens):
    """Reason string if the `gh` call merges a PR, else None."""
    if any(GRAPHQL_MERGE.search(t) for t in tokens):
        return "merging a pull request through the GraphQL API"
    words, i = [], 1
    while i < len(tokens):
        if tokens[i] in GH_OPTIONS_WITH_VALUE:
            i += 2
            continue
        if not tokens[i].startswith("-"):
            words.append(tokens[i])
        i += 1
    if words[:2] == ["pr", "merge"]:
        return "'gh pr merge'"
    if words[:1] == ["api"]:
        method = ""
        for j, tok in enumerate(tokens):
            if tok in ("-X", "--method") and j + 1 < len(tokens):
                method = tokens[j + 1].upper()
            elif tok.startswith("--method="):
                method = tok.split("=", 1)[1].upper()
            elif tok.startswith("-X") and len(tok) > 2:
                method = tok[2:].upper()
        endpoint = any(GH_MERGE_ENDPOINT.search(t) for t in words[1:])
        if endpoint and method != "GET":
            return "'gh api' call to a merge endpoint"
    return None


def resolve(name, branch):
    """Map a push destination to a branch name (HEAD -> current branch, strip refs/heads/)."""
    if name == "HEAD":
        return branch
    if name.startswith("refs/heads/"):
        return name[len("refs/heads/") :]
    return name


def is_protected(name, protected):
    if not name or name.startswith("refs/"):  # tags and other refs are not branches
        return False
    # Either side may be a glob: a wildcard refspec (refs/heads/*) or a protected entry (release/*).
    return any(
        fnmatch.fnmatchcase(name, p) or fnmatch.fnmatchcase(p, name) for p in protected
    )


def check_push(tokens, protected, branch_of):
    """Reason string if the `git push` call is not allowed, else None."""
    i, directory = strip_options(tokens, GIT_OPTIONS_WITH_VALUE)
    if i >= len(tokens) or tokens[i] != "push":
        return None
    operands, delete, has_repo_option = [], False, False
    j = i + 1
    while j < len(tokens):
        tok = tokens[j]
        if tok == "--":
            operands.extend(tokens[j + 1 :])
            break
        if tok.startswith("--"):
            name = tok.split("=", 1)[0]
            if name == "--force":
                return "force push (use --force-with-lease on your own branch)"
            if name in ("--mirror", "--all"):
                return (
                    "'git push %s' touches every branch, protected ones included" % name
                )
            if name == "--delete":
                delete = True
            if name == "--repo":
                has_repo_option = True
            if name in PUSH_OPTIONS_WITH_VALUE and "=" not in tok:
                j += 1
        elif tok.startswith("-") and len(tok) > 1:
            flags = tok[1:]
            if "f" in flags:
                return "force push (use --force-with-lease on your own branch)"
            if "d" in flags:
                delete = True
            if flags.endswith("o") or tok == "-o":
                j += 1  # -o <push-option>
        else:
            operands.append(tok)
        j += 1

    refspecs = operands if has_repo_option else operands[1:]
    branch = branch_of(directory)
    if not refspecs:
        if delete:
            return None
        if is_protected(branch, protected):
            return (
                "pushing the protected branch '%s' (nothing else was specified)"
                % branch
            )
        return None
    for spec in refspecs:
        if spec.startswith("+"):
            return "force push through the '+' refspec prefix '%s'" % spec
        if delete or ":" not in spec:
            dst = spec
        else:
            dst = spec.split(":", 1)[1]
        dst = resolve(dst, branch)
        if is_protected(dst, protected):
            verb = "deleting" if delete or spec.startswith(":") else "pushing to"
            return "%s the protected branch '%s'" % (verb, dst)
    return None


def reasons(command, protected, branch_of):
    """List of reasons why the Bash `command` must be blocked (empty = allowed)."""
    try:
        parsed = [list(seg) for seg in segments(command)]
        split = segments
    except ValueError:
        parsed = [list(seg) for seg in crude_segments(command)]
        split = crude_segments
    found = []
    for seg in parsed:
        for tokens in iter_commands(seg, split):
            reason = (
                check_gh(tokens)
                if tokens[0] == "gh"
                else check_push(tokens, protected, branch_of)
            )
            if reason:
                found.append(reason)
    return found


def main():
    payload = json.load(sys.stdin)
    tool = payload.get("tool_name", "")
    if tool.endswith("merge_pull_request"):
        print(
            "Blocked: devflow never merges pull requests; a human merges them.",
            file=sys.stderr,
        )
        return 2
    if tool != "Bash":
        return 0
    command = (payload.get("tool_input") or {}).get("command", "")
    project_dir = (
        os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    )
    protected = load_protected(project_dir)
    work_dir = payload.get("cwd") or project_dir

    def branch_of(directory):
        return current_branch(
            os.path.join(work_dir, directory) if directory else work_dir
        )

    found = reasons(command, protected, branch_of)
    if found:
        print(
            "Blocked by the devflow guard: %s. Humans own merges and protected branches (%s); "
            "push your own feature branch instead."
            % (found[0], ", ".join(sorted(protected))),
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
