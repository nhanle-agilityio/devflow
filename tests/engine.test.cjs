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
const BASE = { config: CFG, limit: 3, startBranch: 'main', prTemplatePath: '', claimId: 'C-me', pluginRoot: '/plugin' };
const QA = { qaFiles: ['tests/test_a.py'], devFiles: ['src/x.py'] };

// opts: per-stage overrides, each a function of the issue number or a plain value.
async function run(args, opts = {}) {
  const calls = [];
  const logs = [];
  const pick = (v, n) => (typeof v === 'function' ? v(n) : v);
  const agent = async (prompt, o) => {
    const l = o.label;
    calls.push({ l, prompt, model: o.model, agentType: o.agentType });
    if (opts.reviewerMissing && o.agentType) throw new Error('Unknown agent type ' + o.agentType);
    const n = Number((/#(\d+)/.exec(l) || [])[1]);
    if (l === 'select issues') {
      return {
        issues: (args.issues || []).map((i) => ({ number: i, title: 't' + i, labels: opts.selectLabels ? opts.selectLabels(i) : opts.labels || [], body: 'spec docs/specs/a.md', dependsOn: [], parents: [] })),
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
    if (l.startsWith('fix') && opts.fixOut !== undefined) {
      const f = pick(opts.fixOut, n);
      if (f === null) return null;
      return Object.assign({ status: 'done', summary: 'f', commits: [], filesChanged: [], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'none' }, f);
    }
    if (l.startsWith('implement') || l.startsWith('fix')) {
      return Object.assign(
        { status: 'done', summary: 's', commits: ['a b'], filesChanged: ['src/x.py'], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'docs/specs/a.md' },
        pick(opts.devOut, n) || {},
      );
    }
    if (l.startsWith('check')) return { passed: true, failures: [] };
    if (l.startsWith('verify')) return Object.assign({ ran: true, mode: 'http', steps: [], notes: '' }, pick(opts.verify, n) || {});
    // The scan agent runs bin/devflow-scan and returns its hits; the stub scans opts.diff with the same helpers.
    if (l.startsWith('scan')) {
      const text = pick(opts.diff, n);
      if (text === null) return null;
      if (opts.scanFails) return { scanned: false, hits: [], error: 'fatal: bad revision' };
      const h = await helpers();
      return { scanned: true, hits: h.scanWeakenedChecks(text || '', h.checkConfigGlobs(args.config.checks)) };
    }
    if (l.startsWith('review')) {
      const r = pick(opts.review, n);
      return r ? JSON.parse(JSON.stringify(r)) : { verdict: 'pass', findings: [] };
    }
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
async function helpers() {
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  return fn({ exports: true }, null, () => {}, () => {}, null);
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
  assert.deepEqual(labels(calls), ['select', 'claim', 'branch', 'plan', 'implement', 'check', 'scan', 'review', 'ship', 'restore']);
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

// ---------------------------------------------------------------------------------------------
// Weakened checks (D1) and out-of-scope items (D2)
// ---------------------------------------------------------------------------------------------

const diffOf = (file, hunk, extra = '') =>
  `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n${hunk}\n`;

test('parseDiff reads files, line numbers and deletions', async () => {
  const { parseDiff } = await helpers();
  const text = diffOf('src/a.py', '@@ -10,2 +12,3 @@\n-old\n+new1\n+new2') + diffOf('tests/test_b.py', '@@ -1,3 +0,0 @@\n-def test_x():\n-    assert 1', 'deleted file mode 100644\n');
  const files = parseDiff(text);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].added, [{ line: 12, text: 'new1' }, { line: 13, text: 'new2' }]);
  assert.deepEqual(files[0].removed, [{ line: 10, text: 'old' }]);
  assert.equal(files[1].deleted, true);
});

test('scanWeakenedChecks finds every kind of weakened check', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const globs = checkConfigGlobs([{ name: 'lint', run: '.venv/bin/ruff check .' }, { name: 'test', run: 'make test' }, { name: 'e2e', run: 'scripts/e2e.sh' }]);
  const text = [
    diffOf('src/a.py', '@@ -0,0 +1,6 @@\n+import os  # noqa: F401\n+x = f()  # type: ignore\n+try:\n+    g()\n+except Exception:\n+    pass'),
    diffOf('tests/test_a.py', '@@ -3,4 +3,1 @@\n-def test_one():\n-    assert a == 1\n-    assert b == 2\n+@pytest.mark.skip(reason="flaky")'),
    diffOf('web/a.test.ts', '@@ -0,0 +1,4 @@\n+it.only("x", () => {})\n+// eslint-disable-next-line\n+// @ts-ignore\n+try { f() } catch (e) {}'),
    diffOf('tests/test_old.py', '@@ -1,2 +0,0 @@\n-def test_gone():\n-    assert True', 'deleted file mode 100644\n'),
    diffOf('pyproject.toml', '@@ -5 +5 @@\n-select = ["E", "F"]\n+select = ["E"]'),
    diffOf('Makefile', '@@ -1 +1 @@\n-test:\n+test: # x'),
    diffOf('scripts/e2e.sh', '@@ -1 +1 @@\n-run all\n+run some'),
  ].join('');
  const kinds = scanWeakenedChecks(text, globs).map((h) => `${h.file}:${h.line} ${h.kind}`);
  for (const want of [
    'src/a.py:1 noqa',
    'src/a.py:2 type: ignore',
    'src/a.py:5 empty except',
    'tests/test_a.py:3 skipped test',
    'tests/test_a.py:3 removed 1 test(s)',
    'tests/test_a.py:4 removed 2 assertion(s)',
    'web/a.test.ts:1 skipped or focused test',
    'web/a.test.ts:2 eslint-disable',
    'web/a.test.ts:3 ts-ignore',
    'web/a.test.ts:4 empty catch',
    'tests/test_old.py:0 deleted test file',
    'pyproject.toml:5 check configuration changed',
    'Makefile:1 check configuration changed',
    'scripts/e2e.sh:1 check configuration changed',
  ]) {
    assert.ok(kinds.includes(want), `missing ${want} in ${kinds.join(' | ')}`);
  }
});

test('scanWeakenedChecks ignores clean changes and moved assertions', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const text = [
    diffOf('src/a.py', '@@ -1 +1,2 @@\n-x = 1\n+x = 2\n+# a comment about noqa-free code is fine'),
    diffOf('tests/test_a.py', '@@ -3,2 +3,3 @@\n-    assert a == 1\n+    assert a == 2\n+    assert b == 3'),
    diffOf('src/b.ts', '@@ -0,0 +1 @@\n+try { f() } catch (e) { log(e) }'),
  ].join('');
  assert.deepEqual(scanWeakenedChecks(text, checkConfigGlobs([{ name: 't', run: 'npm test' }])), []);
});

test('checkConfigGlobs adds Makefile for make checks and script paths, not tool binaries', async () => {
  const { checkConfigGlobs } = await helpers();
  const globs = checkConfigGlobs([{ name: 'a', run: 'make lint' }, { name: 'b', run: './bin/check --all' }, { name: 'c', run: '.venv/bin/pytest -q' }]);
  assert.ok(globs.includes('Makefile') && globs.includes('bin/check') && globs.includes('.claude/devflow.json'));
  assert.ok(!globs.some((g) => g.includes('.venv')));
});

const NOQA = diffOf('src/x.py', '@@ -0,0 +1 @@\n+import os  # noqa');

test('scan hits reach review and become critical findings that a fix round must address', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { diff: NOQA });
  assert.match(prompt(calls, 'review'), /Scan hits: \[.*"kind":"noqa"/);
  assert.ok(has(calls, 'fix'));
  assert.match(prompt(calls, 'fix'), /\[critical\] src\/x\.py:1: Weakened check \(noqa\)/);
  // the stub keeps returning the same diff, so the review never passes
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Review:/);
});

test('a hit gone after the fix ships with the issue risk', async () => {
  const calls_seen = { n: 0 };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { diff: () => (calls_seen.n++ === 0 ? NOQA : '') });
  assert.equal(rep[0].status, 'pr');
  assert.match(prompt(calls, 'ship'), /Risk: high \(the issue has no risk label/);
  assert.doesNotMatch(prompt(calls, 'ship'), /weakened checks kept/);
});

test('a hit the reviewer accepts ships as risk high with the reason', async () => {
  const review = { verdict: 'pass', findings: [], acceptedWeakenings: [{ file: 'src/x.py', line: 1, reason: 'the issue asks for it' }] };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { diff: NOQA, review });
  assert.equal(rep[0].status, 'pr');
  assert.ok(!has(calls, 'fix'));
  assert.equal(rep[0].risk, 'high');
  assert.match(prompt(calls, 'ship'), /weakened checks kept after review: src\/x\.py:1 noqa/);
  assert.match(rep[0].notes.join(), /risk high: weakened checks kept/);
});

