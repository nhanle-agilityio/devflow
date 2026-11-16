'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { allowRules, minimalConfig, ownedLeftovers } = require('../bin/devflow-setup');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'init', 'templates', 'devflow.schema.json'), 'utf8'));

const CFG = {
  github: { owner: 'acme', repo: 'shop', remote: 'upstream' },
  baseBranch: 'develop',
  checks: [
    { name: 'test', run: 'make test' },
    { name: 'lint', run: '.venv/bin/ruff check . && .venv/bin/mypy src' },
  ],
  verify: { modes: ['http', 'browser'], devServer: { run: 'make run', url: 'http://127.0.0.1:5050' }, browserTool: 'playwright' },
  worktree: { setup: ['make setup'] },
};

test('allowRules: checks, verify, worktree setup and the remote', () => {
  const allow = allowRules(CFG);
  for (const r of [
    'Bash(make test:*)',
    'Bash(.venv/bin/ruff check:*)',
    'Bash(.venv/bin/mypy src:*)',
    'Bash(make run:*)',
    'Bash(make setup:*)',
    'Bash(curl http://127.0.0.1:5050/*)',
    'Bash(git push -u upstream:*)',
    'Bash(git push upstream:*)',
    'Bash(git fetch:*)',
    'Bash(git worktree:*)',
    'mcp__playwright__*',
    'mcp__github__*',
  ]) {
    assert.ok(allow.includes(r), `missing ${r}`);
  }
  assert.deepEqual(allow, [...new Set(allow)].sort());
});

test('allowRules never allows merging, force pushes or staging everything', () => {
  const allow = allowRules(CFG).join(' ');
  assert.doesNotMatch(allow, /merge_pull_request|gh pr merge|--force|git push:\*|git add -A|git reset --hard/);
});

test('allowRules: chrome tool, no http mode, custom MCP prefix, origin default', () => {
  const allow = allowRules({ github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: [], verify: { modes: ['browser'], browserTool: 'chrome' } }, { githubMcp: 'mcp__0322__*' });
  assert.ok(allow.includes('mcp__claude-in-chrome__*'));
  assert.ok(allow.includes('mcp__0322__*'));
  assert.ok(!allow.includes('mcp__github__*'));
  assert.ok(!allow.includes('Bash(curl:*)'));
  assert.ok(allow.includes('Bash(git push -u origin:*)'));
});

test('minimalConfig keeps required keys and drops values equal to the schema defaults', () => {
  const full = {
    $schema: './devflow.schema.json',
    devflowVersion: '2.7.0',
    github: { owner: 'acme', repo: 'shop', remote: 'origin' },
    baseBranch: 'main',
    checks: [{ name: 'test', run: 'npm test' }],
    branchPattern: '{type}/{issue}-{slug}',
    labels: { ready: 'agent:ready', blocked: 'blocked', priority: ['priority:critical', 'priority:high', 'priority:normal', 'priority:low'] },
    nextTask: { defaultLimit: 3, maxFixRounds: 4 },
    verify: { lock: true, modes: ['http'] },
    mergeGate: { enabled: false, dryRun: true, requiredChecks: ['devflow/review'], method: 'merge' },
  };
  assert.deepEqual(minimalConfig(full, SCHEMA), {
    $schema: './devflow.schema.json',
    devflowVersion: '2.7.0',
    github: { owner: 'acme', repo: 'shop' },
    baseBranch: 'main',
    checks: [{ name: 'test', run: 'npm test' }],
    labels: { blocked: 'blocked' },
    nextTask: { maxFixRounds: 4 },
    verify: { modes: ['http'] },
  });
});

test('minimalConfig drops a default scan.ignore and keeps a custom one', () => {
  const base = { github: { owner: 'a', repo: 'b' }, baseBranch: 'main', checks: [{ name: 't', run: 'make test' }] };
  assert.deepEqual(minimalConfig({ ...base, scan: { ignore: [] } }, SCHEMA), base);
  assert.deepEqual(minimalConfig({ ...base, scan: { ignore: ['tests/fixtures/**'] } }, SCHEMA).scan, { ignore: ['tests/fixtures/**'] });
});

test('minimalConfig does not change its input', () => {
  const full = { github: { owner: 'a', repo: 'b', remote: 'origin' }, baseBranch: 'main', checks: [] };
  const copy = JSON.parse(JSON.stringify(full));
  minimalConfig(full, SCHEMA);
  assert.deepEqual(full, copy);
});

test('ownedLeftovers lists what the plugin now owns, without deleting anything', () => {
  const settings = {
    permissions: { allow: ['Bash(git status:*)'], deny: ['Bash(git push --force:*)', 'Bash(gh pr merge:*)', 'Bash(git push origin main:*)', 'Bash(rm -rf /:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 .claude/hooks/block_git_add_all.py' }] }] },
  };
  const config = { baseBranch: 'main', checks: [{ name: 'hook-test', run: 'python3 -m pytest .claude/hooks' }, { name: 'test', run: 'make test' }] };
  const files = ['.claude/hooks/block_git_add_all.py', '.claude/hooks/test_block_git_add_all.py', '.claude/loop.md', '.claude/agents/code-reviewer.md', 'src/app.py'];
  const out = ownedLeftovers({ settings, config, files });
  const what = out.map((x) => x.what);
  assert.ok(what.includes('.claude/hooks/block_git_add_all.py'));
  assert.ok(what.includes('.claude/hooks/test_block_git_add_all.py'));
  assert.ok(what.includes('settings.json hook running block_git_add_all.py'));
  assert.ok(what.includes('checks entry "hook-test"'));
  assert.ok(what.includes('deny rule Bash(git push --force:*)'));
  assert.ok(what.includes('deny rule Bash(gh pr merge:*)'));
  assert.ok(what.includes('deny rule Bash(git push origin main:*)'));
  assert.ok(!what.includes('deny rule Bash(rm -rf /:*)'));
  assert.ok(what.includes('.claude/loop.md'));
  assert.ok(what.includes('.claude/agents/code-reviewer.md'));
  assert.ok(!what.some((w) => w.includes('src/app.py')));
  assert.ok(out.every((x) => x.why));
});

