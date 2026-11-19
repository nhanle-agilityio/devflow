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
  const pick = (v, n, x) => (typeof v === 'function' ? v(n, x) : v);
  const checkCalls = {};
  const agent = async (prompt, o) => {
    const l = o.label;
    calls.push({ l, prompt, model: o.model, agentType: o.agentType, schema: o.schema });
    if (opts.reviewerMissing && o.agentType) throw new Error('Unknown agent type ' + o.agentType);
    const n = Number((/#(\d+)/.exec(l) || [])[1]);
    if (opts.onCall) await opts.onCall(l, n);
    const result = await opts.agentResult?.(prompt, o);
    if (result !== undefined) return result;
    if (l === 'select issues') {
      return {
        issues: (args.issues || []).map((i) => ({ number: i, title: 't' + i, labels: opts.selectLabels ? opts.selectLabels(i) : opts.labels || [], body: opts.body !== undefined ? pick(opts.body, i) : 'spec docs/specs/a.md', dependsOn: [], parents: opts.parents ? pick(opts.parents, i) : [], ...(opts.resumeBranch ? { resumeBranch: pick(opts.resumeBranch, i) } : {}) })),
        skipped: [],
      };
    }
    if (l.startsWith('claim')) {
      if (pick(opts.claimProblem, n)) return { taken: false, claims: [], problem: pick(opts.claimProblem, n) };
      if (pick(opts.taken, n)) return { taken: true, takenBy: 'agent:in-progress', claims: [] };
      const mine = { commentId: 10 + n, claimId: args.claimId, createdAt: '2026-01-01T00:00:05Z' };
      const other = pick(opts.lose, n) ? [{ commentId: 1, claimId: 'other-1', createdAt: '2026-01-01T00:00:01Z' }] : [];
      if (opts.myAuthor !== undefined) mine.author = opts.myAuthor;
      if (other[0] && opts.winnerAuthor !== undefined) other[0].author = opts.winnerAuthor;
      const out = { taken: false, claims: [mine].concat(other) };
      // T6: the claim reports the labels, spec path and fix-introduced flag it read from GitHub; by default they equal the Select copy's.
      out.labels = opts.claimLabels !== undefined ? pick(opts.claimLabels, n) : opts.selectLabels ? opts.selectLabels(n) : opts.labels || [];
      out.specPath = '';
      out.introducedBy = false;
      Object.assign(out, pick(opts.claimOut, n) || {});
      if (opts.assignedByRun !== undefined) out.assignedByRun = opts.assignedByRun;
      return out;
    }
    if (l.startsWith('release')) return { ok: true };
    if (l.startsWith('integrate')) return Object.assign({ ok: true, integrationSha: 'abc1234def', merged: ['a', 'b'] }, pick(opts.integrateOut, n) || {});
    if (l.startsWith('branch')) return Object.assign({ ok: true, branch: 'feat/' + n + '-x' }, pick(opts.branch, n) || {});
    if (l.startsWith('plan')) {
      const t6 = { acceptanceCriteria: 0, httpOrE2eRows: false };
      const planRes = pick(opts.planBlocked, n)
        ? Object.assign({ status: 'blocked', plan: 'P', questions: ['[BA] q1', '[QA] q2'], qaFiles: [], devFiles: [], specRead: 'docs/specs/a.md' }, t6, pick(opts.planOut, n) || {})
        : Object.assign({ status: 'ready', plan: 'PLAN' + n, questions: [], qaFiles: opts.qaFiles || [], devFiles: opts.devFiles || ['src/x.py'], specRead: 'docs/specs/a.md' }, t6, pick(opts.planOut, n) || {});
      for (const k of Object.keys(planRes)) if (planRes[k] === undefined) delete planRes[k];
      return planRes;
    }
    if (l.startsWith('qa-fix')) {
      return Object.assign({ status: 'done', summary: 'qf', commits: [], filesChanged: [], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'none' }, pick(opts.qaFixOut, n) || {});
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
    if (l.startsWith('check')) {
      checkCalls[n] = (checkCalls[n] || 0) + 1;
      if (opts.checkFail) {
        const f = opts.checkFail(n, checkCalls[n]);
        if (f) return { passed: false, failures: f };
      }
      if (opts.checkFirstFails && checkCalls[n] === 1) return { passed: false, failures: [{ check: 'test', output: 'boom' }] };
      return { passed: true, failures: [] };
    }
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
      const r = pick(opts.review, n, o.agentType);
      return Object.assign({ issueRead: true }, r ? JSON.parse(JSON.stringify(r)) : { verdict: 'pass', findings: [] });
    }
    if (l.startsWith('changed-files')) return opts.changedFiles !== undefined ? pick(opts.changedFiles, n) : { ok: true, files: ['src/x.py'] };
    if (l.startsWith('decisions')) return { ok: true, appended: ['- line'] };
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
  // a changed existing assertion is a changed-existing-test hit (T3.3), not a removed assertion; this test covers the removed-assertion rule only
  const hits = scanWeakenedChecks(text, checkConfigGlobs([{ name: 't', run: 'npm test' }])).filter((h) => h.kind !== 'changed-existing-test');
  assert.deepEqual(hits, []);
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

// ---- T17: follow-ups record where they were found; epics close the issues they resolve ----
const T17_EPIC_BODY = 'Epic: #92\n\n## Acceptance criteria\n- [ ] x';
const shipFor = async (body = T17_EPIC_BODY) => {
  const rd = { specRead: 'epic #92', epicRead: true };
  const { calls } = await run({ ...BASE, issues: [1] }, { body, planOut: rd, qaOut: rd, devOut: { ...rd, outOfScope: ['bug in src/a.js:10'] } });
  return prompt(calls, 'ship');
};

test('T17.1 follow-up prompt requires Found in: #<pr> and file:line', async () => {
  const ship = await shipFor();
  assert.match(ship, /"Found in: #<PR number>"/);
  assert.match(ship, /file:line/);
});

test('T17.2 follow-up without a PR takes the branch name in Found in:', async () => {
  const ship = await shipFor();
  assert.match(ship, /no PR exists yet[^.]*"Found in: feat\/1-x"/);
});

test('T17.3 follow-up without file:line writes only the Found in: line', async () => {
  const ship = await shipFor();
  assert.match(ship, /no known location[^.]*only the "Found in:" line/);
});

test('T17.5 ship of the last open sub-issue adds Closes for each open Resolves issue', async () => {
  const ship = await shipFor();
  assert.match(ship, /read epic #92/);
  assert.match(ship, /"Resolves:" line/);
  assert.match(ship, /last open sub-issue/);
  assert.match(ship, /the issue being shipped counts as open/);
  assert.match(ship, /"Closes #<n>" line for each listed issue that is still open/);
});

test('T17.6 no Closes lines when another sub-issue of the epic is still open', async () => {
  const ship = await shipFor();
  assert.match(ship, /another sub-issue of the epic is still open[^.]*add no "Closes/);
});

test('T17.7 a listed issue that is already closed gets no Closes line', async () => {
  const ship = await shipFor();
  assert.match(ship, /that is already closed gets no "Closes/);
});

test('T17.8 nonexistent or other-repository numbers are skipped with a note in the PR body', async () => {
  const ship = await shipFor();
  assert.match(ship, /does not exist or belongs to another repository[^.]*skip[^.]*note in the PR body/i);
});

test('T17.9 epic without a Resolves line adds no Closes lines', async () => {
  const ship = await shipFor();
  assert.match(ship, /no "Resolves:" line[^.]*add no "Closes/);
});

test('T17 an issue without an epic gets no epic Closes step', async () => {
  const ship = await shipFor('plain issue');
  assert.match(ship, /Ship issue #1/);
  assert.doesNotMatch(ship, /"Resolves:" line/);
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

const scanKinds = (scan, text, globs, ignore) => scan(text, globs, ignore).map((h) => `${h.file}:${h.line} ${h.kind}`);

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

test('scanWeakenedChecks skips files matching the ignore globs entirely', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const globs = checkConfigGlobs([{ name: 't', run: 'make test' }]);
  const text = [
    diffOf('tests/engine.test.cjs', '@@ -0,0 +1,2 @@\n+  t.Skip("x")\n+  // nolint'),
    diffOf('tests/test_a.py', '@@ -3,3 +3,1 @@\n-def test_one():\n-    assert a == 1\n-    assert b == 2\n+@pytest.mark.skip'),
    diffOf('tests/test_old.py', '@@ -1,2 +0,0 @@\n-def test_gone():\n-    assert True', 'deleted file mode 100644\n'),
    diffOf('Makefile', '@@ -1 +1 @@\n-test:\n+test: # x'),
    diffOf('src/a.py', '@@ -0,0 +1 @@\n+import os  # noqa'),
  ].join('');
  const files = (ignore) => Array.from(new Set(scanWeakenedChecks(text, globs, ignore).map((h) => h.file))).sort();
  assert.deepEqual(files(['tests/**', 'Makefile']), ['src/a.py']);
  assert.deepEqual(files(['tests/engine.test.*']), ['Makefile', 'src/a.py', 'tests/test_a.py', 'tests/test_old.py']);
  assert.deepEqual(files(['**']).filter((f) => f !== '.claude/devflow.json'), []);
});

test('scanWeakenedChecks never ignores .claude/devflow.json', async () => {
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const text = diffOf('.claude/devflow.json', '@@ -1 +1,2 @@\n-{}\n+{"scan":{"ignore":["**"]}}\n+x') + diffOf('src/a.py', '@@ -0,0 +1 @@\n+import os  # noqa');
  for (const ignore of [['**'], ['.claude/**'], ['.claude/devflow.json']]) {
    const kinds = scanKinds(scanWeakenedChecks, text, checkConfigGlobs([]), ignore);
    assert.ok(kinds.some((k) => /^\.claude\/devflow\.json:\d+ check configuration changed$/.test(k)), kinds.join(' | '));
    assert.equal(kinds.some((k) => k.startsWith('src/a.py')), ignore[0] !== '**', kinds.join(' | '));
  }
});

test('scanWeakenedChecks treats a missing or non-array ignore argument as none', async () => {
  const { scanWeakenedChecks } = await helpers();
  const text = diffOf('src/a.py', '@@ -0,0 +1 @@\n+import os  # noqa');
  const base = scanWeakenedChecks(text, []);
  assert.equal(base.length, 1);
  for (const bad of [undefined, null, '**', {}, 5]) assert.deepEqual(scanWeakenedChecks(text, [], bad), base);
});

// T1: claim taken rule, assignedByRun cleanup, lost-claim release
const REMOVE_ASSIGNEE = /remove the authenticated user|unassign/i;

test('test_t1_1_claim_prompt_states_taken_rule', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const p = prompt(calls, 'claim');
  assert.match(p, /other than the authenticated user/);
  assert.match(p, /agent:in-progress/);
  assert.match(p, /agent:blocked/);
  assert.match(p, /agent:review/);
});

test('test_t1_2_claim_prompt_self_assigned_only_is_free', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  assert.match(prompt(calls, 'claim'), /only to the authenticated user[\s\S]{0,200}(not taken|claim)/i);
});

test('test_t1_3_claim_prompt_mixed_assignees_is_taken', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  assert.match(prompt(calls, 'claim'), /authenticated user and (an)?other[\s\S]{0,80}taken/i);
});

test('test_t1_4_claim_adds_self_only_when_unassigned_and_schema_requires_fields', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const p = prompt(calls, 'claim');
  assert.match(p, /only when (it is |they are )?not already assigned|not already assigned/i);
  assert.match(p, /assignedByRun/);
  const schema = calls.find((c) => c.l.startsWith('claim')).schema;
  assert.ok(schema.required.includes('assignedByRun'));
  assert.equal(schema.properties.assignedByRun.type, 'boolean');
  assert.ok(schema.properties.claims.items.required.includes('author'));
});

test('test_t1_5_assigned_by_run_true_plan_block_removes_self', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { assignedByRun: true, planBlocked: true });
  assert.equal(rep[0].status, 'blocked');
  assert.match(prompt(calls, 'blocked'), /remove the authenticated user from the assignees/i);
});

test('test_t1_6_assigned_by_run_true_review_block_removes_self', async () => {
  const review = { verdict: 'changes', findings: [{ severity: 'warning', file: 'src/x.py', line: 1, problem: 'p', fix: 'f' }] };
  const { rep, calls } = await run({ ...BASE, config: { ...CFG, nextTask: { onQuestion: 'block' } }, issues: [1] }, { assignedByRun: true, review });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Review:/);
  assert.match(prompt(calls, 'blocked'), /remove the authenticated user from the assignees/i);
});

test('test_t1_7_assigned_by_run_false_no_assignee_removal', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { assignedByRun: false, planBlocked: true });
  assert.equal(rep[0].status, 'blocked');
  assert.ok(has(calls, 'blocked'));
  assert.doesNotMatch(prompt(calls, 'blocked'), REMOVE_ASSIGNEE);
});