test('an accepted hit escalates a risk:low issue to high and relabels the issue', async () => {
  const review = { verdict: 'pass', findings: [], acceptedWeakenings: [{ file: 'src/x.py', line: 1, reason: 'needed' }] };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { diff: NOQA, review, labels: ['risk:low'] });
  assert.equal(rep[0].risk, 'high');
  const ship = prompt(calls, 'ship');
  assert.match(ship, /escalated from the issue label: weakened checks kept after review/);
  assert.match(ship, /Also add "risk:high" to the issue/);
});

test('a scan that cannot run makes the PR risk high with the reason', async () => {
  let r = await run({ ...BASE, issues: [1] }, { diff: null });
  assert.equal(r.rep[0].status, 'pr');
  assert.equal(r.rep[0].risk, 'high');
  assert.match(prompt(r.calls, 'ship'), /scan could not run \(the scan agent died\)/);
  r = await run({ ...BASE, issues: [1] }, { scanFails: true });
  assert.match(prompt(r.calls, 'ship'), /scan could not run: fatal: bad revision/);
  r = await run({ ...BASE, pluginRoot: '', issues: [1] });
  assert.ok(!has(r.calls, 'scan'));
  assert.match(prompt(r.calls, 'ship'), /scan could not run: no pluginRoot/);
});

