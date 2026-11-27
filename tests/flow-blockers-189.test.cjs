'use strict';
// #189: flow blockers found on the first autopilot run (sandbox epic #5): absolute paths from agents, a chain running on
// a dirty tree, reruns colliding with an empty kept branch, lanes sharing one local database, 25-minute ticks, and a
// wrong lane note.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'devflow-run');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('workflows/next-task-engine.js').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---- git repo helper -----------------------------------------------------------------------------------------
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-189-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Devflow Test');
  git('config', 'user.email', 'devflow@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write('.claude/devflow.json', JSON.stringify({ baseBranch: 'main', protectedBranches: [] }));
  git('add', '--', '.claude/devflow.json');
  git('commit', '-m', 'initial');
  git('switch', '-c', 'feat/7-x');
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', timeout: 20000 });
    assert.ok(r.stdout, r.stderr);
    return { status: r.status, ...JSON.parse(r.stdout) };
  };
  const runAsync = (args, input) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    if (input !== undefined) child.stdin.end(input);
    let exited = false;
    const done = new Promise((resolve) => child.on('close', (status) => { exited = true; resolve({ status, ...JSON.parse(out) }); }));
    return { done, exited: () => exited };
  };
  const lockDir = (name) => path.join(cwd, '.git', `devflow-${name}.lock`);
  return { cwd, git, write, run, runAsync, lockDir };
}
const payload = (extra) => JSON.stringify({
  issue: 7, scope: '#7', type: 'feat', title: 'X', qaFiles: ['qa.sh'], devFiles: ['impl.txt'],
  separate: false, testCommand: 'sh qa.sh', setup: [], ...extra,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// F1
test('F1 commit accepts absolute paths under the repository root', (t) => {
  const r = repo(t);
  r.write('qa.sh', 'test -f impl.txt\n');
  r.write('impl.txt', 'x\n');
  const out = r.run(['commit'], payload({ qaFiles: [path.join(r.cwd, 'qa.sh')], devFiles: [path.join(r.cwd, 'impl.txt')] }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.leftover || [], []);
  assert.equal(out.commits.length, 2);
  assert.equal(r.git('status', '--porcelain'), '');
});

// F2
test('F2 an unlisted non-QA file goes into the code commit and is reported', (t) => {
  const r = repo(t);
  r.write('qa.sh', 'test -f impl.txt\n');
  r.write('impl.txt', 'x\n');
  r.write('notes/extra.txt', 'y\n');
  const out = r.run(['commit'], payload());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.unlisted, ['notes/extra.txt']);
  assert.ok(out.commits[1].files.includes('notes/extra.txt'), 'in the code commit');
  assert.equal(r.git('status', '--porcelain'), '');
});

// F3
test('F3 the engine treats an absolute path and its repo-relative form as one file', async () => {
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  const h = await fn({ exports: true }, null, () => {}, () => {}, null);
  assert.equal(typeof h.outside, 'function');
  assert.equal(typeof h.overlap, 'function');
  assert.deepEqual(h.outside(['/Users/me/repo/.claude/worktrees/lane-1/tests/a.py'], ['tests/a.py']), []);
  assert.deepEqual(h.overlap(['tests/a.py'], ['/Users/me/repo/tests/a.py']), ['tests/a.py']);
  assert.deepEqual(h.outside(['src/b.py'], ['tests/a.py']), ['src/b.py']);
});

// F4
test('F4 park stashes a dirty tree with a named message and reports a clean one', (t) => {
  const r = repo(t);
  assert.equal(r.run(['park', '--issue', '10', '--stage', 'Implement']).stashed, false);
  r.write('new.sql', 'create table x();\n');
  r.write('.claude/devflow.json', '{"baseBranch":"main","protectedBranches":[],"x":1}');
  const out = r.run(['park', '--issue', '10', '--stage', 'Implement']);
  assert.equal(out.ok, true);
  assert.equal(out.stashed, true);
  assert.equal(out.message, 'devflow #10 blocked at Implement');
  assert.equal(r.git('status', '--porcelain'), '');
  assert.match(r.git('stash', 'list'), /devflow #10 blocked at Implement/);
});

// ---- engine harness -----------------------------------------------------------------------------------------
const BOOLS = ['productDecision', 'reversible', 'changesCriterion', 'dropsMustRow', 'changesContract', 'changesStoredFormat', 'lowersRisk', 'skipsCheck', 'needsDestructiveGit', 'outsideRepo'];
async function engine(args, opts = {}) {
  const calls = [];
  const agent = async (prompt, o) => {
    const l = o.label;
    calls.push({ l, prompt });
    const n = Number((/#(\d+)/.exec(l) || [])[1]);
    if (l === 'select issues') return { issues: args.issues.map((i) => ({ number: i, title: 't' + i, labels: ['risk:high'], body: 'Epic: #5', dependsOn: [], parents: (opts.parents && opts.parents[i]) || [] })), skipped: [] };
    if (l.startsWith('claim')) return { taken: false, assignedByRun: false, claims: [{ commentId: 10 + n, claimId: args.claimId, createdAt: '2026-01-01T00:00:05Z', author: 'me' }], labels: ['risk:high'], specPath: '', introducedBy: false, lastBlockedAt: null };
    if (l.startsWith('branch')) return { ok: true, branch: 'feat/' + n + '-x' };
    if (l.startsWith('plan')) {
      if (opts.blockPlan && opts.blockPlan.includes(n)) return { status: 'blocked', plan: 'P', questions: ['[BA] Which behavior does the owner require?'], qaFiles: [], devFiles: [], specRead: '#5', epicRead: true, acceptanceCriteria: 0, httpOrE2eRows: false };
      return { status: 'ready', plan: 'PLAN', questions: [], qaFiles: ['tests/t.py'], devFiles: ['src/x.py'], specRead: '#5', epicRead: true, acceptanceCriteria: 0, httpOrE2eRows: false };
    }
    if (l.startsWith('qa')) return { status: 'done', tests: [{ rowId: 'T1.1', test: 't' }], filesChanged: ['tests/t.py'], questions: [], specRead: '#5', epicRead: true };
    if (l.startsWith('commit')) return { ok: true, commits: ['t1 test(#1): x', 'c1 feat(#1): x'], redConfirmed: true };
    if (l.startsWith('implement') || l.startsWith('fix')) return { status: 'done', summary: 's', commits: [], filesChanged: ['src/x.py'], assumptions: [], outOfScope: [], touchesUi: false, specRead: '#5', epicRead: true, questions: [] };
    if (l.startsWith('check')) return { passed: true, failures: [] };
    if (l.startsWith('scan')) return { scanned: true, hits: [], changedFiles: ['src/x.py'], files: ['src/x.py'] };
    if (l.startsWith('review')) return { issueRead: true, epicRead: true, verdict: 'pass', findings: [] };
    if (l.startsWith('ship')) return { ok: true, prNumber: 100 + n, url: 'u' + n };
    if (l.startsWith('blocked')) return { ok: true, pushed: false };
    return { ok: true, released: true, files: ['src/x.py'], changedFiles: ['src/x.py'], claimPresent: false };
  };
  const parallel = async (fns) => Promise.all(fns.map((f) => f()));
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  const rep = await fn(args, agent, () => {}, () => {}, parallel);
  return { rep, calls };
}
const CFG = { github: { owner: 'o', repo: 'r', remote: 'origin' }, baseBranch: 'develop', checks: [{ name: 'test', run: 'make test' }], risk: { highPaths: [] } };
const ARGS = { config: CFG, limit: 3, startBranch: '', isolated: true, prTemplatePath: '', claimId: '20261126T100000-lane-1-2', runDate: '2026-11-26', pluginRoot: '/plugin' };

// F5
test('F5 a blocked issue parks its uncommitted work and names the stash in the comment', async () => {
  const { calls } = await engine({ ...ARGS, issues: [1] }, { blockPlan: [1] });
  const blocked = calls.find((c) => c.l.startsWith('blocked'));
  assert.ok(blocked, 'blocked cleanup ran');
  assert.match(blocked.prompt, /devflow-run" park --issue 1 --stage Plan/);
  assert.match(blocked.prompt, /stash/i);
});

// F6
test('F6 after a blocked issue, the next chained issue with a PR parent is reported as stacked on it', async () => {
  const parents = { 2: [{ issue: 9, prNumber: 25, branch: 'feat/9-x', inRun: false }] };
  const { rep } = await engine({ ...ARGS, issues: [1, 2], chain: true }, { blockPlan: [1], parents });
  const second = rep.find((r) => r.issue === 2);
  assert.ok(second, JSON.stringify(rep));
  const notes = (second.notes || []).join('; ');
  assert.match(notes, /stacked on #9/);
  assert.doesNotMatch(notes, /started from develop/);
});

// F7
test('F7 next-task isolated report removes empty created branches and a clean worktree', () => {
  const report = read('skills/next-task/SKILL.md').split('## 4. Report')[1].split('\n\nThen print')[0];
  assert.match(report, /no commits beyond/);
  assert.match(report, /git branch -d/);
  assert.match(report, /every branch with commits is pushed/);
});

// F8
test('F8 a check with a lock waits while the lock is held and releases it after', async (t) => {
  const r = repo(t);
  r.write('cfg.json', JSON.stringify({ checks: [{ name: 'test', run: 'touch ran', lock: 'db' }] }));
  fs.mkdirSync(r.lockDir('db'));
  const p = r.runAsync(['check', '--config', 'cfg.json']);
  await sleep(1500);
  assert.equal(fs.existsSync(path.join(r.cwd, 'ran')), false, 'did not run while locked');
  fs.rmdirSync(r.lockDir('db'));
  const out = await p.done;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.passed, true);
  assert.equal(out.checks[0].lock, 'db');
  assert.equal(fs.existsSync(r.lockDir('db')), false, 'lock released');
});

// F9
test('F9 the schema has checks[].lock in the template and the repo copy', () => {
  const tpl = read('skills/init/templates/devflow.schema.json');
  assert.equal(tpl, read('.claude/devflow.schema.json'));
  const lock = JSON.parse(tpl).properties.checks.items.properties.lock;
  assert.ok(lock, 'lock property');
  assert.equal(lock.type, 'string');
  assert.equal(lock.pattern, '^[a-zA-Z0-9_-]+$');
});

// F10
test('F10 the commit red check holds testLock', async (t) => {
  const r = repo(t);
  r.write('qa.sh', 'test -f impl.txt\n');
  r.write('impl.txt', 'x\n');
  fs.mkdirSync(r.lockDir('db'));
  const p = r.runAsync(['commit'], payload({ testLock: 'db' }));
  await sleep(1500);
  assert.equal(p.exited(), false, 'waits for the lock');
  fs.rmdirSync(r.lockDir('db'));
  const out = await p.done;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.redConfirmed, true);
  assert.equal(fs.existsSync(r.lockDir('db')), false, 'lock released');
});

// F11
test('F11 a check with a lock makes stage prompts use devflow-run check and forbid manual resets', async () => {
  const cfg = { ...CFG, checks: [{ name: 'test', run: 'make test', lock: 'db' }] };
  const { calls } = await engine({ ...ARGS, config: cfg, issues: [1] });
  const impl = calls.find((c) => c.l.startsWith('implement'));
  assert.ok(impl, 'implement ran');
  assert.match(impl.prompt, /lock "db"/);
  assert.match(impl.prompt, /devflow-run" check/);
  assert.match(impl.prompt, /never reset or migrate/i);
  const plain = await engine({ ...ARGS, issues: [1] });
  assert.doesNotMatch(plain.calls.find((c) => c.l.startsWith('implement')).prompt, /never reset or migrate/i);
});

// F12
test('F12 the autopilot loop wakes on lane changes with a Monitor and keeps a long fallback', () => {
  const loop = read('skills/autopilot/SKILL.md').split('## 3. Loop')[1].split('## 4.')[0];
  assert.match(loop, /Monitor/);
  assert.match(loop, /claude agents --json/);
  assert.match(loop, /60.120 seconds/);
  assert.match(loop, /ScheduleWakeup/);
  assert.match(loop, /1200.1800/);
});