test('test_t1_8_assigned_by_run_missing_counts_as_false', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { planBlocked: true });
  assert.equal(rep[0].status, 'blocked');
  assert.doesNotMatch(prompt(calls, 'blocked'), REMOVE_ASSIGNEE);
});

test('test_t1_9_lost_claim_same_login_leaves_assignee', async () => {
  for (const winnerAuthor of ['me', undefined]) {
    const { rep, calls } = await run({ ...BASE, issues: [1] }, { lose: true, assignedByRun: true, myAuthor: 'me', winnerAuthor });
    assert.equal(rep[0].reason, 'claimed by other-1');
    assert.ok(!has(calls, 'blocked'));
    assert.ok(has(calls, 'release'));
    assert.doesNotMatch(prompt(calls, 'release'), REMOVE_ASSIGNEE);
  }
});

test('test_t1_11_lost_claim_other_login_removes_own_assignee', async () => {
  let r = await run({ ...BASE, issues: [1] }, { lose: true, assignedByRun: true, myAuthor: 'me', winnerAuthor: 'other' });
  assert.ok(!has(r.calls, 'blocked'));
  assert.match(prompt(r.calls, 'release'), /remove the authenticated user from the assignees/i);
  r = await run({ ...BASE, issues: [1] }, { lose: true, assignedByRun: false, myAuthor: 'me', winnerAuthor: 'other' });
  assert.ok(!has(r.calls, 'blocked'));
  assert.doesNotMatch(prompt(r.calls, 'release'), REMOVE_ASSIGNEE);
});

// T2: cleanup when a run throws, partial-claim and cleanup-failed notes
const CLEANUP_FAILED = 'cleanup failed; run /devflow:doctor';
const PARTIAL = 'claim may be partial; run /devflow:doctor';
const count = (calls, label) => calls.filter((c) => c.l.startsWith(label)).length;
const throwOn = (label, make, only) => (l, n) => {
  if (l.startsWith(label) && (only === undefined || only === n)) throw make();
};

test('test_t2_1_stage_throw_after_claim_runs_cleanup_with_error', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { onCall: throwOn('implement', () => new Error('boom')) });
  assert.equal(count(calls, 'blocked'), 1);
  assert.match(prompt(calls, 'blocked'), /stage "Error"/);
  assert.match(prompt(calls, 'blocked'), /boom/);
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Error: boom/);
});

test('test_t2_2_error_reason_uses_first_line', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { onCall: throwOn('plan', () => new Error('line1\nline2')) });
  assert.match(rep[0].reason, /^Error: line1/);
  assert.doesNotMatch(rep[0].reason, /line2/);
});

test('test_t2_3_throw_cleanup_removes_assignee_when_assigned_by_run', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { ...QA, assignedByRun: true, onCall: throwOn('qa', () => new Error('x')) });
  assert.equal(count(calls, 'blocked'), 1);
  assert.match(prompt(calls, 'blocked'), REMOVE_ASSIGNEE);
});

test('test_t2_4_throw_cleanup_keeps_assignee_when_not_assigned_by_run', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { ...QA, assignedByRun: false, onCall: throwOn('qa', () => new Error('x')) });
  assert.equal(count(calls, 'blocked'), 1);
  assert.doesNotMatch(prompt(calls, 'blocked'), REMOVE_ASSIGNEE);
});

test('test_t2_5_claim_throw_no_cleanup_partial_claim_note', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { onCall: throwOn('claim', () => new Error('mcp')) });
  assert.ok(!has(calls, 'blocked'));
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Workflow error:/);
  assert.match(rep[0].notes.join('\n'), new RegExp(PARTIAL));
  assert.doesNotMatch(rep[0].notes.join('\n'), /cleanup failed/);
});

test('test_t2_6_release_throw_after_lost_claim_partial_claim_note', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { lose: true, onCall: throwOn('release', () => new Error('mcp')) });
  assert.ok(!has(calls, 'blocked'));
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Workflow error:/);
  assert.match(rep[0].notes.join('\n'), new RegExp(PARTIAL));
});

test('test_t2_7_cleanup_throws_after_stage_throw', async () => {
  const onCall = (l, n) => {
    throwOn('implement', () => new Error('boom'))(l, n);
    throwOn('blocked', () => new Error('cleanup boom'))(l, n);
  };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { onCall });
  assert.equal(count(calls, 'blocked'), 1);
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Workflow error:/);
  assert.match(rep[0].notes.join('\n'), new RegExp(CLEANUP_FAILED));
});

test('test_t2_8_cleanup_throws_after_normal_block', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { planBlocked: true, onCall: throwOn('blocked', () => new Error('cleanup boom')) });
  assert.equal(count(calls, 'blocked'), 1);
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Workflow error:/);
  assert.match(rep[0].notes.join('\n'), new RegExp(CLEANUP_FAILED));
});

test('test_t2_8_cleanup_throws_after_normal_block_before_claim_won', async () => {
  // Our claim comment is missing, so the issue is blocked at Claim before the claim is won.
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { claimProblem: 'claim comment not read back', onCall: throwOn('blocked', () => new Error('cleanup boom')) });
  assert.equal(count(calls, 'blocked'), 1);
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Workflow error:/);
  assert.match(rep[0].notes.join('\n'), new RegExp(CLEANUP_FAILED));
  assert.doesNotMatch(rep[0].notes.join('\n'), /claim may be partial/);
});

test('test_t2_9_run_continues_after_cleanup_failure', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1, 2] }, { planBlocked: (n) => n === 1, onCall: throwOn('blocked', () => new Error('cleanup boom'), 1) });
  assert.equal(rep[0].status, 'blocked');
  assert.equal(rep[1].status, 'pr');
  assert.ok(has(calls, 'ship #2'));
});

test('test_t2_10_normal_block_is_not_cleaned_up_twice', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { planBlocked: true });
  assert.equal(count(calls, 'blocked'), 1);
  assert.equal(rep[0].status, 'blocked');
  assert.doesNotMatch(rep[0].reason, /^Error:/);
  assert.doesNotMatch(rep[0].reason, /^Workflow error:/);
});

test('test_t2_11_parallel_throw_waits_for_both_agents', async () => {
  let implSettled = false;
  let settledAtBlocked = null;
  const onCall = async (l, n) => {
    if (l.startsWith('qa')) throw new Error('qa boom');
    if (l.startsWith('implement')) {
      await new Promise((r) => setTimeout(r, 50));
      implSettled = true;
    }
    if (l.startsWith('blocked')) settledAtBlocked = implSettled;
  };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...QA, onCall });
  assert.equal(count(calls, 'blocked'), 1);
  assert.equal(settledAtBlocked, true);
  assert.match(prompt(calls, 'blocked'), /stage "Error"/);
  assert.match(rep[0].reason, /^Error:/);
});

test('test_t2_12_non_error_or_empty_throw_is_unknown', async () => {
  let r = await run({ ...BASE, issues: [1] }, { onCall: (l) => { if (l.startsWith('plan')) throw undefined; } });
  assert.match(r.rep[0].reason, /^Error: unknown/);
  r = await run({ ...BASE, issues: [1] }, { onCall: throwOn('plan', () => new Error('')) });
  assert.match(r.rep[0].reason, /^Error: unknown/);
});

test('test_t2_15_notes_survive_a_throw', async () => {
  const { rep } = await run(
    { ...BASE, issues: [1] },
    { branch: { resumed: true, commits: ['abc feat(#1): x'] }, planBlocked: true, onCall: throwOn('blocked', () => new Error('cleanup boom')) },
  );
  const notes = rep[0].notes.join('\n');
  assert.match(notes, /resum|continu/i);
  assert.match(notes, new RegExp(CLEANUP_FAILED));
});

// ---------------------------------------------------------------------------------------------
// T7: run limit counts worked issues; review exits on findings only
// ---------------------------------------------------------------------------------------------
const L1 = { ...BASE, limit: 1 };
const byIssue = (rep, n) => rep.find((x) => x.issue === n);
const finding = (severity) => ({ severity, file: 'src/x.py', line: 1, problem: 'p', fix: 'f' });
// Review stub returning the given results in order (the last one repeats).
const reviewSeq = (results) => {
  let i = 0;
  return () => results[Math.min(i++, results.length - 1)];
};

test('test_t7_1_taken_at_claim_does_not_count_toward_limit', async () => {
  const { rep } = await run({ ...L1, issues: [1, 2] }, { taken: (n) => n === 1 });
  assert.equal(byIssue(rep, 1).status, 'skipped');
  assert.equal(byIssue(rep, 2).status, 'pr');
});

test('test_t7_2_lost_claim_does_not_count_toward_limit', async () => {
  const { rep } = await run({ ...L1, issues: [1, 2] }, { lose: (n) => n === 1 });
  assert.equal(byIssue(rep, 2).status, 'pr');
});

test('test_t7_3_blocked_after_claim_counts_toward_limit', async () => {
  const { rep } = await run({ ...L1, issues: [1, 2] }, { planBlocked: (n) => n === 1 });
  assert.equal(byIssue(rep, 1).status, 'blocked');
  assert.equal(byIssue(rep, 2).status, 'skipped');
  assert.equal(byIssue(rep, 2).reason, 'over limit (1)');
});

test('test_t7_4_workflow_error_after_claim_counts_toward_limit', async () => {
  const { rep } = await run({ ...L1, issues: [1, 2] }, { planBlocked: (n) => n === 1, onCall: throwOn('blocked', () => new Error('boom'), 1) });
  assert.equal(byIssue(rep, 2).status, 'skipped');
  assert.match(byIssue(rep, 2).reason, /over limit \(1\)/);
});

test('test_t7_5_several_claim_skips_in_a_row_still_reach_a_worked_issue', async () => {
  const { rep } = await run({ ...L1, issues: [1, 2, 3] }, { taken: (n) => n === 1, lose: (n) => n === 2 });
  assert.equal(byIssue(rep, 3).status, 'pr');
});