const VERIFY_CFG = { ...CFG, verify: { modes: ['http'], devServer: { run: 'make run', url: 'http://127.0.0.1:5050' } } };
const VERIFY_LABELS = ['needs-e2e', 'risk:low'];

test('verification that could not run makes a risk:low PR high with the reason', async () => {
  const { rep, calls } = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { labels: VERIFY_LABELS, verify: { ran: false, notes: 'verify lock busy\nsecond line' } });
  assert.equal(rep[0].status, 'pr');
  assert.equal(rep[0].risk, 'high');
  const ship = prompt(calls, 'ship');
  assert.match(ship, /escalated from the issue label: verification was required but could not run: verify lock busy/);
  assert.match(ship, /- Risk: .*verify lock busy\n/);
  assert.match(ship, /Also add "risk:high" to the issue/);
  assert.match(rep[0].notes.join(), /risk high: verification was required but could not run: verify lock busy/);
});

test('verification that runs and passes keeps a risk:low PR low', async () => {
  const { rep, calls } = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { labels: VERIFY_LABELS });
  assert.equal(rep[0].risk, 'low');
  assert.doesNotMatch(prompt(calls, 'ship'), /could not run/);
});

test('a verify problem and a scan problem both appear in the risk reason', async () => {
  const { rep, calls } = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { labels: VERIFY_LABELS, verify: { ran: false, notes: 'verify lock busy' }, scanFails: true });
  assert.equal(rep[0].risk, 'high');
  assert.match(prompt(calls, 'ship'), /the weakened-checks scan could not run: fatal: bad revision; verification was required but could not run: verify lock busy/);
  assert.match(rep[0].notes.join(), /verification was required but could not run: verify lock busy/);
});

test('the scan agent runs the shipped script, not a diff relay', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const p = prompt(calls, 'scan');
  assert.match(p, /node "\/plugin\/bin\/devflow-scan" origin\/main \.claude\/devflow\.json/);
  assert.doesNotMatch(p, /git diff/);
});

test('review gets the out-of-scope list and the rule that a criterion is never out of scope', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { devOut: { outOfScope: ['AC2.5 sort order: left as is'] } });
  const p = prompt(calls, 'review');
  assert.match(p, /Out of scope recorded so far: \["AC2\.5 sort order: left as is"\]/);
  assert.match(p, /is NOT out of scope: report it as critical/);
});

