'use strict';
// Runs workflows/next-task-engine.js against stub agents: every stage returns a canned result, so the
// engine's own decisions (stacking, claims, ownership, blocking, notes) are tested without GitHub or a model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'next-task-engine.js'), 'utf8').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = {
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
};
const BASE = { config: CFG, limit: 3, startBranch: 'main', prTemplatePath: '', claimId: 'C-me' };
const QA = { qaFiles: ['tests/test_a.py'], devFiles: ['src/x.py'] };

// opts: per-stage overrides, each a function of the issue number or a plain value.
async function run(args, opts = {}) {
  const calls = [];
  const logs = [];
  const pick = (v, n) => (typeof v === 'function' ? v(n) : v);
  const agent = async (prompt, o) => {
    const l = o.label;
    calls.push({ l, prompt, model: o.model });
    const n = Number((/#(\d+)/.exec(l) || [])[1]);
    if (l === 'select issues') {
      return {
        issues: (args.issues || []).map((i) => ({ number: i, title: 't' + i, labels: [], body: 'spec docs/specs/a.md', dependsOn: [], parents: [] })),
        skipped: [],
      };
    }
    if (l.startsWith('claim')) {
      if (pick(opts.claimProblem, n)) return { taken: false, claims: [], problem: pick(opts.claimProblem, n) };
      if (pick(opts.taken, n)) return { taken: true, takenBy: 'agent:in-progress', claims: [] };
      const mine = { commentId: 10 + n, claimId: args.claimId, createdAt: '2026-01-01T00:00:05Z' };
      const other = pick(opts.lose, n) ? [{ commentId: 1, claimId: 'other-1', createdAt: '2026-01-01T00:00:01Z' }] : [];
      return { taken: false, claims: [mine].concat(other) };
    }
    if (l.startsWith('release')) return { ok: true };
    if (l.startsWith('branch')) return Object.assign({ ok: true, branch: 'feat/' + n + '-x' }, pick(opts.branch, n) || {});
    if (l.startsWith('plan')) {
      if (pick(opts.planBlocked, n)) return { status: 'blocked', plan: 'P', questions: ['[BA] q1', '[QA] q2'], qaFiles: [], devFiles: [], specRead: 'docs/specs/a.md' };
      return { status: 'ready', plan: 'PLAN' + n, questions: [], qaFiles: opts.qaFiles || [], devFiles: opts.devFiles || ['src/x.py'], specRead: 'docs/specs/a.md' };
    }
    if (l.startsWith('qa')) {
      return Object.assign({ status: 'done', tests: [{ rowId: 'T1.1', test: 'test_t1_1' }], filesChanged: opts.qaFiles || [], questions: [], specRead: 'docs/specs/a.md' }, opts.qaOut || {});
    }
    if (l.startsWith('commit')) return { ok: true, commits: ['t1 test(#1): x', 'f1 feat(#1): y'], failedFirst: opts.failedFirst !== false, failureNote: '404' };
    if (l.startsWith('implement') || l.startsWith('fix')) {
      return Object.assign(
        { status: 'done', summary: 's', commits: ['a b'], filesChanged: ['src/x.py'], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'docs/specs/a.md' },
        pick(opts.devOut, n) || {},
      );
    }
    if (l.startsWith('check')) return { passed: true, failures: [] };
    if (l.startsWith('verify')) return { ran: true, mode: 'http', steps: [], notes: '' };
    if (l.startsWith('review')) return { verdict: 'pass', findings: [] };
    if (l.startsWith('ship')) return Object.assign({ ok: true, prNumber: 100 + n, url: 'u' + n }, pick(opts.ship, n) || {});
    if (l.startsWith('blocked')) return { ok: true, pushed: false };
    if (l.startsWith('restore')) return { ok: true };
    throw new Error('unexpected agent ' + l);
  };
  const parallel = async (fns) => Promise.all(fns.map((f) => f()));
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  const rep = await fn(args, agent, () => {}, (m) => logs.push(m), parallel);
  return { rep, calls, logs };
}
const labels = (calls) => calls.map((c) => c.l.split(' ')[0]);
const prompt = (calls, label) => (calls.find((c) => c.l.startsWith(label)) || {}).prompt || '';
const has = (calls, label) => calls.some((c) => c.l.startsWith(label));

test('runs without args stops with a message', async () => {
  const { rep } = await run({});
  assert.equal(rep[0].status, 'skipped');
  assert.match(rep[0].reason, /Missing args/);
});

test('one issue goes through every stage in order', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] });
  assert.equal(rep[0].status, 'pr');
  assert.deepEqual(labels(calls), ['select', 'claim', 'branch', 'plan', 'implement', 'check', 'review', 'ship', 'restore']);
  assert.match(prompt(calls, 'implement'), /PLAN1/);
  assert.equal(calls.find((c) => c.l.startsWith('review')).model, 'opus');
});