test('test_t7_6_pass_verdict_with_warning_starts_a_fix_round', async () => {
  const review = reviewSeq([{ verdict: 'pass', findings: [finding('warning')] }, { verdict: 'pass', findings: [] }]);
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { review });
  assert.equal(rep[0].status, 'pr');
  const order = labels(calls);
  const firstReview = order.indexOf('review');
  const fixAt = order.indexOf('fix');
  const secondReview = order.indexOf('review', firstReview + 1);
  const shipAt = order.indexOf('ship');
  assert.ok(fixAt > firstReview && fixAt < secondReview, 'fix runs between the two reviews');
  assert.equal(count(calls, 'ship'), 1);
  assert.ok(shipAt > secondReview, 'Ship only after the second review');
});

test('test_t7_7_changes_verdict_with_only_suggestions_ships', async () => {
  const review = { verdict: 'changes', findings: [finding('suggestion')] };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { review });
  assert.equal(rep[0].status, 'pr');
  assert.ok(!has(calls, 'fix'));
  assert.equal(count(calls, 'review'), 1);
});

test('test_t7_8_unknown_severity_blocks_fail_closed', async () => {
  for (const severity of ['major', 'Suggestion']) {
    const review = reviewSeq([{ verdict: 'pass', findings: [finding(severity)] }, { verdict: 'pass', findings: [] }]);
    const { rep, calls } = await run({ ...BASE, issues: [1] }, { review });
    assert.ok(has(calls, 'fix'), `${severity} starts a fix round`);
    assert.equal(rep[0].status, 'pr');
  }
});

test('test_t7_9_warning_left_after_max_review_rounds_blocks_with_same_reason', async () => {
  const cfg = { ...CFG, nextTask: { maxReviewRounds: 2, onQuestion: 'block' } };
  const review = { verdict: 'pass', findings: [finding('warning')] };
  const { rep } = await run({ ...BASE, config: cfg, issues: [1] }, { review });
  assert.equal(rep[0].status, 'blocked');
  assert.ok(rep[0].reason.startsWith('Review: Review still has critical/warning findings after 2 fix round(s)'), rep[0].reason);
});

test('test_t7_10_unaccepted_scan_hit_with_pass_verdict_starts_a_fix_round', async () => {
  const seen = { n: 0 };
  const { calls } = await run({ ...BASE, issues: [1] }, { diff: () => (seen.n++ === 0 ? NOQA : ''), review: { verdict: 'pass', findings: [] } });
  assert.ok(has(calls, 'fix'));
});

// T8: ship reuses an open PR; select/branch resume it.
const step0 = (calls) => {
  const p = prompt(calls, 'ship');
  const m = /(^|\n)\s*0[.)][\s\S]*?(?=\n\s*1[.)] )/.exec(p);
  return m ? m[0] : '';
};

// T8.1
test('test_t8_1_ship_step_0_reuses_an_open_pr', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const s = step0(calls);
  assert.ok(s, 'ship prompt has a step 0');
  assert.match(s, /open PR/i);
  assert.match(s, /o\/r/);
  assert.match(s, /feat\/1-x/);
  assert.match(s, /push/i);
  assert.match(s, /base/i);
  assert.match(s, /body/i);
  assert.match(s, /label/i);
  assert.match(s, /(not|never|no) (open|create)[^.\n]*(new|another)|do not open a new/i);
  assert.match(s, /issue labels|continue/i);
  assert.ok(prompt(calls, 'ship').indexOf(s.trim()) < prompt(calls, 'ship').search(/\n\s*1[.)] /), 'step 0 comes first');
});

// T8.2
test('test_t8_2_ship_step_0_intended_base_follows_stacking', async () => {
  const { calls } = await run({ ...BASE, issues: [1, 2], chain: true });
  const c2 = calls.filter((c) => c.l.startsWith('ship')).find((c) => /#2/.test(c.l));
  const m = /(^|\n)\s*0[.)][\s\S]*?(?=\n\s*1[.)] )/.exec(c2.prompt);
  assert.ok(m, 'step 0 present');
  assert.match(m[0], /feat\/1-x/);
});

// T8.3
test('test_t8_3_reused_true_adds_a_note', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { ship: { prNumber: 42, reused: true } });
  assert.equal(rep[0].status, 'pr');
  assert.equal(rep[0].prNumber, 42);
  assert.match(rep[0].notes.join('\n'), /reused open PR #42/);
});

// T8.4
test('test_t8_4_ship_schema_has_reused_boolean_and_pr_number_required', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const schema = calls.find((c) => c.l.startsWith('ship')).schema;
  assert.equal(schema.properties.reused.type, 'boolean');
  assert.ok(schema.required.includes('prNumber'));
  assert.ok(!schema.required.includes('reused'));
});

// T8.5
test('test_t8_5_reused_false_or_missing_adds_no_note', async () => {
  for (const ship of [{ reused: false }, {}]) {
    const { rep } = await run({ ...BASE, issues: [1] }, { ship });
    assert.equal(rep[0].status, 'pr');
    assert.ok(!rep[0].notes.some((n) => /^reused open PR/.test(n)));
  }
});

// T8.6
test('test_t8_6_reuse_never_removes_labels', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const s = step0(calls);
  assert.match(s, /risk:high/);
  assert.match(s, /(never|not|without) remov/i);
  assert.match(s, /already on/i);
});

// T8.8
test('test_t8_8_select_keeps_an_issue_with_its_own_devflow_pr', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const p = prompt(calls, 'select');
  assert.match(p, /resumeBranch/);
  assert.match(p, /Closes #<n>|Closes #/);
  assert.match(p, /head branch/i);
  assert.match(p, /only open PR/i);
  assert.match(p, /devflow/);
  assert.match(p, /any other open PR|other open PR/i);
  assert.doesNotMatch(p, /already has an open PR referencing it\)/, 'the explicit-issues sentence does not skip unconditionally on an open PR');
  assert.match(p, /except as allowed by the open-PR rule/i);
});

// T8.9
test('test_t8_9_branch_resumes_the_pr_branch_even_with_another_slug', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { resumeBranch: 'fix/1-old-slug' });
  const p = prompt(calls, 'branch');
  assert.match(p, /fix\/1-old-slug/);
  assert.match(p, /resume/i);
  assert.match(p, /remote|origin/i);
  assert.doesNotMatch(p, /branchPattern/);
  const { calls: other } = await run({ ...BASE, issues: [1] });
  assert.doesNotMatch(prompt(other, 'branch'), /fix\/1-old-slug/);
});

// T8.10
test('test_t8_10_an_issue_in_review_is_not_selected_or_claimed', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const sel = prompt(calls, 'select');
  assert.match(sel, /agent:review/);
  assert.match(sel, /even when|even if|still skipped|is skipped/i);
  assert.match(prompt(calls, 'claim'), /agent:review/);
});

// T8.11 (Decision 2026-11-13): reused stacked PR retargets to the base when step 1b finds the parent merged.
test('test_t8_11_reused_stacked_pr_retargets_to_base_when_parent_merged', async () => {
  const parents = () => [{ issue: 9, prNumber: 90, branch: 'feat/9-p', inRun: false }];
  const { calls } = await run({ ...BASE, issues: [1] }, { parents });
  const p = prompt(calls, 'ship');
  const s = step0(calls);
  assert.match(s, /feat\/9-p/, 'step 0 names the parent branch as the normal base');
  assert.match(s, /retarget[^.]*\bmain\b[^.]*step 1b[^.]*merged|step 1b[^.]*merged[^.]*retarget[^.]*\bmain\b/i, 'retarget to base when parent merged');
  assert.match(s, /except[^)]*stacked[^)]*step 1b|stacked[^)]*except[^)]*step 1b/i, 'stacked label removable only then');
  assert.match(p, /1b\.[\s\S]*in steps 0, 2 and 3/, 'step 1b covers step 0');
  const { calls: plain } = await run({ ...BASE, issues: [1] });
  assert.doesNotMatch(step0(plain), /step 1b/, 'no 1b clause without a parent');
});

// ---------------------------------------------------------------------------------------------
// T6 (#33): stages read the issue from GitHub themselves
// ---------------------------------------------------------------------------------------------

const MARK = 'MARKER-7f3a';
const MCP_RE = /Use the GitHub MCP server for every GitHub operation/;
const PARENTS2 = () => [
  { issue: 8, prNumber: 80, branch: 'feat/8-p', inRun: false },
  { issue: 9, prNumber: 90, branch: 'feat/9-p', inRun: false },
];
const noteText = (rep, i = 0) => (rep[i].notes || []).join('\n');
const readsFromGithub = /read[^.\n]*#1[^.\n]*o\/r[^.\n]*from GitHub/i;
// A run that reaches Integrate, Plan, QA, Implement, Fix, Verify and Review.
const SEVEN_OPTS = { ...QA, body: 'spec docs/specs/a.md\n' + MARK, labels: ['needs-e2e', 'risk:low'], parents: PARENTS2, checkFirstFails: true };
const sevenArgs = (extra = {}) => ({ ...BASE, config: VERIFY_CFG, issues: [1], ...extra });
const SEVEN = ['integrate', 'plan', 'qa', 'implement', 'fix', 'verify', 'review'];

// T6.1
test('test_t6_1_seven_prompts_drop_the_select_body', async () => {
  const { rep, calls } = await run(sevenArgs(), SEVEN_OPTS);
  assert.equal(rep[0].status, 'pr');
  for (const l of SEVEN) {
    assert.ok(has(calls, l), `${l} was called`);
    assert.ok(!calls.filter((c) => c.l.startsWith(l)).some((c) => c.prompt.includes(MARK)), `${l} prompt has no Select body`);
  }
  assert.ok(prompt(calls, 'select').length > 0);
});

// T6.2
test('test_t6_2_seven_prompts_say_to_read_the_issue_from_github', async () => {
  const { calls } = await run(sevenArgs({ ghCli: false }), SEVEN_OPTS);
  for (const l of SEVEN) {
    const p = prompt(calls, l);
    assert.match(p, /#1/, l);
    assert.match(p, /o\/r/, l);
    assert.match(p, readsFromGithub, `${l} tells the agent to read the issue from GitHub`);
    assert.match(p, /source of truth/i, l);
    assert.match(p, /\bt1\b/, `${l} keeps the title inline`);
  }
});

// T6.3
test('test_t6_3_select_still_gets_the_full_body_and_the_engine_parses_it', async () => {
  const body = [
    'Spec: https://github.com/o/r/blob/main/docs/specs/x.md',
    'Depends on #9',
    '| Id | Criterion | Case | Given / When / Then | Level | Priority |',
    '| --- | --- | --- | --- | --- | --- |',
    '| T1.1 | c | happy | g | http | must |',
    'Risk: low - tiny change',
  ].join('\n');
  const { rep, calls } = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { body, labels: ['risk:low'], claimOut: { specPath: '' }, planOut: { specRead: 'docs/specs/x.md' }, devOut: { specRead: 'docs/specs/x.md' } });
  assert.equal(rep[0].status, 'pr');
  assert.match(prompt(calls, 'select'), /full body/);
  assert.match(prompt(calls, 'plan'), /docs\/specs\/x\.md/, 'spec path from the Select copy');
  assert.ok(has(calls, 'verify'), 'http level row from the Select copy triggers verify');
  assert.match(prompt(calls, 'ship'), /Risk: low - tiny change/, 'risk reason from the Select copy');
});

// T6.4
test('test_t6_4_plan_schema_requires_an_integer_acceptance_criteria', async () => {
  const { calls } = await run({ ...BASE, issues: [1] });
  const schema = calls.find((c) => c.l.startsWith('plan')).schema;
  assert.ok(schema.required.includes('acceptanceCriteria'));
  assert.equal(schema.properties.acceptanceCriteria.type, 'integer');
  assert.ok(schema.required.includes('httpOrE2eRows'));
  assert.equal(schema.properties.httpOrE2eRows.type, 'boolean');
});

