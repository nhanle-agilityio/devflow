#!/usr/bin/env python3
"""PreToolUse guard for the devflow plugin: humans own merges, protected branches and lost work.

Exit 2 blocks the call and sends the reason on stderr back to Claude. Blocked:

- any MCP tool whose name ends with `merge_pull_request`;
- MCP tools that write straight to a branch (names ending with `push_files`,
  `create_or_update_file`, `delete_file`) when `tool_input.branch` is protected or missing/empty
  (the API then writes to the default branch);
- Bash `gh pr merge`, `gh api .../merge` (unless an explicit GET) and the GraphQL merge mutations;
- Bash `git push` that forces (`--force`, `-f`, `+refspec`; `--force-with-lease` is allowed),
  mirrors or pushes `--all`, or targets a protected branch (explicit refspec, `--delete`, or a
  bare `git push` while the current branch is protected);
- Bash git commands that discard work: `reset --hard`, `clean` with `-f`/`--force` (any flag
  group), `branch -D` (or `-d` with `-f`), `checkout .` / `checkout -- .`, `restore .` (unless
  only `--staged`), `stash drop` / `stash clear`, `filter-branch`, `update-ref -d`,
  `reflog expire`;
- Bash `git add -A`, `git add --all`, `git add .` (also `./`, `:/`, `*`, `-- .`, combined flags
  such as `-vA`). `git add -u` is allowed: it stages only files git already tracks;
- Bash `git commit` / `git push` with `--no-verify` (and `git commit -n`, also inside a flag
  group such as `-nm`); a value such as `-m "-n"` is not read as a flag, `git push -n` is a dry run;
- Bash `gh api` writes (an explicit non-GET method, or `-f`/`-F`/`--field`/`--raw-field`/`--input`,
  which make gh POST) to `git/refs/heads/<protected>` or to `.../statuses/<sha>` (forging a
  commit status such as devflow/review);
- Bash `gh pr edit` / `gh issue edit` that adds `labels.riskLow` or removes `labels.riskHigh`
  (from `.claude/devflow.json`, default `risk:low` / `risk:high`): a human or the workflow sets
  the risk label;
- Bash `git checkout -f/--force` and `git switch -f/--force/--discard-changes` (they discard
  local changes). `git clean` with `-n`/`--dry-run` is a dry run and is allowed even with `-f`.

Global git options (`git -C <dir>`, `-c k=v`, `--git-dir=...`, `--no-pager`) are skipped before
the subcommand is read.

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
STAGE_ALL_ARGS = frozenset({"-A", "--all", ".", "./", ":/", "*"})
WHOLE_TREE = frozenset({".", "./", ":/", "*"})
STAGE_HINT = "stage the files you changed by name"
DISCARD_HINT = "it discards work that may not be recoverable; ask the user to run it themselves if it is really needed"
MCP_BRANCH_WRITES = ("push_files", "create_or_update_file", "delete_file")
DEFAULT_RISK_LABELS = ("risk:low", "risk:high")
COMMIT_SHORT_WITH_VALUE = frozenset("mFCct")
COMMIT_LONG_WITH_VALUE = frozenset(
    {
        "--message",
        "--file",
        "--author",
        "--date",
        "--reuse-message",
        "--reedit-message",
        "--fixup",
        "--squash",
        "--template",
        "--cleanup",
        "--trailer",
        "--pathspec-from-file",
    }
)
GH_FIELD_FLAGS = frozenset({"--field", "--raw-field", "--input"})
GH_REF_ENDPOINT = re.compile(r"(?:^|/)git/refs/heads/([^?#]*)")
GH_STATUS_ENDPOINT = re.compile(r"(?:^|/)statuses/[^/?#]+/?(?:[?#].*)?$")
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


def load_risk_labels(project_dir):
    """Return (riskLow, riskHigh) label names from `.claude/devflow.json`, with defaults."""
    low, high = DEFAULT_RISK_LABELS
    try:
        with open(
            os.path.join(project_dir, ".claude", "devflow.json"), encoding="utf-8"
        ) as fh:
            labels = json.load(fh).get("labels")
        if isinstance(labels, dict):
            low = str(labels.get("riskLow") or low)
            high = str(labels.get("riskHigh") or high)
    except (OSError, ValueError, AttributeError):
        pass
    return low, high


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
        # Wrapper options differ per tool and platform, so every later git / gh / shell token is
        # tried as the start of the wrapped command (`sudo -u git git add .` included).
        for i in range(1, len(tokens)):
            if base_name(tokens[i]) in ("git", "gh") or base_name(tokens[i]) in SHELLS:
                yield from iter_commands(tokens[i:], split)
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


def api_method(tokens):
    """Explicit HTTP method of a `gh api` call ('' when none was given)."""
    method = ""
    for j, tok in enumerate(tokens):
        if tok in ("-X", "--method") and j + 1 < len(tokens):
            method = tokens[j + 1].upper()
        elif tok.startswith("--method="):
            method = tok.split("=", 1)[1].upper()
        elif tok.startswith("-X") and len(tok) > 2:
            method = tok[2:].upper()
    return method


def api_has_fields(tokens):
    """True when `gh api` gets request fields or a body (gh then defaults to POST)."""
    for tok in tokens:
        if tok.startswith("--"):
            if tok.split("=", 1)[0] in GH_FIELD_FLAGS:
                return True
        elif tok[:2] in ("-f", "-F"):
            return True
    return False


def option_values(tokens, name):
    """Comma-separated values of every `name <v>` / `name=<v>` option in `tokens`."""
    values = []
    for j, tok in enumerate(tokens):
        if tok == name and j + 1 < len(tokens):
            values.extend(tokens[j + 1].split(","))
        elif tok.startswith(name + "="):
            values.extend(tok.split("=", 1)[1].split(","))
    return [v.strip().casefold() for v in values]


def check_gh(tokens, protected=DEFAULT_PROTECTED, labels=DEFAULT_RISK_LABELS):
    """Reason string if the `gh` call is not allowed, else None."""
    if any(GRAPHQL_MERGE.search(t) for t in tokens):
        return "merging a pull request through the GraphQL API. Humans own merges"
    words, i = [], 1
    while i < len(tokens):
        if tokens[i] in GH_OPTIONS_WITH_VALUE:
            i += 2
            continue
        if not tokens[i].startswith("-"):
            words.append(tokens[i])
        i += 1
    if words[:2] == ["pr", "merge"]:
        return "'gh pr merge'. Humans own merges"
    if words[:1] == ["api"]:
        method = api_method(tokens)
        endpoint = any(GH_MERGE_ENDPOINT.search(t) for t in words[1:])
        if endpoint and method != "GET":
            return "'gh api' call to a merge endpoint. Humans own merges"
        if method not in ("", "GET") or (method == "" and api_has_fields(tokens)):
            for word in words[1:]:
                ref = GH_REF_ENDPOINT.search(word)
                if ref and is_protected(ref.group(1), protected):
                    return (
                        "'gh api' write to the protected branch ref '%s' "
                        "(deleting or moving a protected branch)" % ref.group(1)
                    )
                if GH_STATUS_ENDPOINT.search(word):
                    return (
                        "'gh api' write to a commit status (forging a check result such as "
                        "devflow/review)"
                    )
    if words[:2] in (["pr", "edit"], ["issue", "edit"]):
        low, high = labels
        if low.casefold() in option_values(tokens, "--add-label"):
            return "adding the label '%s'; a human or the workflow sets the risk label" % low
        if high.casefold() in option_values(tokens, "--remove-label"):
            return "removing the label '%s'; a human or the workflow sets the risk label" % high
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


def short_flags(args):
    """The letters of every short option group in `args` (`-dfx` -> d, f, x), before `--`."""
    letters = set()
    for arg in args:
        if arg == "--":
            break
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            letters.update(arg[1:])
    return letters


def long_flags(args):
    names = set()
    for arg in args:
        if arg == "--":
            break
        if arg.startswith("--"):
            names.add(arg.split("=", 1)[0])
    return names


def operands_of(args):
    """Non-option arguments; everything after `--` counts."""
    out, rest = [], False
    for arg in args:
        if rest:
            out.append(arg)
        elif arg == "--":
            rest = True
        elif not arg.startswith("-"):
            out.append(arg)
    return out


def scan_flags(args, short_with_value, long_with_value):
    """(short letters, long names) of `args`, skipping the values of options that take one."""
    shorts, longs, i = set(), set(), 0
    while i < len(args):
        arg = args[i]
        i += 1
        if arg == "--":
            break
        if arg.startswith("--"):
            name = arg.split("=", 1)[0]
            longs.add(name)
            if name in long_with_value and "=" not in arg:
                i += 1
        elif arg.startswith("-") and len(arg) > 1:
            for k, letter in enumerate(arg[1:], 1):
                shorts.add(letter)
                if letter in short_with_value:
                    if k == len(arg) - 1:
                        i += 1  # the value is the next argument
                    break  # otherwise the rest of the group is the value
    return shorts, longs


def check_add(args):
    for arg in args:
        if arg in STAGE_ALL_ARGS:
            return "'git add %s' stages everything; %s" % (arg, STAGE_HINT)
        if arg.startswith("-") and not arg.startswith("--") and "A" in arg[1:]:
            return "'git add %s' stages everything; %s" % (arg, STAGE_HINT)
    return None


def check_destructive(sub, args):
    """Reason string if the git subcommand `sub` with `args` discards work, else None."""
    short, long_, ops = short_flags(args), long_flags(args), operands_of(args)
    found = None
    if sub == "reset" and "--hard" in long_:
        found = "git reset --hard"
    elif sub == "clean" and ("f" in short or "--force" in long_):
        if "n" not in short and "--dry-run" not in long_:
            found = "git clean -f"
    elif sub == "checkout" and ("f" in short or "--force" in long_):
        found = "git checkout -f"
    elif sub == "switch" and ("f" in short or {"--force", "--discard-changes"} & long_):
        found = "git switch -f"
    elif sub == "branch":
        deleting = "d" in short or "--delete" in long_
        if "D" in short or (deleting and ("f" in short or "--force" in long_)):
            found = "git branch -D"
    elif sub == "checkout" and any(op in WHOLE_TREE for op in ops):
        found = "git checkout ."
    elif sub == "restore" and any(op in WHOLE_TREE for op in ops):
        staged_only = ("S" in short or "--staged" in long_) and not (
            "W" in short or "--worktree" in long_
        )
        if not staged_only:
            found = "git restore ."
    elif sub == "stash" and ops[:1] in (["drop"], ["clear"]):
        found = "git stash %s" % ops[0]
    elif sub == "filter-branch":
        found = "git filter-branch"
    elif sub == "update-ref" and ("d" in short or "--delete" in long_):
        found = "git update-ref -d"
    elif sub == "reflog" and ops[:1] == ["expire"]:
        found = "git reflog expire"
    if found:
        return "'%s' %s" % (found, DISCARD_HINT)
    return None


def check_git(tokens, protected, branch_of):
    """Reason string if the `git` call is not allowed, else None."""
    i, _ = strip_options(tokens, GIT_OPTIONS_WITH_VALUE)
    if i >= len(tokens):
        return None
    sub, args = tokens[i], tokens[i + 1 :]
    if sub == "commit":
        shorts, longs = scan_flags(args, COMMIT_SHORT_WITH_VALUE, COMMIT_LONG_WITH_VALUE)
        if "n" in shorts or "--no-verify" in longs:
            return NO_VERIFY_REASON
    if sub == "push":
        if "--no-verify" in scan_flags(args, frozenset("o"), PUSH_OPTIONS_WITH_VALUE)[1]:
            return NO_VERIFY_REASON
        return check_push(tokens, protected, branch_of)
    if sub == "add":
        return check_add(args)
    return check_destructive(sub, args)


NO_VERIFY_REASON = (
    "'--no-verify' skips the project's hooks (the checks that guard commits and pushes); "
    "let them run"
)
PUSH_HINT = "Humans own merges and protected branches (%s); push your own feature branch instead"


def check_push(tokens, protected, branch_of):
    """Reason string if the `git push` call is not allowed, else None."""
    reason = push_reason(tokens, protected, branch_of)
    if reason:
        return "%s. %s" % (reason, PUSH_HINT % ", ".join(sorted(protected)))
    return None


def push_reason(tokens, protected, branch_of):
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


def reasons(command, protected, branch_of, labels=DEFAULT_RISK_LABELS):
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
            if tokens[0] == "gh":
                reason = check_gh(tokens, protected, labels)
            else:
                reason = check_git(tokens, protected, branch_of)
            if reason and reason not in found:
                found.append(reason)
    return found


def mcp_write_reason(branch, protected):
    """Reason string if an MCP file write to `branch` is not allowed, else None."""
    branch = branch.strip() if isinstance(branch, str) else ""
    if not branch:
        return (
            "this write names no branch, so it would go to the repository's default branch; "
            "pass your own feature branch"
        )
    if is_protected(resolve(branch, ""), protected):
        return "writing files straight to the protected branch '%s'; %s" % (
            branch,
            PUSH_HINT % ", ".join(sorted(protected)),
        )
    return None


def main():
    payload = json.load(sys.stdin)
    tool = payload.get("tool_name", "")
    if tool.endswith("merge_pull_request"):
        print(
            "Blocked: devflow never merges pull requests; a human merges them.",
            file=sys.stderr,
        )
        return 2
    project_dir = (
        os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    )
    if tool.endswith(MCP_BRANCH_WRITES):
        reason = mcp_write_reason(
            (payload.get("tool_input") or {}).get("branch"), load_protected(project_dir)
        )
        if reason:
            print("Blocked by the devflow guard: %s." % reason, file=sys.stderr)
            return 2
        return 0
    if tool != "Bash":
        return 0
    command = (payload.get("tool_input") or {}).get("command", "")
    protected = load_protected(project_dir)
    work_dir = payload.get("cwd") or project_dir

    def branch_of(directory):
        return current_branch(
            os.path.join(work_dir, directory) if directory else work_dir
        )

    found = reasons(command, protected, branch_of, load_risk_labels(project_dir))
    if found:
        print("Blocked by the devflow guard: %s." % found[0], file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