test('a fix that implements an out-of-scope item removes it before Ship', async () => {
  const calls_round = { n: 0, dev: 0 };
  const review = (n) => (calls_round.n++ === 0 ? { verdict: 'changes', findings: [{ severity: 'critical', file: 'src/x.py', line: 1, problem: 'AC2.5 required', fix: 'do it' }] } : null);
  const devOut = (n) => (calls_round.dev++ === 0 ? { outOfScope: ['AC2.5 sort order: left as is', 'typo in README'] } : { outOfScopeDone: ['AC2.5 sort order: left as is'] });
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { review, devOut });
  assert.equal(rep[0].status, 'pr');
  const ship = prompt(calls, 'ship');
  assert.match(ship, /Out of scope: \["typo in README"\]/);
  assert.match(ship, /\[follow-up #1\]/);
  assert.match(ship, /labels "needs-triage" only/);
});

test('follow-up issues from Ship are noted', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { ship: { followUps: [{ number: 77, title: '[follow-up #1] x' }] } });
  assert.match(rep[0].notes.join(), /out-of-scope follow-ups \(needs-triage\): #77/);
});

// ---------------------------------------------------------------------------------------------
// Priority (B2), triage (A4) and fix PR fields (E1)
// ---------------------------------------------------------------------------------------------

const PRIO = ['priority:critical', 'priority:high', 'priority:normal', 'priority:low'];
const iss = (number, labels = [], dependsOn = []) => ({ number, labels, dependsOn, parents: [] });

test('priorityRank: first listed label wins, no label is normal', async () => {
  const { priorityRank } = await helpers();
  assert.equal(priorityRank(['priority:high', 'priority:low'], PRIO), 1);
  assert.equal(priorityRank(['bug'], PRIO), 2);
  assert.equal(priorityRank([], ['p0', 'p1']), 2); // no "normal" entry: after every listed priority
});

test('orderIssues: priority, then number', async () => {
  const { orderIssues } = await helpers();
  const out = orderIssues([iss(5), iss(3, ['priority:low']), iss(9, ['priority:critical']), iss(4, ['priority:high']), iss(1)], PRIO);
  assert.deepEqual(out.map((i) => i.number), [9, 4, 1, 5, 3]);
});

test('orderIssues: dependencies first, and a critical child pulls its parent forward', async () => {
  const { orderIssues } = await helpers();
  const out = orderIssues([iss(2), iss(3), iss(10, [], []), iss(11, ['priority:critical'], [10]), iss(12, ['priority:low'], [2])], PRIO);
  assert.deepEqual(out.map((i) => i.number), [10, 11, 2, 3, 12]);
});

test('orderIssues: a dependency outside the set is ignored and a cycle keeps every issue', async () => {
  const { orderIssues } = await helpers();
  const out = orderIssues([iss(1, [], [2]), iss(2, [], [1]), iss(3, ['priority:high'], [99])], PRIO);
  assert.deepEqual(out.map((i) => i.number), [3, 1, 2]);
});

test('Select output is reordered by priority; a lane keeps its given order', async () => {
  // select stub returns args.issues in order with opts.labels; give per-issue labels through a function
  const labelsOf = { 1: [], 2: ['priority:critical'], 3: ['priority:high'] };
  let r = await run({ ...BASE, issues: [1, 2, 3] }, { selectLabels: (n) => labelsOf[n] });
  assert.deepEqual(r.rep.map((x) => x.issue), [2, 3, 1]);
  r = await run({ ...BASE, issues: [1, 2, 3], chain: true }, { selectLabels: (n) => labelsOf[n] });
  assert.deepEqual(r.rep.map((x) => x.issue), [1, 2, 3]);
});

test('needs-triage issues are never worked on', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1, 2] }, { selectLabels: (n) => (n === 1 ? ['needs-triage'] : []) });
  assert.equal(rep.find((x) => x.issue === 1).status, 'skipped');
  assert.match(rep.find((x) => x.issue === 1).reason, /needs-triage: a human sets it ready/);
  assert.ok(!has(calls, 'claim #1'));
  assert.equal(rep.find((x) => x.issue === 2).status, 'pr');
  assert.match(prompt(calls, 'select'), /Never select an issue labelled "needs-triage"/);
  assert.match(prompt(calls, 'select'), /priority:critical, priority:high, priority:normal, priority:low/);
});

test('isFixIssue: fix type, gap and bug labels, gap titles and bug bodies', async () => {
  const { isFixIssue } = await helpers();
  const cfg = { accept: { labels: ['type:gap'] } };
  assert.ok(isFixIssue({ title: 'x', labels: ['type:fix'], body: '' }, cfg));
  assert.ok(isFixIssue({ title: 'x', labels: ['type:gap'], body: '' }, cfg));
  assert.ok(isFixIssue({ title: 'x', labels: ['bug'], body: '' }, cfg));
  assert.ok(isFixIssue({ title: '[tasks] Gap: sort order', labels: [], body: '' }, cfg));
  assert.ok(isFixIssue({ title: 'x', labels: [], body: '## Introduced by\n#54' }, cfg));
  assert.ok(!isFixIssue({ title: '[tasks] T1: add export', labels: ['type:feat'], body: '' }, cfg));
});

