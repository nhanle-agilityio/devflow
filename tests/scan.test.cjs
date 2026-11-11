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

function ignoreRepo(ignore) {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, '.claude', 'devflow.json'), JSON.stringify({ checks: [{ name: 'test', run: 'make test' }], scan: { ignore } }));
  git('add', '.claude/devflow.json');
  git('commit', '-q', '-m', 'ignore list');
  git('switch', '-q', '-c', 'feat/y');
  return { dir, git };
}

test('files matching scan.ignore are not reported and are listed in ignored', () => {
  const { dir, git } = ignoreRepo(['fixtures/**', 'Makefile']);
  fs.mkdirSync(path.join(dir, 'fixtures'));
  fs.writeFileSync(path.join(dir, 'fixtures', 'f.py'), 'import os  # noqa\n');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\ttrue\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'import os  # noqa\n');
  git('add', 'fixtures/f.py', 'Makefile', 'src/a.py');
  git('commit', '-q', '-m', 'weaken');
  const r = run(dir, 'feat/x', '.claude/devflow.json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.hits.map((h) => h.file), ['src/a.py']);
  assert.deepEqual(out.ignored.sort(), ['Makefile', 'fixtures/f.py']);
});

test('scan.ignore cannot hide a change to .claude/devflow.json', () => {
  const { dir, git } = ignoreRepo(['**']);
  fs.writeFileSync(path.join(dir, '.claude', 'devflow.json'), JSON.stringify({ checks: [], scan: { ignore: ['**'] } }));
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'import os  # noqa\n');
  git('add', '.claude/devflow.json', 'src/a.py');
  git('commit', '-q', '-m', 'cfg');
  const out = JSON.parse(run(dir, 'feat/x', '.claude/devflow.json').stdout);
  assert.deepEqual(out.hits.map((h) => `${h.file} ${h.kind}`), ['.claude/devflow.json check configuration changed']);
  assert.deepEqual(out.ignored, ['src/a.py']);
});

test('a missing or invalid scan.ignore leaves the output unchanged', () => {
  for (const bad of ['**', 5, [1, 2]]) {
    const { dir, git } = ignoreRepo(bad);
    fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'import os  # noqa\n');
    git('add', 'src/a.py');
    git('commit', '-q', '-m', 'w');
    const out = JSON.parse(run(dir, 'feat/x', '.claude/devflow.json').stdout);
    assert.equal(out.ignored, undefined);
    assert.deepEqual(out.hits.map((h) => h.file), ['src/a.py']);
  }
});