const AC = (n, extra = '') => `spec docs/specs/a.md\n## Acceptance criteria\n${Array.from({ length: n }, (_, i) => `- [ ] item ${i}`).join('\n')}\n${extra}`;
const acNote = (rep, i = 0) => (rep[i].notes || []).filter((x) => x.startsWith('acceptance criteria:'));

// T6.5
test('test_t6_5_count_mismatch_notes_and_logs_and_the_run_continues', async () => {
  const body = 'spec docs/specs/a.md\n## Acceptance criteria\n- [ ] a\n- [x] b\n';
  const { rep, logs } = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 3 } });
  assert.equal(rep[0].status, 'pr');
  assert.match(noteText(rep), /acceptance criteria: plan read 3, selection had 2/);
  assert.ok(logs.some((l) => /3/.test(l) && /2/.test(l) && /acceptance/i.test(l)), 'a log line has both counts');
});

// T6.6
test('test_t6_6_matching_counts_add_no_note', async () => {
  const body = 'spec docs/specs/a.md\n## Acceptance criteria\n- [ ] a\n- [x] b\n';
  const { rep } = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 2 } });
  assert.equal(rep[0].status, 'pr');
  assert.deepEqual(acNote(rep), []);
});

// T6.7
test('test_t6_7_counts_top_level_items_up_to_the_next_heading', async () => {
  const body = 'spec docs/specs/a.md\n**Acceptance criteria**\n\n- [ ] a\n- [x] b\n  - [ ] sub\n\n## Scope\n- [ ] z\n';
  const { rep } = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 2 } });
  assert.deepEqual(acNote(rep), []);
  assert.doesNotMatch(noteText(rep), /plan did not report/);
});

// T6.8
test('test_t6_8_capital_x_case_insensitive_heading_and_other_bullets', async () => {
  const body = 'spec docs/specs/a.md\n### ACCEPTANCE CRITERIA\n- [X] a\n- [ ] b\n* [ ] c\n1. [ ] d\n';
  const { rep } = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 2 } });
  assert.deepEqual(acNote(rep), []);
});

// T6.9
test('test_t6_9_only_the_first_matching_heading_counts', async () => {
  const body = 'spec docs/specs/a.md\n## Acceptance criteria\n- [ ] a\n## Acceptance criteria (more)\n- [ ] b\n- [ ] c\n- [ ] d\n';
  const { rep } = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 1 } });
  assert.deepEqual(acNote(rep), []);
});

// T6.10
test('test_t6_10_no_heading_counts_zero', async () => {
  const body = 'spec docs/specs/a.md\n- [ ] stray\n';
  let r = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 0 } });
  assert.deepEqual(acNote(r.rep), []);
  r = await run({ ...BASE, issues: [1] }, { body, planOut: { acceptanceCriteria: 2 } });
  assert.ok(acNote(r.rep).includes('acceptance criteria: plan read 2, selection had 0'), noteText(r.rep));
});

// T6.11
test('test_t6_11_plan_omits_or_mistypes_the_count', async () => {
  for (const v of [undefined, '2', 2.5]) {
    const { rep } = await run({ ...BASE, issues: [1] }, { body: AC(2), planOut: { acceptanceCriteria: v } });
    assert.equal(rep[0].status, 'pr', JSON.stringify(v));
    assert.match(noteText(rep), /plan did not report the acceptance criteria count/, JSON.stringify(v));
  }
});

// T6.12
test('test_t6_12_count_is_compared_when_plan_blocks', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { body: AC(2), planBlocked: true, planOut: { acceptanceCriteria: 5 } });
  assert.equal(rep[0].status, 'blocked');
  assert.match(noteText(rep), /acceptance criteria: plan read 5, selection had 2/);
});

// T6.14
test('test_t6_14_review_reads_with_gh_or_runs_on_the_default_agent', async () => {
  let r = await run({ ...BASE, issues: [1] });
  let rv = r.calls.find((c) => c.l.startsWith('review'));
  assert.equal(rv.agentType, 'devflow:reviewer');
  assert.ok(rv.prompt.includes('gh issue view 1 --repo o/r'));
  assert.ok(rv.schema.required.includes('issueRead'));
  assert.equal(rv.schema.properties.issueRead.type, 'boolean');
  assert.doesNotMatch(noteText(r.rep), /review ran on the default agent/);
  r = await run({ ...BASE, issues: [1], ghCli: false });
  rv = r.calls.find((c) => c.l.startsWith('review'));
  assert.equal(rv.agentType, undefined);
  assert.match(rv.prompt, /GitHub MCP server/);
  assert.match(noteText(r.rep), /review ran on the default agent: gh is not installed/);
});

// The reviewer cannot read the issue; the default agent reports one finding in its first round, then passes.
function blindThenFinding() {
  let seen = 0;
  return (n, type) => (type ? { verdict: 'pass', findings: [], issueRead: false } : { verdict: 'pass', findings: seen++ === 0 ? [FINDING] : [], issueRead: true });
}
const FINDING = { severity: 'warning', file: 'src/x.py', line: 1, problem: 'p', fix: 'f' };
// T6.15
test('test_t6_15_reviewer_could_not_read_the_issue_reruns_on_the_default_agent', async () => {
  const reviewFn = blindThenFinding();
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { review: reviewFn });
  const reviews = calls.filter((c) => c.l.startsWith('review'));
  assert.equal(reviews[0].agentType, 'devflow:reviewer');
  assert.equal(reviews[1].agentType, undefined);
  assert.match(reviews[1].l, /round 1/, 'same round');
  assert.ok(has(calls, 'fix'), 'the default agent finding decided the loop');
  assert.match(noteText(rep), /review ran on the default agent: the reviewer could not read the issue/);
});

// T6.17
test('test_t6_17_a_stage_that_cannot_reach_github_stops_the_run', async () => {
  const DOWN = 'GitHub MCP unavailable: tools missing';
  const cases = {
    plan: { planOut: { problem: DOWN } },
    fix: { checkFirstFails: true, fixOut: { problem: DOWN } },
    review: { review: { verdict: 'pass', findings: [], problem: DOWN } },
  };
  for (const [stage, opts] of Object.entries(cases)) {
    const { rep, calls } = await run({ ...BASE, issues: [1, 2], ghCli: false }, opts);
    assert.equal(rep[0].mcpDown, true, stage);
    assert.equal(rep[0].status, 'blocked', stage);
    assert.ok(!has(calls, 'blocked'), `${stage}: no blocked cleanup`);
    assert.equal(rep[1].status, 'skipped', stage);
    assert.match(rep[1].reason, /GitHub MCP unavailable: the run stopped at #1/, stage);
    assert.ok(!has(calls, 'claim #2'), stage);
  }
  // The MCP note is in every stage prompt, and in a default-agent review but not in a devflow:reviewer review.
  const down = await run(sevenArgs({ ghCli: false }), SEVEN_OPTS);
  for (const l of SEVEN) assert.match(prompt(down.calls, l), MCP_RE, l);
  const up = await run({ ...BASE, issues: [1] });
  const rv = up.calls.find((c) => c.l.startsWith('review'));
  assert.equal(rv.agentType, 'devflow:reviewer');
  assert.doesNotMatch(rv.prompt, MCP_RE);
  assert.match(rv.prompt, /gh issue view/);
});

test('test_t6_17_schemas_of_the_seven_stages_allow_problem', async () => {
  const { calls } = await run(sevenArgs(), SEVEN_OPTS);
  for (const l of SEVEN) {
    const c = calls.find((x) => x.l.startsWith(l));
    assert.ok(c && c.schema.properties.problem, `${l} schema has problem`);
  }
});

// T6.18
test('test_t6_18_claim_labels_decide_risk', async () => {
  let r = await run({ ...BASE, issues: [1] }, { labels: ['risk:low'], claimLabels: ['risk:high'] });
  assert.equal(r.rep[0].status, 'pr');
  assert.match(prompt(r.calls, 'ship'), /Risk: high/);
  assert.match(noteText(r.rep), /labels differ from the selection: risk:high/);
  const cs = r.calls.find((c) => c.l.startsWith('claim')).schema;
  for (const k of ['labels', 'specPath', 'introducedBy']) assert.ok(cs.required.includes(k), k);
  r = await run({ ...BASE, issues: [1] }, { labels: ['risk:low'], claimLabels: ['risk:low'] });
  assert.match(prompt(r.calls, 'ship'), /Risk: low/);
  assert.doesNotMatch(noteText(r.rep), /labels differ from the selection/);
});

// T6.19
test('test_t6_19_plans_http_or_e2e_flag_triggers_verify', async () => {
  const body = 'spec docs/specs/a.md\nno table here';
  let r = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { body, planOut: { httpOrE2eRows: true } });
  assert.ok(has(r.calls, 'verify'));
  r = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { body, planOut: { httpOrE2eRows: false } });
  assert.ok(!has(r.calls, 'verify'));
});

// T6.20
test('test_t6_20_claims_spec_path_wins_over_a_cut_select_copy', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...QA, body: 'no spec link here', claimOut: { specPath: 'docs/specs/a.md', introducedBy: true } });
  assert.equal(rep[0].status, 'pr');
  for (const l of ['plan', 'implement', 'qa', 'review']) {
    assert.match(prompt(calls, l), /docs\/specs\/a\.md/, l);
    assert.doesNotMatch(prompt(calls, l), /The issue links no spec/, l);
  }
  assert.match(prompt(calls, 'ship'), /Root cause/);
  assert.match(noteText(rep), /spec path differs from the selection: docs\/specs\/a\.md/);
});

// T6.21
test('test_t6_21_default_agent_fallback_sticks_and_fails_closed', async () => {
  let r = await run({ ...BASE, issues: [1] }, { review: blindThenFinding() });
  // Round 1: reviewer (blind) then default agent with a finding; the fix runs; round 2 goes straight to the default agent.
  let reviews = r.calls.filter((c) => c.l.startsWith('review'));
  assert.equal(reviews.filter((c) => c.agentType).length, 1, 'one reviewer call in total');
  assert.ok(reviews.length >= 3 && reviews.slice(1).every((c) => !c.agentType));
  assert.match(reviews[reviews.length - 1].l, /round 2/);
  r = await run({ ...BASE, issues: [1] }, { review: () => ({ verdict: 'pass', findings: [], issueRead: false }) });
  assert.equal(r.rep[0].status, 'blocked');
  assert.match(r.rep[0].reason, /Review: the review could not read the issue/);
  assert.ok(has(r.calls, 'blocked'));
});

// ---------------------------------------------------------------------------------------------
// T4 (#55): short path for risk:low issues
// ---------------------------------------------------------------------------------------------

const UNIT_ROW = '| T1.1 | T1 | c | happy | g | unit | must |';
const SHORT_BODY = 'spec docs/specs/a.md\n| Id | Task | Criterion | Case | Given / When / Then | Level | Priority |\n| --- | --- | --- | --- | --- | --- | --- |\n' + UNIT_ROW;
const SHORT_OPTS = { labels: ['risk:low'], body: SHORT_BODY };
const SHORT_NOTE = 'none (short path: no plan stage)';

// T4.1
test('test_t4_1_short_path_skips_plan', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, SHORT_OPTS);
  assert.equal(rep[0].status, 'pr');
  assert.ok(!has(calls, 'plan'), 'no plan agent');
  assert.equal(calls.filter((c) => c.l.startsWith('implement')).length, 1);
  const p = prompt(calls, 'implement');
  assert.ok(p.includes(SHORT_NOTE));
  assert.match(p, /failing test/i);
});