test('a fix issue asks Implement for the root cause and Ship puts it in the PR', async () => {
  const rc = { cause: 'sort key ignored', introducedBy: 'PR #54 (AC2.5)', whyMissed: 'no test for AC2.5' };
  const { calls } = await run({ ...BASE, issues: [1] }, { selectLabels: () => ['type:fix'], devOut: { rootCause: rc } });
  assert.match(prompt(calls, 'implement'), /This issue is a fix/);
  const ship = prompt(calls, 'ship');
  assert.match(ship, /Root cause: .*sort key ignored/);
  assert.match(ship, /"Root cause", "Introduced by" and "Why it was missed"/);
  assert.ok(!has(calls, 'fix'));
});

test('a fix issue without a root cause gets one fix round to supply it, then ships with unknown', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { selectLabels: () => ['type:fix'] });
  assert.match(prompt(calls, 'fix'), /root cause/);
  assert.match(prompt(calls, 'ship'), /Introduced by: unknown/);
  assert.match(rep[0].notes.join(), /root cause not found/);
});

test('a feature issue has no root cause step', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  assert.doesNotMatch(prompt(calls, 'implement'), /This issue is a fix/);
  assert.doesNotMatch(prompt(calls, 'ship'), /Why it was missed/);
});

test('Ship files follow-ups with the bug template and a triage suggestion comment', async () => {
  const { calls } = await run({ ...BASE, issues: [1], bugTemplatePath: '/p/skills/spec/templates/bug.md' }, { devOut: { outOfScope: ['typo in README'] } });
  const ship = prompt(calls, 'ship');
  assert.match(ship, /\/p\/skills\/spec\/templates\/bug\.md/);
  assert.match(ship, /suggest a priority .* and a risk/);
});

// ---------------------------------------------------------------------------------------------
// Reviewer agent (P6)
// ---------------------------------------------------------------------------------------------

test('Review runs as the plugin reviewer agent, configurable and with a fallback', async () => {
  let r = await run({ ...BASE, issues: [1] });
  assert.equal(r.calls.find((c) => c.l.startsWith('review')).agentType, 'devflow:reviewer');
  r = await run({ ...BASE, config: { ...CFG, nextTask: { reviewerAgent: '' } }, issues: [1] });
  assert.equal(r.calls.find((c) => c.l.startsWith('review')).agentType, undefined);
  r = await run({ ...BASE, issues: [1] }, { reviewerMissing: true });
  assert.equal(r.rep[0].status, 'pr');
  assert.match(r.rep[0].notes.join(), /reviewer agent devflow:reviewer unavailable/);
});

test('parseDiff: --- and +++ inside a hunk are content lines, not file headers', async () => {
  const { parseDiff, scanWeakenedChecks } = await helpers();
  const text = 'diff --git a/db/schema.sql b/db/schema.sql\nindex 1..2 100644\n--- a/db/schema.sql\n+++ b/db/schema.sql\n@@ -3,2 +3,2 @@\n--- old comment\n-select 1;\n+++ new counter\n+select 2;\n' +
    diffOf('tests/test_a.py', '@@ -1,2 +1,1 @@\n-def test_x():\n-    assert 1\n+x = 1');
  const files = parseDiff(text);
  assert.deepEqual(files.map((f) => f.file), ['db/schema.sql', 'tests/test_a.py']);
  assert.deepEqual(files[0].removed, [{ line: 3, text: '-- old comment' }, { line: 4, text: 'select 1;' }]);
  assert.deepEqual(files[0].added, [{ line: 3, text: '++ new counter' }, { line: 4, text: 'select 2;' }]);
  assert.ok(scanWeakenedChecks(text, []).some((h) => h.file === 'tests/test_a.py' && /removed 1 test/.test(h.kind)));
});