// ---------------------------------------------------------------------------------------------
// Specific prefixes for interpreters, shells and runners; curl scoped to the dev server
// ---------------------------------------------------------------------------------------------
const { allowPlan } = require('../bin/devflow-setup');
const planFor = (runs, extra = {}) =>
  allowPlan({ github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: runs.map((run, i) => ({ name: 'c' + i, run })), ...extra });
const BARE = /^Bash\((python[\d.]*|node|bash|sh|zsh|npx|uv|uvx|poetry|pipx|env|sudo|bun|bunx|deno|ruby|perl|php|time|nice|nohup|xargs|exec|command|\S*\/(python[\d.]*|node|bash|sh))(:\*)?\)$/;

test('runners keep their flags and subcommand up to the first path or glob', () => {
  const { allow } = planFor([
    'python3 -m pytest tests -q',
    '.venv/bin/python -m pytest',
    'node --test tests/*.test.cjs',
    'npx --yes prettier --check .',
    'uv run pytest -q',
    'poetry run python -m mypy src',
    'bash scripts/check.sh --all',
    'python3 manage.py test',
  ]);
  for (const r of [
    'Bash(python3 -m pytest:*)',
    'Bash(.venv/bin/python -m pytest:*)',
    'Bash(node --test:*)',
    'Bash(npx --yes prettier:*)',
    'Bash(uv run pytest:*)',
    'Bash(poetry run python -m mypy:*)',
    'Bash(bash scripts/check.sh:*)',
    'Bash(python3 manage.py:*)',
  ]) {
    assert.ok(allow.includes(r), `missing ${r} in ${allow.join(' ')}`);
  }
});

test('never a bare interpreter, shell or runner rule; unsafe commands are reported instead', () => {
  const { allow, manual } = planFor([
    'bash -c "make test"',
    'sh -c make',
    'python3 -c "import x"',
    'node -e "1"',
    'env FOO=1 make test',
    'sudo make test',
    'FOO=1 npm test',
    'npx',
    'python3 -u',
    'uv run python',
  ]);
  for (const r of allow) assert.doesNotMatch(r, BARE, r);
  const reported = manual.map((m) => m.command);
  for (const c of ['bash -c "make test"', 'sh -c make', 'python3 -c "import x"', 'node -e "1"', 'env FOO=1 make test', 'sudo make test', 'FOO=1 npm test', 'npx', 'python3 -u', 'uv run python']) {
    assert.ok(reported.includes(c), `not reported: ${c} (${reported.join(' | ')})`);
  }
  assert.ok(manual.every((m) => m.reason));
});

test('plain tools keep their subcommand words', () => {
  const { allow, manual } = planFor(['make test', 'npm run lint', '.venv/bin/ruff check .', 'cargo test --all', 'pytest']);
  for (const r of ['Bash(make test:*)', 'Bash(npm run lint:*)', 'Bash(.venv/bin/ruff check:*)', 'Bash(cargo test:*)', 'Bash(pytest:*)']) {
    assert.ok(allow.includes(r), r);
  }
  assert.deepEqual(manual, []);
});

test('curl is scoped to the dev server origin when it is set', () => {
  let { allow } = planFor([], { verify: { modes: ['http'], devServer: { run: 'make run', url: 'http://127.0.0.1:5050/health' } } });
  assert.ok(allow.includes('Bash(curl http://127.0.0.1:5050/*)'));
  assert.ok(allow.includes('Bash(curl * http://127.0.0.1:5050/*)'));
  assert.ok(!allow.includes('Bash(curl:*)'));
  ({ allow } = planFor([], { verify: { modes: ['http'] } }));
  assert.ok(allow.includes('Bash(curl:*)'));
});

test('the CLI prints the commands that need a rule by hand', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('node', [path.join(__dirname, '..', 'bin', 'devflow-setup'), 'allow'], {
    input: JSON.stringify({ github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: [{ name: 'x', run: 'bash -c "make x"' }] }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.permissions.allow));
  assert.equal(out.manual[0].command, 'bash -c "make x"');
});

// T6.16
test('test_t6_16_allow_has_gh_issue_view_and_no_other_gh_rule', () => {
  const { execFileSync } = require('node:child_process');
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'bin', 'devflow-setup'), 'allow'], { input: JSON.stringify(CFG), encoding: 'utf8' }));
  for (const allow of [out.permissions.allow, allowRules(CFG)]) {
    assert.ok(allow.includes('Bash(gh issue view:*)'));
    assert.deepEqual(allow.filter((r) => /^Bash\(gh\b/.test(r)), ['Bash(gh issue view:*)']);
    assert.ok(!allow.includes('Bash(gh:*)') && !allow.includes('Bash(gh pr merge:*)'));
  }
});
