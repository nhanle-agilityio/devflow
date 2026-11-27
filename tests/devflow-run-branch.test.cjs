'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bin = path.join(__dirname, '..', 'bin/devflow-run');
const fixture = fs.readFileSync(path.join(__dirname, 'engine.test.cjs'), 'utf8').split(/^test\(/m)[0];
const { run, helpers, BASE } = new Function('require', '__dirname', fixture + '\nreturn { run, helpers, BASE };')(require, __dirname);
const title = '[wave3-unattended-runs] T4: Decide-or-block classification of questions';
const branch = 'feat/105-decide-or-block-classification-of';

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  function git(...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, contents) {
    fs.writeFileSync(path.join(cwd, file), contents);
  }
  function commit(file, contents, message) {
    write(file, contents);
    git('add', '--', file);
    git('commit', '-m', message);
  }
  git('init', '-b', 'main');
  git('init', '--bare', path.join(dir, 'origin.git'));
  git('config', 'user.name', 'Devflow Test');
  git('config', 'user.email', 'devflow@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(cwd, '.claude'));
  commit('.claude/devflow.json', JSON.stringify({ baseBranch: 'main', protectedBranches: ['production', 'release/*'] }), 'initial config');
  commit('shared', 'base\n', 'base contents');
  git('remote', 'add', 'origin', path.join(dir, 'origin.git'));
  git('push', '-u', 'origin', 'main');

  function invoke(...args) {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
    assert.ok(result.stdout, result.stderr || String(result.error));
    return { status: result.status, ...JSON.parse(result.stdout) };
  }
  function setup(name = branch, ...options) {
    return invoke('branch', '--issue', '105', '--name', name, '--from', 'origin/main', ...options);
  }
  return { git, write, commit, invoke, setup };
}

test('M2.1 branchNameFor is deterministic for the Wave 3 issue', async () => {
  const { branchNameFor } = await helpers();
  const issue = { number: 105, title, labels: ['type:feat'] };
  for (let i = 0; i < 2; i++) assert.equal(branchNameFor(issue, '{type}/{issue}-{slug}'), branch);
});

test('M2.2 slugs strip task prefixes and split on non-ASCII and punctuation', async () => {
  const { branchNameFor } = await helpers();
  assert.equal(branchNameFor({ number: 2, title: '[demo] T17: Fix é—API!', labels: [] }, '{type}/{issue}-{slug}'), 'fix/2-fix-api');
});

test('M2.3 creates a branch from the supplied ref', (t) => {
  const r = repo(t);
  const head = r.git('rev-parse', 'origin/main');
  assert.deepEqual(r.setup(), { status: 0, ok: true, branch, action: 'created', head, commits: [], conflicts: [] });
  assert.equal(r.git('branch', '--show-current'), branch);
});

test('M2.4 tracks a remote-only branch and reports its own commits', (t) => {
  const r = repo(t);
  r.git('switch', '-c', 'seed');
  r.commit('own', 'work', 'feat(#105): earlier work');
  const head = r.git('rev-parse', 'HEAD');
  r.git('push', 'origin', 'HEAD:refs/heads/' + branch);
  r.git('switch', 'main');
  const result = r.setup();
  assert.equal(result.action, 'resumed');
  assert.equal(result.head, head);
  assert.match(result.commits[0], /^[a-f0-9]+ feat\(#105\): earlier work$/);
  assert.equal(result.commits.length, 1);
  assert.equal(r.git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/' + branch);
});

test('M2.5 merges parents in order and aborts a conflicting merge', (t) => {
  const r = repo(t);
  r.git('switch', '-c', 'parent-one');
  r.commit('shared', 'first\n', 'first parent change');
  r.git('push', 'origin', 'parent-one');
  r.git('switch', '-c', 'parent-two', 'main');
  r.commit('shared', 'second\n', 'second parent change');
  r.git('push', 'origin', 'parent-two');
  const result = r.setup(branch, '--parents', 'parent-one,parent-two');
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, [{ parent: 'parent-two', files: ['shared'] }]);
  assert.equal(r.git('show', 'HEAD:shared'), 'first');
  assert.equal(r.git('status', '--porcelain'), '');
});

test('M2.6 refuses protected branch names and missing configuration', (t) => {
  const r = repo(t);
  for (const name of ['main', 'production', 'release/3']) {
    const result = r.setup(name);
    assert.equal(result.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.error, /protected/i);
  }
  r.git('mv', '.claude/devflow.json', 'config.backup');
  const missing = r.setup();
  assert.equal(missing.status, 1);
  assert.match(missing.error, /config/i);
});

// #198: two scoped alternates no longer block; the run continues on one picked by name and records it.
test('M2.7 the engine resumes one scoped alternate and picks one of two', async (t) => {
  const r = repo(t);
  const old = 'feat/105-old-slug';
  r.git('switch', '-c', old);
  r.commit('own', 'work', 'feat(#105): earlier work');
  r.git('switch', '-c', 'feat/105-unscoped', 'main');
  r.commit('manual', 'work', 'feat: unrelated work');
  r.git('switch', 'main');
  const options = {
    agentResult(prompt, { label }) {
      if (label === 'select issues') return { issues: [{ number: 105, title, labels: ['type:feat'], body: '', parents: [], dependsOn: [] }], skipped: [] };
      if (label === 'branch #105') {
        assert.match(prompt, /node "\/plugin\/bin\/devflow-run" branch/);
        assert.ok(prompt.includes(branch));
        return r.setup();
      }
    },
  };
  const first = await run({ ...BASE, issues: [105] }, options);
  assert.equal(first.rep[0].branch, old);
  assert.ok(first.rep[0].notes.includes(`resumed existing branch ${old} (name differs from ${branch})`));
  r.git('switch', '-c', 'feat/105-other-slug', 'main');
  r.commit('other', 'work', 'fix(#105): another attempt');
  r.git('switch', 'main');
  const second = await run({ ...BASE, issues: [105] }, options);
  assert.ok(!(second.rep[0].status === 'blocked' && second.rep[0].questionCount), 'no branch question');
  const note = second.rep[0].notes.find((n) => n.startsWith('several branches match #105'));
  assert.ok(note, JSON.stringify(second.rep[0]));
  assert.match(note, /feat\/105-old-slug/);
  assert.match(note, /feat\/105-other-slug/);
  assert.match(note, /continued on feat\/105-old-slug/);
  assert.equal(r.git('branch', '--show-current'), 'main');
});

test('M2.8 restores a clean checkout and reports dirty files', (t) => {
  const r = repo(t);
  r.git('switch', '-c', branch);
  r.write('untracked file', 'local work');
  assert.deepEqual(r.invoke('restore', '--to', 'main'), {
    status: 0, ok: true, restored: false, reason: 'uncommitted changes', files: ['untracked file'],
  });
  assert.equal(r.git('branch', '--show-current'), branch);
  r.commit('untracked file', 'local work', 'test(#105): save fixture');
  assert.deepEqual(r.invoke('restore', '--to', 'main'), { status: 0, ok: true, restored: true });
  assert.equal(r.git('branch', '--show-current'), 'main');
});
