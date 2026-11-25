'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bin = path.join(__dirname, '..', 'bin', 'devflow-run');

function repo(t, branch = 'feat/7-x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-commit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);

  function git(...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  function write(file, contents) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  git('init', '-b', 'main');
  git('config', 'user.name', 'Devflow Test');
  git('config', 'user.email', 'devflow@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write('.claude/devflow.json', JSON.stringify({ baseBranch: 'main', protectedBranches: ['release/*'] }));
  git('add', '--', '.claude/devflow.json');
  git('commit', '-m', 'initial config');
  if (branch !== 'main') git('switch', '-c', branch);
  const initialHead = git('rev-parse', 'HEAD');

  function invoke(args, input, worktree = cwd) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd: worktree, input, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.ok(result.stdout, result.stderr || 'Expected devflow-run to print JSON');
    return { status: result.status, ...JSON.parse(result.stdout) };
  }

  function commit(options = {}) {
    return invoke(['commit'], JSON.stringify({
      issue: 7, scope: '#7', type: 'feat', title: 'X',
      qaFiles: ['qa.sh'], devFiles: ['implementation.txt'],
      separate: false, testCommand: 'sh qa.sh', setup: [], ...options,
    }));
  }

  function lock(action, ...options) {
    return invoke(['lock', action, '--name', 'verify', ...options]);
  }

  const lockDir = path.resolve(cwd, git('rev-parse', '--git-common-dir'), 'devflow-verify.lock');
  return { dir, cwd, git, write, initialHead, invoke, commit, lock, lockDir };
}

function changes(r, script = 'test -f implementation.txt\n') {
  r.write('qa.sh', script);
  r.write('implementation.txt', 'implemented\n');
}

function assertSuccess(result) {
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, 0);
}

function assertCommits(r, result, expected) {
  assertSuccess(result);
  assert.deepEqual(result.leftover, []);
  const shas = r.git('rev-list', '--reverse', r.initialHead + '..HEAD').split('\n');
  const commits = expected.map(([message, files], index) => ({
    sha: shas[index], message, files: files.slice().sort(),
  }));
  assert.equal(shas.length, commits.length);
  assert.deepEqual(result.commits.map(({ sha, message, files }) => ({
    sha, message, files: files.slice().sort(),
  })), commits);
  for (const { sha, message, files } of commits) {
    assert.equal(r.git('show', '-s', '--format=%B', sha), message);
    assert.deepEqual(r.git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').sort(), files);
  }
  assert.equal(r.git('status', '--porcelain'), '');
}

test('M3.1 commits the QA file before the dev file', (t) => {
  const r = repo(t);
  changes(r);
  assertCommits(r, r.commit(), [
    ['test(#7): tests for X', ['qa.sh']],
    ['feat(#7): X', ['implementation.txt']],
  ]);
});

test('M3.2 separates docs from code and keeps skill and agent files with code', (t) => {
  const r = repo(t);
  changes(r);
  const docs = ['README.md', 'docs/guide.md', 'changelog.d/7.md'];
  const code = ['implementation.txt', 'skills/a/SKILL.md', 'agents/a.md'];
  for (const file of [...docs, ...code.slice(1)]) r.write(file, 'changed\n');
  assertCommits(r, r.commit({ devFiles: [...code, ...docs], separate: true }), [
    ['test(#7): tests for X', ['qa.sh']],
    ['feat(#7): X', code],
    ['docs(#7): docs for X', docs],
  ]);
});

test('M3.3 reports leftover paths and leaves history and the index alone', (t) => {
  const r = repo(t);
  changes(r);
  r.write('extra file.txt', 'out of scope\n');
  r.git('add', '--', 'extra file.txt');
  const before = r.git('status', '--porcelain');
  const result = r.commit();
  assert.deepEqual(result.leftover, ['extra file.txt'], result.error);
  assert.equal(r.git('rev-parse', 'HEAD'), r.initialHead);
  assert.equal(r.git('status', '--porcelain'), before);
});

test('M3.4 confirms red at the test commit and cleans up the worktree without changing the stash', (t) => {
  const r = repo(t);
  r.write('saved.txt', 'saved work\n');
  r.git('stash', 'push', '--include-untracked', '-m', 'existing stash', '--', 'saved.txt');
  const stash = r.git('stash', 'list');
  assert.match(stash, /existing stash/);
  const worktrees = r.git('worktree', 'list', '--porcelain');
  changes(r, [
    'test ! -e implementation.txt || exit 0',
    'git symbolic-ref -q HEAD >/dev/null && exit 0',
    'test -f setup-marker || exit 0',
    'rm setup-marker',
    'i=1',
    'while [ "$i" -le 45 ]; do echo "red line $i"; i=$((i + 1)); done',
    'exit 1',
  ].join('\n') + '\n');
  const result = r.commit({ setup: ['printf ready > setup-marker'] });
  assertSuccess(result);
  assert.equal(result.redConfirmed, true);
  assert.deepEqual(result.redOutput.trimEnd().split('\n'), Array.from({ length: 40 }, (_, i) => 'red line ' + (i + 6)));
  assert.equal(r.git('worktree', 'list', '--porcelain'), worktrees.replace(r.initialHead, r.git('rev-parse', 'HEAD')));
  assert.equal(r.git('stash', 'list'), stash);
});

test('M3.5 reports false when the tests pass at the test commit', (t) => {
  const r = repo(t);
  changes(r, 'echo "QA passed"\n');
  const result = r.commit();
  assertSuccess(result);
  assert.equal(result.redConfirmed, false);
  assert.match(result.redOutput, /QA passed/);
});

test('M3.6 refuses to commit on main', (t) => {
  const r = repo(t, 'main');
  changes(r);
  const result = r.commit();
  assert.equal(result.status, 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /protected branch.*main/i, result.error);
  assert.equal(r.git('rev-parse', 'HEAD'), r.initialHead);
});

test('M4.1 acquires and releases the shared verify lock', (t) => {
  const r = repo(t);
  const acquired = r.lock('acquire');
  assertSuccess(acquired);
  assert.equal(acquired.acquired, true);
  assert.ok(fs.statSync(r.lockDir).isDirectory());

  const sibling = path.join(path.dirname(r.lockDir), 'devflow-other.lock');
  fs.mkdirSync(sibling);
  assertSuccess(r.lock('release'));
  assert.equal(fs.existsSync(r.lockDir), false);
  assert.ok(fs.statSync(sibling).isDirectory());
});

test('M4.2 reports a fresh lock as busy from another worktree', (t) => {
  const r = repo(t);
  const linked = path.join(r.dir, 'linked');
  r.git('worktree', 'add', '--detach', linked);
  fs.mkdirSync(r.lockDir);

  const result = r.invoke(['lock', 'acquire', '--name', 'verify', '--wait', '1'], undefined, linked);
  assertSuccess(result);
  assert.equal(result.acquired, false);
  assert.ok(result.heldSince, 'Expected heldSince for the busy lock');
  assert.ok(fs.statSync(r.lockDir).isDirectory());
});

test('M4.3 replaces a verify lock older than 30 minutes', (t) => {
  const r = repo(t);
  fs.mkdirSync(r.lockDir);
  const stale = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(r.lockDir, stale, stale);

  const result = r.lock('acquire');
  assertSuccess(result);
  assert.equal(result.acquired, true);
  assert.ok(fs.statSync(r.lockDir).mtimeMs > stale.getTime());
});