test('a lost claim releases and skips without a branch', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { lose: true });
  assert.equal(rep[0].reason, 'claimed by other-1');
  assert.ok(has(calls, 'release') && !has(calls, 'branch'));
});

test('an issue already claimed is skipped without a release', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { taken: true });
  assert.match(rep[0].reason, /^already claimed/);
  assert.ok(!has(calls, 'release') && !has(calls, 'branch'));
});

test('plan questions block once with one numbered questions comment and drop the claim', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { planBlocked: true });
  assert.equal(rep[0].status, 'blocked');
  const b = prompt(calls, 'blocked');
  assert.match(b, /<!-- devflow-questions -->/);
  assert.match(b, /1\. \[BA\] q1\n2\. \[QA\] q2/);
  assert.match(b, /devflow-claim id=C-me/);
  assert.ok(!has(calls, 'implement'));
});

test('a chain stacks each issue on the previous one', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1, 2, 3], chain: true });
  assert.ok(rep.every((r) => r.status === 'pr'));
  assert.deepEqual(rep[1].stackedOn, [101]);
  assert.deepEqual(rep[2].stackedOn, [102]);
  assert.match(prompt(calls, 'branch #2'), /origin\/feat\/1-x/);
});

test('a lane continues after a blocked issue and says so in the notes', async () => {
  const { rep } = await run({ ...BASE, issues: [1, 2, 3], chain: true }, { planBlocked: (n) => n === 1 });
  assert.equal(rep[0].status, 'blocked');
  assert.equal(rep[1].status, 'pr');
  assert.deepEqual(rep[1].stackedOn, []);
  assert.match(rep[1].notes.join(), /lane continued although #1 did not ship/);
  assert.deepEqual(rep[2].stackedOn, [102]);
});

test('isolated runs never switch branches', async () => {
  const { calls } = await run({ ...BASE, startBranch: '', isolated: true, issues: [1] });
  assert.ok(!has(calls, 'restore'));
  assert.match(prompt(calls, 'ship'), /Stay on the branch/);
});

test('parallel QA: qa and implement together, then the commit stage, test first', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, QA);
  assert.equal(rep[0].status, 'pr');
  assert.match(labels(calls).join(), /plan,qa,implement,commit,check/);
  assert.match(prompt(calls, 'implement'), /dev half/);
  assert.match(prompt(calls, 'qa'), /tests\/test_a\.py/);
  assert.match(rep[0].notes.join(), /test commit came first/);
});

test('questions from QA and dev are merged into one block', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...QA, qaOut: { status: 'blocked', questions: ['[QA] row T1.2 unclear'] }, devOut: { status: 'blocked', blockedReason: 'which sort?' } });
  assert.equal(rep[0].status, 'blocked');
  const b = prompt(calls, 'blocked');
  assert.match(b, /1\. \[QA\] row T1\.2 unclear\n2\. \[Dev\] which sort\?/);
  assert.ok(!has(calls, 'commit'));
});

test('a file owned by both QA and dev blocks at Plan', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { qaFiles: ['tests/a.py'], devFiles: ['./tests/a.py', 'src/x.py'] });
  assert.match(rep[0].reason, /Ownership overlap/);
  assert.ok(!has(calls, 'qa'));
});

test('dev changing a QA file, or QA a dev file, blocks before the commit', async () => {
  let r = await run({ ...BASE, issues: [1] }, { ...QA, devOut: { filesChanged: ['src/x.py', 'tests/test_a.py'] } });
  assert.match(r.rep[0].reason, /dev agent changed QA test files/);
  r = await run({ ...BASE, issues: [1] }, { ...QA, qaOut: { filesChanged: ['tests/test_a.py', 'src/x.py'] } });
  assert.match(r.rep[0].reason, /outside its own/);
});

test('QA tests that pass without the change ship with an assumption and a note', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...QA, failedFirst: false });
  assert.equal(rep[0].status, 'pr');
  assert.match(prompt(calls, 'ship'), /QA tests did not fail/);
  assert.match(rep[0].notes.join(), /did not fail before the implementation/);
});