test('a failed root-cause round never blocks: died or blocked ships with unknown and a note', async () => {
  for (const fixOut of [null, { status: 'blocked', blockedReason: 'cannot tell' }]) {
    const { rep, calls } = await run({ ...BASE, issues: [1] }, { selectLabels: () => ['type:fix'], fixOut });
    assert.equal(rep[0].status, 'pr', JSON.stringify(fixOut));
    assert.match(prompt(calls, 'ship'), /Root cause: unknown; Introduced by: unknown/);
    assert.match(rep[0].notes.join(), /root cause round failed/);
    assert.ok(!has(calls, 'blocked'));
  }
});

test('a root-cause round that edits a QA file still blocks', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { ...QA, selectLabels: () => ['type:fix'], fixOut: { filesChanged: ['tests/test_a.py'] } });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /QA test files/);
});

// --- scan coverage: config globs, more skip/suppress forms, prose files ---

const scanKinds = (scan, text, globs) => scan(text, globs).map((h) => `${h.file}:${h.line} ${h.kind}`);

test('package.json hits only on script and tool-config lines, whatever the checks run', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  assert.ok(!checkConfigGlobs([{ name: 't', run: 'npm test' }]).includes('**/package.json'));
  const kinds = (hunk) => scanKinds(scanWeakenedChecks, diffOf('web/package.json', hunk), checkConfigGlobs([{ name: 't', run: 'make test' }]));
  assert.deepEqual(kinds('@@ -3 +3 @@\n-    "test": "jest"\n+    "test": "true"'), ['web/package.json:3 check configuration changed']);
  assert.deepEqual(kinds('@@ -4 +3,0 @@\n-    "lint": "eslint ."'), ['web/package.json:4 check configuration changed']);
  assert.deepEqual(kinds('@@ -0,0 +5 @@\n+  "jest": {'), ['web/package.json:5 check configuration changed']);
  assert.deepEqual(kinds('@@ -0,0 +5,2 @@\n+    "test": "true",\n+    "lint": "true"'), ['web/package.json:5 check configuration changed']);
  for (const hunk of [
    '@@ -0,0 +5 @@\n+    "lodash": "^4.17.21",',
    '@@ -0,0 +5 @@\n+    "jest": "^29.7.0"',
    '@@ -0,0 +5 @@\n+    "lint-staged": "^15.0.0"',
    '@@ -0,0 +5 @@\n+    "test": "^1.2.3"',
    '@@ -0,0 +5 @@\n+    "build": "workspace:*"',
    '@@ -0,0 +5 @@\n+    "build-tools": "github:acme/build-tools#v2"',
  ]) {
    assert.deepEqual(kinds(hunk), [], hunk);
  }
});

test('checkConfigGlobs covers Makefile when any simple command runs make', async () => {
  const { checkConfigGlobs, globToRegExp } = await helpers();
  const globs = checkConfigGlobs([{ name: 'lint', run: 'cd web && make lint' }]);
  const covered = (f) => globs.some((g) => globToRegExp(g).test(f));
  assert.ok(covered('web/Makefile') && covered('Makefile'));
  assert.ok(!checkConfigGlobs([{ name: 't', run: 'echo make' }]).some((g) => /Makefile/.test(g)));
});

test('checkConfigGlobs always covers .github scripts and actions', async () => {
  const { checkConfigGlobs, globToRegExp } = await helpers();
  const globs = checkConfigGlobs([]);
  const covered = (f) => globs.some((g) => globToRegExp(g).test(f));
  assert.ok(!covered('tests/conftest.py'));
  assert.ok(covered('.github/scripts/check.sh') && covered('.github/actions/setup/action.yml'));
});

