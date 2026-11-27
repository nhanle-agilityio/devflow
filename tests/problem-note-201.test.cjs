'use strict';
// #201: a non-empty problem on a successful stage is a note, not a failure (3.4.0 regression).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const SRC = read('workflows/next-task-engine.js').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
const noop = () => {};
const parallel = (tasks) => Promise.all(tasks.map((task) => task()));

function ThrowingDate() { throw new Error('Workflow scripts cannot read the clock'); }
ThrowingDate.now = ThrowingDate;

async function runEngine(args, agent) {
  const realDate = globalThis.Date;
  globalThis.Date = ThrowingDate;
  try {
    return await engine(args, agent, noop, noop, parallel);
  } finally {
    globalThis.Date = realDate;
  }
}

const qaFile = 'tests/a.test.js';
const devFile = 'src/x.js';
const spec = 'docs/specs/a.md';
const httpBody = '## Test cases\n\n| ID | Level | Case |\n| --- | --- | --- |\n| T1 | http | GET /health returns 200 |';
const claimId = '20261127T120000-lane-7-198';

async function runIssue({ body = '', labels = ['risk:high'], config = {}, replies = {} } = {}) {
  const args = {
    config: {
      github: { owner: 'o', repo: 'r' }, baseBranch: 'main',
      checks: [{ name: 'test', run: 'make test' }], ...config,
    },
    issues: [7], limit: 1, startBranch: '', isolated: true, claimId, runDate: '2026-11-27', pluginRoot: '/plugin',
  };
  const specRead = body.includes(spec) ? spec : 'none';
  const implemented = {
    status: 'done', summary: 'Added health check', commits: [], filesChanged: [devFile],
    assumptions: [], outOfScope: [], touchesUi: false, questions: [], specRead,
  };
  const defaults = {
    'select issues': { issues: [{ number: 7, title: 'Health check', body, labels, parents: [], dependsOn: [] }], skipped: [] },
    claim: {
      taken: false, assignedByRun: false, labels, specPath: '', retryCount: 0,
      claims: [{ claimId, commentId: 1, createdAt: '2026-11-27T12:00:00Z' }],
    },
    'claim check': { claimPresent: true },
    branch: { ok: true, branch: 'feat/7-health' },
    plan: { status: 'ready', plan: 'Add health check', questions: [], qaFiles: [], devFiles: [devFile],
      specRead, acceptanceCriteria: 0, httpOrE2eRows: body.includes('| http |') },
    qa: { status: 'done', tests: [{ rowId: 'T1', test: 'health' }], filesChanged: [qaFile], questions: [], specRead },
    implement: implemented,
    fix: implemented,
    'qa-fix': { ...implemented, filesChanged: [qaFile] },
    commit: { ok: true, commits: ['abc test(#7): health', 'def feat(#7): health'], redConfirmed: true },
    check: { passed: true, failures: [] },
    verify: { ran: true, mode: 'http', steps: [], notes: '' },
    'changed-files': { ok: true, files: [devFile] },
    scan: { scanned: true, hits: [], changedFiles: [devFile] },
    review: { issueRead: true, verdict: 'pass', findings: [] },
    ship: { ok: true, prNumber: 17, url: 'pr/17' },
    decisions: { ok: true },
    blocked: { ok: true, pushed: false },
    'release check': { claimPresent: false },
    'release retry': { ok: true },
    release: { ok: true },
    integrate: { ok: true, integrationSha: 'abcd123', merged: [] },
    'run error': { ok: true },
  };
  const calls = [];
  const unexpected = [];
  const agent = async (prompt, o) => {
    const label = o.label;
    calls.push({ label, prompt });
    const stage = label.split(' #')[0];
    if (Object.hasOwn(defaults, stage)) {
      if (replies[stage] === null) return null;
      return { ...defaults[stage], ...replies[stage] };
    }
    if (label.startsWith('retreat') || label.startsWith('restore') || /bug/i.test(label)
        || /<!-- devflow-(?:run-error #7|retry count=0) -->/.test(prompt)) return { ok: true };
    // The engine catches agent exceptions. Surface unknown labels separately from policy failures.
    unexpected.push(label);
    return null;
  };
  const report = await runEngine(args, agent);
  assert.deepEqual(unexpected, [], 'unexpected agent labels');
  assert.deepEqual(report.map((entry) => entry.issue), [7]);
  return { entry: report[0], calls };
}

const stageCalls = (run, prefix) => run.calls.filter(({ label }) => label.startsWith(prefix));
function promptFor(run, prefix) {
  const [call] = stageCalls(run, prefix);
  assert.ok(call, 'expected a ' + prefix + ' call: ' + (run.entry.reason || run.entry.status));
  return call.prompt;
}
function noBlock(run) {
  assert.ok(!stageCalls(run, 'blocked').length, 'unexpected block: ' + run.entry.reason);
}
function assertRunErrorBug(run) {
  const bugs = run.calls.filter(({ label, prompt }) => /bug/i.test(label) || prompt.includes('<!-- devflow-run-error #7 -->'));
  assert.equal(bugs.length, 1, 'expected one run-error bug call');
}
function jsonPayload(prompt, marker) {
  const start = "<<'" + marker + "'\n";
  assert.ok(prompt.includes(start), 'missing ' + marker + ' payload');
  return JSON.parse(prompt.split(start)[1].split('\n' + marker)[0]);
}


const NOTE = 'Note from the agent: everything went fine, see the summary.';
function shippedWithoutRetreat(run) {
  assert.equal(run.entry.status, 'pr', run.entry.reason);
  assert.ok(!stageCalls(run, 'retreat').length, 'unexpected retreat: ' + run.entry.reason);
  noBlock(run);
}

// N1
test('N1 a claim with our claim and a narrative problem ships', async () => {
  const run = await runIssue({ replies: { claim: { problem: 'Issue #7 was not taken. Claimed it and posted the claim comment.' } } });
  shippedWithoutRetreat(run);
});

// N2
for (const stage of ['branch', 'plan', 'qa', 'implement', 'commit', 'review', 'ship']) {
  test(`N2 a successful ${stage} with a note in problem ships`, async () => {
    // A QA file in the plan makes the parallel QA, dev and commit stages run.
    const run = await runIssue({ replies: { plan: { qaFiles: [qaFile] }, [stage]: { problem: NOTE } } });
    assert.ok(stageCalls(run, stage).length, `the ${stage} stage ran`);
    shippedWithoutRetreat(run);
  });
}

// N3
test('N3 a GitHub outage reported in problem still stops the run', async () => {
  const run = await runIssue({ replies: { plan: { problem: 'GitHub MCP unavailable: tools missing' } } });
  assert.notEqual(run.entry.status, 'pr');
  assert.ok(!stageCalls(run, 'retreat').length, 'an outage is not retreated');
  assert.ok(!stageCalls(run, 'ship').length);
});

// N4
test('N4 a branch that really failed still retreats', async () => {
  const run = await runIssue({ replies: { branch: { ok: false, branch: '', error: 'could not create the branch' } } });
  assert.equal(run.entry.status, 'skipped');
  assert.match(run.entry.reason, /^retry: Branch/);
});

// N5
test('N5 the ship summary comes from the latest fix, not the stale implementation summary', async () => {
  let checks = 0;
  const replies = {
    implement: { summary: 'S1-stale summary' },
    fix: { summary: 'S2-fixed summary' },
    // The harness reads replies[stage] twice per call (null check, then spread).
    get check() { return checks++ < 2 ? { passed: false, failures: [{ check: 'test', output: 'boom' }] } : { passed: true, failures: [] }; },
  };
  const run = await runIssue({ replies });
  assert.equal(run.entry.status, 'pr', run.entry.reason);
  const ship = promptFor(run, 'ship');
  assert.ok(ship.includes('S2-fixed summary'), 'ship uses the fix summary');
  assert.ok(!ship.includes('S1-stale summary'), 'ship drops the stale summary');
});