// T4.2
test('test_t4_2_short_path_no_qa_with_parallel_qa', async () => {
  const { rep, calls } = await run({ ...BASE, config: { ...CFG, nextTask: { parallelQa: true } }, issues: [1] }, { ...QA, ...SHORT_OPTS });
  assert.equal(rep[0].status, 'pr');
  assert.ok(!has(calls, 'qa'), 'no qa agent');
  assert.ok(!has(calls, 'commit'), 'no commit agent');
  assert.ok(!has(calls, 'plan'));
  assert.equal(calls.filter((c) => c.l.startsWith('implement')).length, 1);
});

// T4.3
test('test_t4_3_short_path_never_verifies', async () => {
  let r = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { ...SHORT_OPTS, devOut: { touchesUi: true } });
  assert.equal(r.rep[0].status, 'pr');
  assert.ok(!has(r.calls, 'verify'), 'no verify agent');
  assert.match(prompt(r.calls, 'ship'), /skipped \(short path\)/);
  r = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { ...SHORT_OPTS, devOut: { touchesUi: false } });
  assert.ok(!has(r.calls, 'verify'));
  assert.doesNotMatch(prompt(r.calls, 'ship'), /skipped \(short path\)/);
  assert.match(prompt(r.calls, 'ship'), /Verification: not needed/);
});

// T4.4
test('test_t4_4_short_path_keeps_check_review_risk_ship', async () => {
  let seen = 0;
  const review = () => (seen++ === 0 ? { verdict: 'changes', findings: [{ severity: 'critical', file: 'src/x.py', line: 1, problem: 'p', fix: 'f' }] } : { verdict: 'pass', findings: [] });
  const { rep, calls } = await run({ ...BASE, config: { ...CFG, nextTask: { maxReviewRounds: 2 } }, issues: [1] }, { ...SHORT_OPTS, checkFirstFails: true, review, diff: '' });
  assert.equal(rep[0].status, 'pr');
  const seq = labels(calls).filter((l) => !['select', 'claim', 'branch', 'restore'].includes(l));
  assert.deepEqual(seq, ['implement', 'check', 'fix', 'check', 'scan', 'review', 'fix', 'check', 'scan', 'review', 'ship']);
});

// T4.5
test('test_t4_5_short_path_review_round_limit', async () => {
  const review = { verdict: 'changes', findings: [{ severity: 'critical', file: 'src/x.py', line: 1, problem: 'p', fix: 'f' }] };
  const { rep, calls } = await run({ ...BASE, config: { ...CFG, nextTask: { maxReviewRounds: 2 } }, issues: [1] }, { ...SHORT_OPTS, review, diff: '' });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Review:/);
  assert.ok(!has(calls, 'ship'));
  assert.match(rep[0].reason, /after 2 fix round/);
});

// T4.6
test('test_t4_6_high_label_full_path', async () => {
  for (const lbls of [['risk:high'], ['risk:low', 'risk:high']]) {
    const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...SHORT_OPTS, labels: lbls });
    assert.ok(has(calls, 'plan'), lbls.join());
    assert.equal(rep[0].path, 'full', lbls.join());
  }
});

// T4.7
test('test_t4_7_no_risk_or_e2e_full_path', async () => {
  for (const lbls of [[], ['risk:low', 'needs-e2e']]) {
    const { rep, calls } = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, { ...SHORT_OPTS, labels: lbls });
    assert.ok(has(calls, 'plan'), lbls.join());
    assert.equal(rep[0].path, 'full', lbls.join());
  }
});

// T4.8
test('test_t4_8_http_or_e2e_row_full_path', async () => {
  const { pathFor } = await helpers();
  const row = (level) => `| Id | Task | Criterion | Case | Given / When / Then | Level | Priority |\n| --- | --- | --- | --- | --- | --- | --- |\n| T1.1 | T1 | c | happy | g | ${level} | must |`;
  const mk = (level) => ({ number: 1, labels: ['risk:low'], body: row(level) });
  assert.equal(pathFor(mk('http'), CFG), 'full');
  assert.equal(pathFor(mk('e2e'), CFG), 'full');
  assert.equal(pathFor(mk('unit'), CFG), 'short');
});

// T4.9
test('test_t4_9_escalated_short_path_no_verify', async () => {
  const cfg = { ...VERIFY_CFG, risk: { highPaths: ['.github/**'] } };
  const { rep, calls } = await run({ ...BASE, config: cfg, issues: [1] }, { ...SHORT_OPTS, devOut: { touchesUi: true, filesChanged: ['.github/workflows/x.yml'] } });
  assert.equal(rep[0].status, 'pr');
  assert.equal(rep[0].risk, 'high');
  assert.ok(!has(calls, 'verify'), 'no verify agent');
  const ship = prompt(calls, 'ship');
  assert.match(ship, /Risk: high/);
  assert.match(ship, /skipped \(short path\)/);
});

// T4.10
test('test_t4_10_result_has_path', async () => {
  const { rep } = await run({ ...BASE, issues: [1, 2] }, { ...SHORT_OPTS, selectLabels: (n) => (n === 1 ? ['risk:low'] : ['risk:high']) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(rep[0].path, 'short');
  assert.equal(rep[1].status, 'pr');
  assert.equal(rep[1].path, 'full');
});

// ---------------------------------------------------------------------------------------------
// T5 (#56): Ship records the review trace and run markers; block comments carry a marker
// ---------------------------------------------------------------------------------------------

const CHANGES = { verdict: 'changes', findings: [{ severity: 'critical', file: 'src/x.py', line: 1, problem: 'p', fix: 'f' }] };
const PASS = { verdict: 'pass', findings: [] };
// A reviewer that asks for changes until call number `passOn` (1-based), counting its calls.
const reviewPassOn = (passOn, counter) => () => (++counter.n >= passOn ? PASS : CHANGES);
const MARKER_RE = /<!-- devflow-run (\{.*\}) -->/;

// T5.1
test('test_t5_1_ship_review_section_off', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { review: PASS });
  assert.equal(rep[0].status, 'pr');
  const ship = prompt(calls, 'ship');
  assert.ok(ship.includes('## Review'));
  assert.ok(ship.includes('Review: pass after 1 round(s) - local devflow reviewer in this run (GitHub review: off)'));
  assert.ok(ship.includes('Path: full'));
});

// T5.2
test('test_t5_2_ship_review_section_on_short', async () => {
  const c = { n: 0 };
  const cfg = { ...CFG, review: { github: true }, nextTask: { maxReviewRounds: 2 } };
  const { rep, calls } = await run({ ...BASE, config: cfg, issues: [1] }, { ...SHORT_OPTS, review: reviewPassOn(2, c), diff: '' });
  assert.equal(rep[0].status, 'pr');
  const ship = prompt(calls, 'ship');
  assert.ok(ship.includes('pass after 2 round(s)'));
  assert.ok(ship.includes('(GitHub review: on)'));
  assert.ok(ship.includes('Path: short (Plan and Verify skipped)'));
});

// T5.3
test('test_t5_3_ship_verify_values', async () => {
  const shipOf = async (opts) => {
    const r = await run({ ...BASE, config: VERIFY_CFG, issues: [1] }, opts);
    assert.equal(r.rep[0].status, 'pr');
    return prompt(r.calls, 'ship');
  };
  // full path, Verify ran
  let ship = await shipOf({ labels: VERIFY_LABELS, body: SHORT_BODY });
  assert.ok(ship.includes('Verify: ran'), 'ran');
  // short path with UI: skipped
  ship = await shipOf({ ...SHORT_OPTS, devOut: { touchesUi: true } });
  assert.ok(ship.includes('Verify: skipped (short path)'), 'skipped');
  // short path without UI: not needed
  ship = await shipOf({ ...SHORT_OPTS, devOut: { touchesUi: false } });
  assert.ok(ship.includes('Verify: not needed'), 'not needed');
  // full path where Verify could not run
  ship = await shipOf({ labels: VERIFY_LABELS, body: SHORT_BODY, verify: { ran: false, notes: 'verify lock busy' } });
  assert.ok(ship.includes('Verify: could not run'), 'could not run');
});

// T5.4
test('test_t5_4_ship_run_marker', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { ...SHORT_OPTS, claimOut: { claims: [{ commentId: 11, claimId: 'C-me', createdAt: '2026-11-17T10:00:00Z' }] } });
  const ship = prompt(calls, 'ship');
  assert.ok(ship.includes('<!-- devflow-run {"path":"short","reviewRounds":1,"claimedAt":"2026-11-17T10:00:00Z"} -->'));
});

// T5.5
test('test_t5_5_run_marker_claimed_at_null', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { ...SHORT_OPTS, claimOut: { claims: [{ commentId: 11, claimId: 'C-me' }] } });
  const m = MARKER_RE.exec(prompt(calls, 'ship'));
  assert.ok(m, 'marker present');
  const data = JSON.parse(m[1]);
  assert.equal(data.claimedAt, null);
  assert.ok(m[1].includes('"claimedAt":null'));
  assert.equal(data.path, 'short');
  assert.equal(data.reviewRounds, 1);
});

// T5.6
test('test_t5_6_result_has_review_rounds', async () => {
  const c = { n: 0 };
  const cfg = { ...CFG, nextTask: { maxReviewRounds: 2 } };
  const { rep } = await run({ ...BASE, config: cfg, issues: [1] }, { review: reviewPassOn(2, c), diff: '' });
  assert.equal(c.n, 2);
  assert.equal(rep[0].status, 'pr');
  assert.equal(rep[0].reviewRounds, 2);
});

// T5.7
test('test_t5_7_one_blocked_marker_per_block', async () => {
  const MARK = '<!-- devflow-blocked -->';
  const count = (s) => s.split(MARK).length - 1;
  // with questions: the questions comment carries it as line 2
  let r = await run({ ...BASE, issues: [1] }, { planBlocked: true });
  let b = prompt(r.calls, 'blocked');
  assert.equal(count(b), 1, 'exactly one marker with questions');
  assert.ok(b.includes('<!-- devflow-questions -->\n' + MARK + '\n'), 'marker is line 2 after the questions marker');
  // without questions: the reason comment carries it, no questions marker body
  r = await run({ ...BASE, config: { ...CFG, nextTask: { maxReviewRounds: 1 } }, issues: [1] }, { review: CHANGES, diff: '' });
  assert.equal(r.rep[0].status, 'blocked');
  b = prompt(r.calls, 'blocked');
  assert.equal(count(b), 1, 'exactly one marker without questions');
  assert.ok(!b.includes('<!-- devflow-questions -->\n'), 'no questions comment body');
});

// ---- T6 (wave2 #57): the epic as the spec source ----
const EPIC_BODY = 'Context\nEpic: #42\n\n## Acceptance criteria\n- [ ] a\n';
const EPIC_READ = { specRead: 'epic #42', epicRead: true };
const EPIC_OPTS = { body: EPIC_BODY, planOut: EPIC_READ, devOut: EPIC_READ, qaOut: EPIC_READ };
const SPEC_FILE = /docs\/specs\/[\w.-]+\.md/;

// T6.1
test('test_t6_1_epic_for_basic', async () => {
  const { epicFor } = await helpers();
  assert.equal(epicFor({ body: 'Epic: #42' }), 42);
  assert.equal(epicFor({ body: 'no epic here' }), 0);
});

// T6.2
test('test_t6_2_epic_for_anchored_first_match', async () => {
  const { epicFor } = await helpers();
  assert.equal(epicFor({ body: 'See Epic: #42' }), 0);
  assert.equal(epicFor({ body: 'Epic: #7\nEpic: #9' }), 7);
  assert.equal(epicFor({ body: 'Context\nEpic: #12\n' }), 12);
});