test('parallelQa false uses one implement agent', async () => {
  const { calls } = await run({ ...BASE, config: { ...CFG, nextTask: { parallelQa: false } }, issues: [1] }, QA);
  assert.ok(!has(calls, 'qa') && !has(calls, 'commit'));
});

test('a parent PR merged during the run: the child opens against the base, not stacked', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1, 2], chain: true }, { ship: (n) => (n === 2 ? { unstacked: true } : {}) });
  assert.deepEqual(rep[1].stackedOn, []);
  assert.match(prompt(calls, 'ship #2'), /1b\. Read PR #101/);
  assert.doesNotMatch(prompt(calls, 'ship #1'), /1b\./);
  assert.match(rep[1].notes.join(), /merged while this issue was built/);
});

test('a parent PR merged before the branch: branch from base, no stack line', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1, 2], chain: true }, { branch: (n) => (n === 2 ? { parentMerged: true } : {}) });
  const ship = prompt(calls, 'ship #2');
  assert.match(prompt(calls, 'branch #2'), /no longer exists on origin/);
  assert.deepEqual(rep[1].stackedOn, []);
  assert.doesNotMatch(ship, /Stacked on/);
  assert.match(ship, /base main/);
  assert.match(rep[1].notes.join(), /already merged before this issue started/);
});

test('QA, implement and review carry the test naming rule', async () => {
  let r = await run({ ...BASE, issues: [1] }, QA);
  assert.match(prompt(r.calls, 'qa'), /name every test exactly by that pattern/);
  assert.match(prompt(r.calls, 'review'), /does not follow it exactly is a warning/);
  r = await run({ ...BASE, issues: [1] });
  assert.match(prompt(r.calls, 'implement'), /name every test exactly by that pattern/);
});

test('GitHub MCP unavailable stops the run: no blocked cleanup, the rest is skipped', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1, 2], ghCli: false }, { claimProblem: (n) => (n === 1 ? 'GitHub MCP unavailable: tools missing' : '') });
  assert.equal(rep[0].status, 'blocked');
  assert.equal(rep[0].mcpDown, true);
  assert.equal(rep[1].status, 'skipped');
  assert.match(rep[1].reason, /GitHub MCP unavailable: the run stopped at #1/);
  assert.ok(!has(calls, 'blocked') && !has(calls, 'claim #2'));
  assert.match(prompt(calls, 'claim #1'), /The gh CLI is not installed/);
});

test('with gh installed the MCP note has no stop rule', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  assert.doesNotMatch(prompt(calls, 'claim'), /gh CLI is not installed/);
});

test('a resumed branch skips parallel QA, tells implement about the earlier commits and notes it', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...QA, branch: { resumed: true, commits: ['abc test(#1): x'] } });
  assert.equal(rep[0].status, 'pr');
  assert.ok(!has(calls, 'qa') && !has(calls, 'commit'));
  assert.match(prompt(calls, 'implement'), /earlier run of this issue that was blocked/);
  assert.match(rep[0].notes.join(), /resumed branch feat\/1-x .*1 commit/);
});

test('manual checks reach review and ship; a failing one is noted', async () => {
  const manual = [{ rowId: 'T2.1', result: 'pass', evidence: 'make lint exit 0' }, { rowId: 'T2.2', result: 'not-run', evidence: 'no ruff' }];
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { devOut: { manualChecks: manual } });
  assert.match(prompt(calls, 'review'), /T2\.2/);
  assert.match(prompt(calls, 'ship'), /Manual checks .*T2\.1/);
  assert.match(rep[0].notes.join(), /manual checks not passing: T2\.2 not-run/);
});

test('verify takes the lock unless verify.lock is false', async () => {
  const cfg = { ...CFG, verify: { modes: ['http'], devServer: { run: 'make run', url: 'http://127.0.0.1:5050' } } };
  // Verify runs for UI changes, e2e labels or http rows; a UI change is the simplest trigger here.
  let r = await run({ ...BASE, config: cfg, issues: [1] }, { devOut: { touchesUi: true } });
  assert.match(prompt(r.calls, 'verify'), /devflow-verify\.lock/);
  r = await run({ ...BASE, config: { ...cfg, verify: { ...cfg.verify, lock: false } }, issues: [1] }, { devOut: { touchesUi: true } });
  assert.ok(has(r.calls, 'verify'));
  assert.doesNotMatch(prompt(r.calls, 'verify'), /devflow-verify\.lock/);
});