test('scanWeakenedChecks finds Go, JUnit, Rust, nolint, rubocop and hollow assertions', async () => {
  const { scanWeakenedChecks } = await helpers();
  const text = [
    diffOf('pkg/a_test.go', '@@ -0,0 +1,2 @@\n+\tt.Skip("flaky")\n+\ttb.SkipNow()'),
    diffOf('pkg/a.go', '@@ -0,0 +1,2 @@\n+\tt.Skip("flaky")\n+\tx := f() //nolint:errcheck'),
    diffOf('src/test/java/FooTest.java', '@@ -0,0 +1 @@\n+    @Disabled("later")'),
    diffOf('app/BarTests.kt', '@@ -0,0 +1 @@\n+    @Ignore'),
    diffOf('src/lib.rs', '@@ -0,0 +1 @@\n+#[ignore]'),
    diffOf('app/r.rb', '@@ -0,0 +1 @@\n+x = 1 # rubocop:disable Style/Foo'),
    diffOf('tests/test_a.py', '@@ -0,0 +1,2 @@\n+    assert True\n+    assert 1  # ok'),
    diffOf('web/a.test.ts', '@@ -0,0 +1,3 @@\n+expect(true).toBe(true)\n+expect(true).toBeTruthy()\n+assert.ok(true)'),
    diffOf('app/a.py', '@@ -0,0 +1,2 @@\n+    assert True\n+x = 1  # noqa'),
  ].join('');
  const kinds = scanKinds(scanWeakenedChecks, text, []);
  for (const want of [
    'pkg/a_test.go:1 skipped test',
    'pkg/a_test.go:2 skipped test',
    'pkg/a.go:2 nolint',
    'src/test/java/FooTest.java:1 skipped test',
    'app/BarTests.kt:1 skipped test',
    'src/lib.rs:1 skipped test',
    'app/r.rb:1 rubocop:disable',
    'tests/test_a.py:1 hollow assertion',
    'tests/test_a.py:2 hollow assertion',
    'web/a.test.ts:1 hollow assertion',
    'web/a.test.ts:2 hollow assertion',
    'web/a.test.ts:3 hollow assertion',
    'app/a.py:2 noqa',
  ]) {
    assert.ok(kinds.includes(want), `missing ${want} in ${kinds.join(' | ')}`);
  }
  assert.ok(!kinds.includes('pkg/a.go:1 skipped test'), 'Skip outside a _test.go file is not a hit');
  assert.ok(!kinds.some((k) => k.startsWith('app/a.py:1')), 'hollow assertion only counts in test files');
  const nolint2 = scanWeakenedChecks(diffOf('x.go', '@@ -0,0 +1 @@\n+f() // nolint'), []);
  assert.equal(nolint2[0].kind, 'nolint');
});

test('scanWeakenedChecks treats the new layouts as test files', async () => {
  const { scanWeakenedChecks } = await helpers();
  for (const f of ['src/test/java/a/B.java', 'a/FooTest.java', 'a/FooTests.java', 'a/FooTest.kt', 'spec/x_spec.rb', 'src/x_spec.rb', 'src/x_test.rs']) {
    const hits = scanWeakenedChecks(diffOf(f, '@@ -1 +0,0 @@\n-gone', 'deleted file mode 100644\n'), []);
    assert.deepEqual(hits.map((h) => h.kind), ['deleted test file'], f);
  }
});

test('scanWeakenedChecks skips line patterns in prose and docs files but not config rules', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const line = '@@ -0,0 +1,3 @@\n+Use # noqa or eslint-disable sparingly\n+except Exception: pass\n+@pytest.mark.skip';
  const text = ['README.md', 'notes.txt', 'a.rst', 'a.adoc', 'b.mdx', 'docs/guide.py', 'pkg/docs/x.js'].map((f) => diffOf(f, line)).join('');
  assert.deepEqual(scanWeakenedChecks(text, []), []);
  // the config rule still applies to prose paths, and a deleted test file still hits
  const cfg = scanKinds(scanWeakenedChecks, diffOf('docs/Makefile', '@@ -1 +1 @@\n-a\n+b'), ['**/Makefile']);
  assert.deepEqual(cfg, ['docs/Makefile:1 check configuration changed']);
  const del = scanWeakenedChecks(diffOf('docs/tests/test_a.py', '@@ -1 +0,0 @@\n-x', 'deleted file mode 100644\n'), []);
  assert.deepEqual(del.map((h) => h.kind), ['deleted test file']);
  // a real noqa in code still hits
  assert.deepEqual(scanKinds(scanWeakenedChecks, diffOf('app/a.py', '@@ -0,0 +1 @@\n+import os  # noqa'), []), ['app/a.py:1 noqa']);
});

test('conftest.py hits only when it ignores test collection', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const kinds = (hunk) => scanKinds(scanWeakenedChecks, diffOf('tests/conftest.py', hunk), checkConfigGlobs([]));
  assert.deepEqual(kinds('@@ -0,0 +1,3 @@\n+@pytest.fixture\n+def db():\n+    return 1'), []);
  assert.deepEqual(kinds('@@ -0,0 +1 @@\n+collect_ignore = ["test_slow.py"]'), ['tests/conftest.py:1 collection ignored']);
  assert.deepEqual(kinds('@@ -0,0 +1 @@\n+def pytest_ignore_collect(path):'), ['tests/conftest.py:1 collection ignored']);
});