// T6.3
test('test_t6_3_prompts_use_epic_source', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1], ghCli: true }, { ...QA, ...EPIC_OPTS, checkFirstFails: true });
  assert.equal(rep[0].status, 'pr');
  for (const l of ['plan', 'implement', 'qa', 'fix', 'review']) {
    const p = prompt(calls, l);
    assert.ok(p, `${l} prompt exists`);
    assert.match(p, /#42/, `${l} mentions the epic`);
    assert.match(p, /## Decisions/, `${l} says the issue's Decisions win`);
    assert.doesNotMatch(p, SPEC_FILE, `${l} names no spec path`);
  }
  for (const l of ['plan', 'implement', 'qa', 'fix']) assert.match(prompt(calls, l), /issue_read/, `${l} reads the epic with issue_read`);
  assert.match(prompt(calls, 'review'), /gh issue view 42/);
});

// T6.4
test('test_t6_4_spec_read_whole_token', async () => {
  let r = await run({ ...BASE, issues: [1] }, { ...EPIC_OPTS, planOut: { specRead: '#420', epicRead: true } });
  assert.equal(r.rep[0].status, 'blocked');
  assert.match(r.rep[0].reason, /^Plan/);
  r = await run({ ...BASE, issues: [1] }, { ...EPIC_OPTS, planOut: { specRead: 'epic #42.', epicRead: true } });
  assert.equal(r.rep[0].status, 'pr');
});

// T6.5
test('test_t6_5_implement_missing_epic_read_fix_then_block', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...EPIC_OPTS, devOut: { specRead: '', epicRead: true } });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Implement/);
  assert.equal(calls.filter((c) => c.l.startsWith('fix')).length, 1, 'exactly one corrective fix');
});

// T6.6
test('test_t6_6_unreadable_epic_blocks', async () => {
  const r = await run({ ...BASE, issues: [1] }, { ...EPIC_OPTS, planOut: { specRead: 'none', epicRead: false } });
  assert.equal(r.rep[0].status, 'blocked');
  assert.match(r.rep[0].reason, /epic #42 could not be read/);
  const ok = await run({ ...BASE, issues: [1], ghCli: true }, { ...QA, ...EPIC_OPTS, checkFirstFails: true });
  for (const l of ['plan', 'implement', 'qa', 'fix', 'review']) {
    const c = ok.calls.find((x) => x.l.startsWith(l));
    assert.ok(c && c.schema, `${l} has a schema`);
    assert.equal(c.schema.properties.epicRead.type, 'boolean', `${l} schema lists epicRead`);
  }
  // An unreadable epic reported by a later stage blocks too.
  const d = await run({ ...BASE, issues: [1] }, { ...EPIC_OPTS, devOut: { specRead: 'epic #42', epicRead: false } });
  assert.equal(d.rep[0].status, 'blocked');
  assert.match(d.rep[0].reason, /epic #42 could not be read/);
});

// T6.7
test('test_t6_7_spec_path_wins_over_epic', async () => {
  const body = 'Spec: docs/specs/2026-11-17-x.md\nEpic: #42\n';
  const specOpts = { body, claimOut: { specPath: '' }, planOut: { specRead: 'docs/specs/2026-11-17-x.md' }, devOut: { specRead: 'docs/specs/2026-11-17-x.md' } };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, specOpts);
  assert.equal(rep[0].status, 'pr');
  for (const l of ['plan', 'implement']) {
    assert.match(prompt(calls, l), /docs\/specs\/2026-11-17-x\.md/, `${l} references the spec file`);
    assert.doesNotMatch(prompt(calls, l), /epicRead|read epic/i, `${l} does not read the epic`);
  }
  // specRead is checked against the path, not the epic number.
  const r = await run({ ...BASE, issues: [1] }, { ...specOpts, planOut: { specRead: 'epic #42' } });
  assert.equal(r.rep[0].status, 'blocked');
  assert.match(r.rep[0].reason, /^Plan/);
});

// T6.8
test('test_t6_8_issue_alone_source', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { body: 'Just an issue\n', claimOut: { specPath: '' }, planOut: { specRead: 'none' }, devOut: { specRead: 'none' } });
  assert.equal(rep[0].status, 'pr');
  for (const l of ['plan', 'implement']) {
    assert.doesNotMatch(prompt(calls, l), SPEC_FILE, `${l} asks no spec read`);
    assert.doesNotMatch(prompt(calls, l), /epicRead|read epic/i, `${l} asks no epic read`);
  }
});

// T6.9
test('test_t6_9_reviewer_reads_epic', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'agents', 'reviewer.md'), 'utf8');
  assert.match(text, /Epic:/);
  assert.match(text, /gh issue view/);
});

// #94: commit grouping follows CLAUDE.md and the plan.
const RULES = 'RULES-MARKER: keep code, tests and docs in separate commits';
const ORDER = 'ORDER-MARKER: 1. failing test 2. code 3. docs';
const PLAN94 = `## Files to change\nx\n\n## Order of commits\n${ORDER}\n\n## Open questions\nnone`;
const prompts94 = (calls, p) => calls.filter((c) => c.l.startsWith(p)).map((c) => c.prompt);
const run94 = (planOut, extra = {}) => run({ ...BASE, issues: [1] }, { ...QA, checkFirstFails: true, planOut, ...extra });
const REWRITE = /\b(amend|rebase|squash|split)\b/i;

test('T2.1 commit and fix prompts carry the CLAUDE.md rules and the plan order', async () => {
  const { calls } = await run94({ plan: PLAN94, commitRules: RULES, separateCommits: false });
  assert.equal(prompts94(calls, 'commit').length, 1);
  assert.equal(prompts94(calls, 'fix').length, 1);
  for (const p of [...prompts94(calls, 'commit'), ...prompts94(calls, 'fix')]) {
    assert.ok(p.includes(RULES), 'rules present');
    assert.ok(p.includes(ORDER), 'order present');
  }
});

test('T2.2 short path: CLAUDE.md commit rules and no plan order', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { labels: ['risk:low'], checkFirstFails: true });
  const fix = prompts94(calls, 'fix');
  assert.equal(fix.length, 1);
  assert.match(fix[0], /commit rules/i);
  assert.doesNotMatch(fix[0], /Order of commits/);
});

test('T2.3 separate-commit rule: QA test commit, code commit, then a docs commit', async () => {
  const { calls } = await run94({ plan: PLAN94, commitRules: RULES, separateCommits: true });
  const p = prompts94(calls, 'commit')[0];
  assert.match(p, /QA test commit/);
  assert.match(p, /docs\(/);
  assert.match(p, /repository-root `\*\.md`/);
  assert.match(p, /`docs\/\*\*`/);
  assert.match(p, /changelog fragment/i);
  assert.match(p, /never `skills\/\*\*` or `agents\/\*\*`/);
  assert.ok(p.indexOf('QA test commit') < p.indexOf('code commit') && p.indexOf('code commit') < p.indexOf('docs('));
});

test('T2.4 separate-commit rule: the docs commit is skipped when no docs files changed', async () => {
  const { calls } = await run94({ plan: PLAN94, commitRules: RULES, separateCommits: true });
  assert.match(prompts94(calls, 'commit')[0], /skip the docs commit/i);
});

test('T2.5 CLAUDE.md silent on grouping: 3.0.0 grouping, no docs commit', async () => {
  const { calls } = await run94({ plan: PLAN94, commitRules: '', separateCommits: false });
  const p = prompts94(calls, 'commit')[0];
  assert.match(p, /test\(/);
  assert.match(p, /feat\|fix\|chore\|refactor/);
  assert.doesNotMatch(p, /docs\(/);
  assert.doesNotMatch(p, /QA test commit/);
});

test('T2.6 no commit or fix prompt asks to amend, rebase, squash or split a commit', async () => {
  for (const separateCommits of [true, false]) {
    const { calls } = await run94({ plan: PLAN94, commitRules: RULES, separateCommits });
    const all = [...prompts94(calls, 'commit'), ...prompts94(calls, 'fix')];
    assert.equal(all.length, 2);
    for (const p of all) assert.doesNotMatch(p, REWRITE);
  }
  const { calls } = await run({ ...BASE, issues: [1] }, { labels: ['risk:low'], checkFirstFails: true });
  for (const p of prompts94(calls, 'fix')) assert.doesNotMatch(p, REWRITE);
});

// ---- #93: QA-owned findings go to a QA fix agent; commit-structure findings are suggestions ----
const Q93 = { qaFiles: ['tests/a.test.cjs'], devFiles: ['src/x.js'] };
const f93 = (file, o = {}) => ({ severity: 'warning', file, line: 1, problem: 'problem in ' + file, fix: 'fix it', ...o });
const once93 = (findings) => { let k = 0; return () => (k++ === 0 ? { verdict: 'changes', findings } : { verdict: 'pass', findings: [] }); };
const always93 = (findings) => () => ({ verdict: 'changes', findings });
const count93 = (calls, label) => calls.filter((c) => c.l.startsWith(label)).length;
const cfg93 = (nt) => ({ ...BASE, config: { ...CFG, nextTask: nt }, issues: [1] });

test('T1.1 a review finding in qaFiles goes to the QA fix agent, not the dev fix agent', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, review: once93([f93('tests/a.test.cjs')]) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(count93(calls, 'qa-fix'), 1);
  assert.equal(count93(calls, 'fix'), 0);
});

test('T1.2 the QA fix agent changing a file outside qaFiles blocks', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { ...Q93, review: once93([f93('tests/a.test.cjs')]), qaFixOut: { filesChanged: ['src/x.js'] } });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /QA fix agent changed .*src\/x\.js/);
});

test('T1.3 a critical finding in qaFiles runs the QA fix agent', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, review: once93([f93('tests/a.test.cjs', { severity: 'critical' })]) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(count93(calls, 'qa-fix'), 1);
});

test('T1.4 a failing check attributed to a qaFile starts a QA fix round', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, checkFail: (n, c) => (c === 1 ? [{ check: 'test', output: 'boom', files: ['tests/a.test.cjs'] }] : null) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(count93(calls, 'qa-fix'), 1);
  assert.equal(count93(calls, 'fix'), 0);
});

test('T1.5 a failing check attributed to a non-QA file starts the dev fix agent', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, checkFail: (n, c) => (c === 1 ? [{ check: 'test', output: 'boom', files: ['src/x.js'] }] : null) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(count93(calls, 'fix'), 1);
  assert.equal(count93(calls, 'qa-fix'), 0);
});

test('T1.6 the dev fix agent changing a qaFile blocks', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { ...Q93, review: once93([f93('src/x.js')]), fixOut: { filesChanged: ['tests/a.test.cjs'] } });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /QA test files tests\/a\.test\.cjs/);
});

test('T1.7 QA and dev fix rounds share maxFixRounds in the check loop', async () => {
  const fails = (n, c) => [{ check: 'test', output: 'boom', files: [c === 1 ? 'tests/a.test.cjs' : 'src/x.js'] }];
  const { rep, calls } = await run(cfg93({ maxFixRounds: 2 }), { ...Q93, checkFail: fails });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Check:/);
  assert.equal(count93(calls, 'qa-fix') + count93(calls, 'fix'), 2);
  assert.equal(count93(calls, 'check'), 3);
});

test('T1.8 a QA-file finding that stays open gets exactly maxReviewRounds rounds', async () => {
  const { rep, calls } = await run(cfg93({ maxReviewRounds: 1, onQuestion: 'block' }), { ...Q93, review: always93([f93('tests/a.test.cjs')]) });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Review:/);
  assert.equal(count93(calls, 'qa-fix'), 1);
  assert.equal(count93(calls, 'fix'), 0);
  assert.equal(count93(calls, 'review'), 2);
});

