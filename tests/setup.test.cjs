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
    'Bash(curl:*)',
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
