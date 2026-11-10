'use strict';
// bin/devflow-scan runs the weakened-checks scan on a real git diff and prints only the hits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCAN = path.join(__dirname, '..', 'bin', 'devflow-scan');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-scan-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'devflow.json'), JSON.stringify({ checks: [{ name: 'test', run: 'make test' }] }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'import os\n');
  git('add', '.claude/devflow.json', 'src/a.py');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat/x');
  return { dir, git };
}

const run = (dir, ...a) => spawnSync('node', [SCAN, ...a], { cwd: dir, encoding: 'utf8' });

test('prints the hits of the branch diff as JSON', () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'import os  # noqa\n');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\ttrue\n');
  git('add', 'src/a.py', 'Makefile');
  git('commit', '-q', '-m', 'weaken');
  const r = run(dir, 'main', '.claude/devflow.json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.scanned, true);
  const kinds = out.hits.map((h) => `${h.file}:${h.line} ${h.kind}`);
  assert.ok(kinds.includes('src/a.py:1 noqa'), kinds.join(' | '));
  assert.ok(kinds.includes('Makefile:1 check configuration changed'), kinds.join(' | '));
});

test('a clean branch prints no hits', () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'import sys\n');
  git('add', 'src/a.py');
  git('commit', '-q', '-m', 'clean');
  const out = JSON.parse(run(dir, 'main', '.claude/devflow.json').stdout);
  assert.deepEqual(out, { scanned: true, hits: [] });
});

test('a bad ref or a missing argument reports scanned false and exits 1', () => {
  const { dir } = repo();
  let r = run(dir, 'nope/branch', '.claude/devflow.json');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).scanned, false);
  assert.match(JSON.parse(r.stdout).error, /git diff failed/);
  r = run(dir);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).scanned, false);
});

test('a missing config scans with the default check configuration list', () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.ruff]\n');
  git('add', 'pyproject.toml');
  git('commit', '-q', '-m', 'cfg');
  const out = JSON.parse(run(dir, 'main', 'missing.json').stdout);
  assert.equal(out.scanned, true);
  assert.ok(out.hits.some((h) => h.file === 'pyproject.toml'));
});