test('T1.9 a mixed round runs the QA fix agent, then the dev fix agent, and counts once', async () => {
  const { rep, calls } = await run(cfg93({ maxReviewRounds: 1, onQuestion: 'block' }), { ...Q93, review: always93([f93('tests/a.test.cjs'), f93('src/x.js')]) });
  assert.equal(rep[0].status, 'blocked');
  const order = labels(calls).filter((l) => l === 'qa-fix' || l === 'fix');
  assert.deepEqual(order, ['qa-fix', 'fix']);
  assert.equal(count93(calls, 'review'), 2);
});

test('T1.10 a QA fix round that changes nothing still counts and the dev fix agent still runs', async () => {
  const { rep, calls } = await run(cfg93({ maxReviewRounds: 1, onQuestion: 'block' }), { ...Q93, review: always93([f93('tests/a.test.cjs'), f93('src/x.js')]), qaFixOut: { filesChanged: [] } });
  assert.equal(rep[0].status, 'blocked');
  assert.equal(count93(calls, 'fix'), 1);
  assert.equal(count93(calls, 'review'), 2);
});

const right93 = { qaFixOut: { positions: [{ finding: 'F1', position: 'test is right' }] } };

test('T1.11 "test is right" against "code is right" for one finding blocks with one questions comment', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, ...right93, review: always93([f93('tests/a.test.cjs')]), fixOut: { positions: [{ finding: 'F1', position: 'code is right' }] } });
  assert.equal(rep[0].status, 'blocked');
  const b = prompt(calls, 'blocked');
  assert.equal(count93(calls, 'blocked'), 1);
  assert.match(b, /<!-- devflow-questions -->/);
  assert.match(b, /test is right/);
  assert.match(b, /code is right/);
  assert.match(b, /\n1\. \[QA\][^]*test is right[^]*code is right/);
  assert.ok(!/\n2\. \[/.test(b));
});

test('T1.11 a check failure in a QA file with "test is right" against "code is right" blocks with one questions comment', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, ...right93, checkFail: (n, c) => (c === 1 ? [{ check: 'test', output: 'boom', files: ['tests/a.test.cjs'] }] : null), fixOut: { positions: [{ finding: 'F1', position: 'code is right' }] } });
  assert.equal(rep[0].status, 'blocked');
  const b = prompt(calls, 'blocked');
  assert.equal(count93(calls, 'blocked'), 1);
  assert.match(b, /<!-- devflow-questions -->/);
  assert.match(b, /test is right/);
  assert.match(b, /code is right/);
});

test('T1.12 positions on different findings raise no disagreement block', async () => {
  const { rep } = await run({ ...BASE, issues: [1] }, { ...Q93, ...right93, review: once93([f93('tests/a.test.cjs'), f93('src/x.js')]), fixOut: { positions: [{ finding: 'F2', position: 'code is right' }] } });
  assert.equal(rep[0].status, 'pr');
});

test('T1.13 a disagreement blocks even when onQuestion is decide', async () => {
  const { rep } = await run(cfg93({ onQuestion: 'decide' }), { ...Q93, ...right93, review: always93([f93('tests/a.test.cjs')]), fixOut: { positions: [{ finding: 'F1', position: 'code is right' }] } });
  assert.equal(rep[0].status, 'blocked');
});

test('T1.14 a commit-structure finding is a suggestion: listed in the PR notes, no fix, no block', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, review: always93([f93('src/x.js', { severity: 'critical', category: 'commit-structure', problem: 'split the commit please' })]) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(count93(calls, 'fix') + count93(calls, 'qa-fix'), 0);
  assert.match(prompt(calls, 'ship'), /split the commit please/);
});

test('T1.15 commit-structure is a suggestion before routing by file', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q93, review: always93([f93('tests/a.test.cjs', { category: 'commit-structure' })]) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(count93(calls, 'qa-fix'), 0);
});

test('T1.16 other or missing categories are not downgraded', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, { ...Q93, review: once93([f93('tests/a.test.cjs', { category: 'correctness' }), f93('src/x.js')]) });
  assert.equal(count93(calls, 'qa-fix'), 1);
  assert.equal(count93(calls, 'fix'), 1);
});

test('T1.17 reviewer.md and the review prompt name category commit-structure for suggestions', async () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'agents', 'reviewer.md'), 'utf8');
  const { calls } = await run({ ...BASE, issues: [1] });
  for (const text of [md, prompt(calls, 'review')]) {
    assert.match(text, /category: "commit-structure"/);
    assert.match(text, /split/);
    assert.match(text, /order/);
    assert.match(text, /wording/);
    assert.match(text, /suggestion/);
  }
});

test('T1.18 "test is right" without a dev position leaves the finding open, no block', async () => {
  const { rep, calls } = await run({ ...BASE, config: { ...CFG, nextTask: { onQuestion: 'block' } }, issues: [1] }, { ...Q93, ...right93, review: always93([f93('tests/a.test.cjs')]) });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Review: Review still has/);
  assert.equal(count93(calls, 'qa-fix'), 2);
  assert.equal(count93(calls, 'fix'), 2);
});

// ---- #104: QA test rules: no unrelated fixture changes, no branch-state tests ----
const scan104 = async (file, hunk, extra = '') => {
  const { scanWeakenedChecks } = await helpers();
  return scanWeakenedChecks(diffOf(file, hunk, extra), []).filter((h) => h.kind === 'changed-existing-test');
};
const Q104 = { qaFiles: ['tests/a.test.cjs'], devFiles: ['src/x.js'] };
const CHANGED104 = '@@ -3 +3 @@\n-  assert.equal(a, 1);\n+  assert.equal(a, 2);';

test('T3.1 the QA prompt forbids changing an existing test or fixture a Test cases row does not name', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, Q104);
  const p = prompt(calls, 'qa #');
  assert.match(p, /never change an existing test or fixture/i);
  assert.match(p, /not named by a "Test cases" row/);
  assert.match(p, /report it in (the|your) result/i);
});

test('T3.2 the QA prompt forbids branch-state tests and returns such a row as a review check', async () => {
  const { calls } = await run({ ...BASE, issues: [1] }, Q104);
  const p = prompt(calls, 'qa #');
  assert.match(p, /no test may depend on branch state/i);
  for (const w of ['diff against the base branch', 'current branch name', 'unpushed commits', 'current date']) assert.ok(p.includes(w), w);
  assert.match(p, /review check, not a test/);
});

test('T3.3 a changed existing assertion outside qaFiles is a changed-existing-test hit', async () => {
  const hits = await scan104('tests/test_a.py', '@@ -3 +3 @@\n-    assert a == 1\n+    assert a == 2');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'tests/test_a.py');
});

test('T3.4 a deleted assertion line is a changed-existing-test hit', async () => {
  const hits = await scan104('tests/test_a.py', '@@ -3 +2,0 @@\n-    assert a == 1');
  assert.equal(hits.length, 1);
});

test('T3.5 a changed fixture line is a changed-existing-test hit', async () => {
  const hunk = '@@ -2 +2 @@\n-  "name": "a",\n+  "name": "b",';
  assert.equal((await scan104('tests/fixtures/users.json', hunk)).length, 1);
  assert.equal((await scan104('web/fixtures/users.json', hunk)).length, 1);
});

test('T3.6 a new test file produces no changed-existing-test hit', async () => {
  const hits = await scan104('tests/test_new.py', '@@ -0,0 +1,2 @@\n+def test_x():\n+    assert 1 == 1', 'new file mode 100644\n');
  assert.deepEqual(hits, []);
});

test('T3.7 added lines only produce no changed-existing-test hit', async () => {
  assert.deepEqual(await scan104('tests/test_a.py', '@@ -3,0 +4,2 @@\n+    assert a == 2\n+    assert b == 3'), []);
});

test('T3.8 a whitespace-only change produces no changed-existing-test hit', async () => {
  assert.deepEqual(await scan104('tests/test_a.py', '@@ -3 +3 @@\n-    assert a == 1\n+        assert a == 1  '), []);
});

test('T3.9 a comment-only edit produces no changed-existing-test hit', async () => {
  assert.deepEqual(await scan104('tests/test_a.py', '@@ -3 +3 @@\n-    # old note\n+    # new note'), []);
  assert.deepEqual(await scan104('tests/a.test.cjs', '@@ -3 +3 @@\n-// old note\n+// new note'), []);
});

test('T3.10 a pure rename produces no changed-existing-test hit', async () => {
  const { scanWeakenedChecks } = await helpers();
  const text = 'diff --git a/tests/test_a.py b/tests/test_b.py\nsimilarity index 100%\nrename from tests/test_a.py\nrename to tests/test_b.py\n';
  assert.deepEqual(scanWeakenedChecks(text, []).filter((h) => h.kind === 'changed-existing-test'), []);
});

test('T3.11 a changed pre-existing line in a qaFiles file is still a hit', async () => {
  assert.equal((await scan104('tests/a.test.cjs', CHANGED104)).length, 1);
});

test('T3.12 a changed pre-existing line in a test file not in qaFiles is a hit', async () => {
  assert.equal((await scan104('tests/other.test.cjs', CHANGED104)).length, 1);
});

test('T3.13 a changed-existing-test hit in a qaFiles file goes to the QA fix agent, one outside to the dev Fix agent', async () => {
  const diff = diffOf('tests/a.test.cjs', CHANGED104) + diffOf('tests/other.test.cjs', CHANGED104);
  const seen = { n: 0 };
  const { calls } = await run({ ...BASE, issues: [1] }, { ...Q104, diff: () => (seen.n++ === 0 ? diff : '') });
  const qf = prompt(calls, 'qa-fix');
  const df = prompt(calls, 'fix');
  assert.match(qf, /tests\/a\.test\.cjs:/);
  assert.doesNotMatch(qf, /tests\/other\.test\.cjs:/);
  assert.match(df, /tests\/other\.test\.cjs:/);
  assert.doesNotMatch(df, /tests\/a\.test\.cjs:/);
});

test('T3.14 the review prompt and reviewer.md call a changed existing fixture or assertion a warning', async () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'agents', 'reviewer.md'), 'utf8');
  const { calls } = await run({ ...BASE, issues: [1] });
  for (const text of [md, prompt(calls, 'review')]) {
    assert.match(text, /changed-existing-test/);
    assert.match(text, /existing fixture or assertion[^.]*warning/i);
  }
});

test('T3.15 the spec skill QA step lists a branch-state row as a review check, not a test row', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'skills', 'spec', 'SKILL.md'), 'utf8');
  assert.match(md, /only against branch state[^.]*review check[^.]*not a test row/i);
});

test('T3.16 an accepted changed-existing-test hit is not a blocking finding', async () => {
  const diff = diffOf('tests/other.test.cjs', CHANGED104);
  const review = { verdict: 'pass', findings: [], acceptedWeakenings: [{ file: 'tests/other.test.cjs', line: 3, reason: 'row T1.2 names it' }] };
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { ...Q104, diff, review });
  assert.equal(rep[0].status, 'pr');
  assert.ok(!has(calls, 'fix'));
  assert.match(prompt(calls, 'ship'), /weakened checks kept after review: tests\/other\.test\.cjs:3 changed-existing-test/);
});

// ---- #105: decide-or-block (smoke; the full matrix is in engine-decide.test.cjs) ----
const Q105 = { text: 'which name', tag: 'BA', recommended: 'A', reason: 'r', productDecision: false, reversible: true, changesCriterion: false, dropsMustRow: false, changesContract: false, changesStoredFormat: false, lowersRisk: false, skipsCheck: false, needsDestructiveGit: false, outsideRepo: false };

test('a safe plan question is decided, recorded and shipped with decisions:review', async () => {
  let n = 0;
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { planOut: () => (n++ === 0 ? { status: 'blocked', questions: [Q105] } : {}) });
  assert.equal(rep[0].status, 'pr');
  assert.match(prompt(calls, 'decisions'), /decided by run: which name -> A \(r\)/);
  assert.match(prompt(calls, 'ship'), /decisions:review/);
});

test('a question that changes a criterion blocks with its recommended option and the suffix', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [1] }, { planBlocked: true, planOut: () => ({ questions: [{ ...Q105, changesCriterion: true }] }) });
  assert.equal(rep[0].status, 'blocked');
  assert.match(prompt(calls, 'blocked'), /Recommended: A \(r\) \[changes a criterion: typed answer needed\]/);
});

// ---- #112: fixed rules for branch resume and base conflicts ----
const Q112 = { text: 'does the conflicting behaviour stay?', tag: 'Dev', recommended: 'keep both', reason: 'r', productDecision: true, reversible: true, changesCriterion: false, dropsMustRow: false, changesContract: false, changesStoredFormat: false, lowersRisk: false, skipsCheck: false, needsDestructiveGit: false, outsideRepo: false };
const T7_LABELS = { labels: ['type:feat'] };

test('T7.1 Branch resumes a remote branch starting with <type>/<issue>- without a question and names it in Assumptions', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [12] }, { ...T7_LABELS, branch: { branch: 'feat/12-foo', resumed: true, commits: ['abc feat(#12): x'], matchedByName: true } });
  assert.equal(rep[0].status, 'pr');
  const p = prompt(calls, 'branch');
  assert.match(p, /starts with `<type>\/12-`|starts with "feat\/12-"|`feat\/12-`/);
  assert.match(p, /origin/);
  assert.match(p, /without (asking )?a question|do not ask/i);
  assert.match(p, /matchedByName/);
  assert.match(prompt(calls, 'ship'), /feat\/12-foo/);
  assert.match(prompt(calls, 'ship'), /name starts with/);
});

test('T7.2 Branch also resumes a local-only branch with that prefix', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, T7_LABELS);
  assert.match(prompt(calls, 'branch'), /git branch --list/);
  assert.match(prompt(calls, 'branch'), /local/i);
});

test('T7.3 a branch with another type prefix does not match and a new branch is created', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, T7_LABELS);
  const p = prompt(calls, 'branch');
  assert.match(p, /another (<type>|type) prefix|different type/i);
  assert.match(p, /fix\/12-/);
  assert.match(p, /does not match/);
});

// The matching and ranking rules live only in the Branch prompt (a model applies them with git), so these tests
// pin the rule text; they cannot be exercised without git.
test('T7.4 several matches: the one with an open devflow PR wins and is named in Assumptions', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, T7_LABELS);
  const p = prompt(calls, 'branch');
  assert.match(p, /With several matches take the one with an open devflow PR[^]*, otherwise the origin branch whose newest commit is the most recent/);
});

test('T7.5 several matches without a PR: the remote branch with the newest commit wins', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, T7_LABELS);
  assert.match(prompt(calls, 'branch'), /otherwise the origin branch whose newest commit is the most recent[^]*a branch that exists only locally ranks after every origin one/);
});

test('T7.6 the prefix ends with the hyphen after the issue number', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, T7_LABELS);
  const p = prompt(calls, 'branch');
  assert.match(p, /feat\/123-/);
  assert.match(p, /feat\/12foo/);
  assert.match(p, /hyphen/);
});

test('T7.7 a base conflict on a resumed branch goes to Integrate, which resolves it; no block', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [12] }, { ...T7_LABELS, branch: { branch: 'feat/12-foo', resumed: true, commits: ['abc feat(#12): x'], baseConflict: true, conflictFiles: ['src/x.py'] } });
  assert.equal(rep[0].status, 'pr');
  assert.ok(has(calls, 'integrate'));
  const p = prompt(calls, 'integrate');
  assert.match(p, /git merge --no-edit origin\/main/);
  assert.match(p, /src\/x\.py/);
  assert.match(p, /resolve/i);
  assert.match(prompt(calls, 'branch'), /baseConflict=true/);
});

test('T7.7c stacked on one parent: Integrate re-runs the merge Branch aborted (the parent branch) once, not twice', async () => {
  const parents = [{ branch: 'feat/11-p', prNumber: 50, issue: 11 }];
  const { rep, calls } = await run({ ...BASE, issues: [12] }, { ...T7_LABELS, parents, branch: { branch: 'feat/12-foo', resumed: true, commits: ['abc x'], baseConflict: true, conflictFiles: ['src/x.py'] } });
  assert.equal(rep[0].status, 'pr');
  const p = prompt(calls, 'integrate');
  assert.match(p, /merging origin\/feat\/11-p into it conflicts in/);
  assert.match(p, /git merge --no-edit origin\/feat\/11-p` first/);
  assert.ok(!/git merge --no-edit origin\/main/.test(p));
  assert.match(p, /the only parent was merged in the base merge above, so skip this step/);
});

test('T7.7b no base conflict, no Integrate call', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, { ...T7_LABELS, branch: { resumed: true, commits: ['abc x'] } });
  assert.ok(!has(calls, 'integrate'));
});

test('T7.8 a base conflict in behaviour the issue does not cover blocks with a questions comment', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [12] }, { ...T7_LABELS, branch: { resumed: true, commits: ['abc x'], baseConflict: true, conflictFiles: ['src/x.py'] }, integrateOut: { ok: false, integrationSha: '', merged: [], problem: 'conflict', questions: [Q112] } });
  assert.equal(rep[0].status, 'blocked');
  assert.match(rep[0].reason, /^Integrate/);
  assert.match(prompt(calls, 'blocked'), /devflow-questions/);
  assert.match(prompt(calls, 'integrate'), /does not cover/);
  assert.match(prompt(calls, 'integrate'), /product decision: set productDecision=true/);
});

test('T7.2b a branch matched by name whose commits use no issue scope is continued, not ok=false', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, T7_LABELS);
  const p = prompt(calls, 'branch');
  assert.match(p, /whose own commits do not use scope "#12"[^]*do not return ok=false for it[^]*matchedByName=true/);
});

test('T7.9 a conflict in a high-risk file is still resolved in Integrate (the PR is escalated by the risk step)', async () => {
  const { calls } = await run({ ...BASE, config: { ...CFG, risk: { highPaths: ['hooks/**'] } }, issues: [12] }, { ...T7_LABELS, branch: { resumed: true, commits: ['abc x'], baseConflict: true, conflictFiles: ['hooks/guard.py'] } });
  const p = prompt(calls, 'integrate');
  assert.match(p, /hooks\/guard\.py/);
  assert.match(p, /risk\.highPaths|high-risk/);
  assert.match(p, /still resolve/i);
});

test('T7.10 the Branch, Integrate and Implement prompts say a commit-structure question is not asked and is a suggestion', async () => {
  const { calls } = await run({ ...BASE, issues: [12] }, { ...T7_LABELS, branch: { resumed: true, commits: ['abc x'], baseConflict: true, conflictFiles: ['a'] } });
  for (const l of ['branch', 'integrate', 'implement']) {
    const p = prompt(calls, l);
    assert.match(p, /commit-structure question/, l);
    assert.match(p, /never ask/i, l);
    assert.match(p, /suggestion/, l);
  }
});

const CLAIM_A = { commentId: 1, claimId: 'A', createdAt: '2026-01-01T09:04:00Z' };
const CLAIM_B = { commentId: 2, claimId: 'B', createdAt: '2026-01-01T09:41:00Z' };
const CLAIM_C = { commentId: 3, claimId: 'C', createdAt: '2026-01-01T09:45:00Z' };
const LAST_BLOCKED_AT = '2026-01-01T09:11:00Z';

async function expectClaimWinner(claims, lastBlockedAt, winner, message) {
  // Run as a later claimant so the skipped result names the actual winner.
  const ours = { commentId: 4, claimId: BASE.claimId, createdAt: '2026-01-01T09:50:00Z' };
  const { rep } = await run({ ...BASE, issues: [1] }, {
    claimOut: { claims: [...claims, ours], ...(lastBlockedAt && { lastBlockedAt }) },
  });
  assert.equal(rep[0].reason, `claimed by ${winner.claimId}`, message);
  const { pickClaimWinner } = await helpers();
  assert.equal(typeof pickClaimWinner, 'function', 'pickClaimWinner must be exposed via args.exports');
  assert.deepEqual(pickClaimWinner(claims, lastBlockedAt), winner, message);
}

test('T20.13 a claim before the latest block is ignored', async () => {
  await expectClaimWinner([CLAIM_A, CLAIM_B], LAST_BLOCKED_AT, CLAIM_B,
    'claim B at 09:41 must beat claim A at 09:04 after a block at 09:11');
  await expectClaimWinner([CLAIM_B, CLAIM_A], undefined, CLAIM_A,
    'without a block timestamp, the earliest claim must still win');
});

test('T20.14 the earliest claim after the block wins', async () => {
  await expectClaimWinner([CLAIM_C, CLAIM_A, CLAIM_B], LAST_BLOCKED_AT, CLAIM_B,
    'the earliest post-block claim must win even when it is listed last');
  await expectClaimWinner([CLAIM_C, CLAIM_B], LAST_BLOCKED_AT, CLAIM_B,
    'with only post-block claims, the earlier of B and C must win');
});

test('T20.15 claim release is checked, retried once if needed, and noted if still unreleased', async () => {
  for (const lose of [false, true]) {
    for (const [removeOnAttempt, events] of [
      [1, ['delete', 'check']],
      [2, ['delete', 'check', 'delete', 'check']],
      [Infinity, ['delete', 'check', 'delete', 'check']],
    ]) {
      const seen = [];
      let attempts = 0;
      const cleanup = lose ? 'release' : 'blocked';
      const scenario = `${lose ? 'lost claim' : 'blocked run'}, deletion on attempt ${removeOnAttempt}`;
      const { rep } = await run({ ...BASE, issues: [1] }, {
        lose,
        planBlocked: !lose,
        agentResult(prompt, { label }) {
          if (!seen.length && !label.startsWith(cleanup)) return;
          if (!/devflow-claim|claim comment/i.test(prompt)) return;
          if (/\bdelete\b[^\n.]*\bcomment|\bdelete_issue_comment\b/i.test(prompt)) {
            seen.push('delete');
            attempts++;
            return { ok: true, pushed: false };
          }
          if (/\b(?:re-read|read|list|check|verify|fetch)\b[^\n.]*\bcomments?\b|\blist_issue_comments\b/i.test(prompt)) {
            seen.push('check');
            const claimPresent = attempts < removeOnAttempt;
            return { ok: true, claimPresent, claims: claimPresent
              ? [{ commentId: 11, claimId: BASE.claimId, createdAt: '2026-01-01T00:00:05Z' }]
              : [] };
          }
        },
      });
      assert.equal(rep[0].status, lose ? 'skipped' : 'blocked', scenario);
      assert.equal(rep[0].notes.some((note) => /claim not released/i.test(note)), removeOnAttempt === Infinity,
        `${scenario}: only a claim still present after retry must produce a "claim not released" note`);
      assert.deepEqual(seen, events, `${scenario}: the engine must re-read comments after each delete attempt`);
    }
  }
});
