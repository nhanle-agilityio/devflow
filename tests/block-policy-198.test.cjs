'use strict';
// #198 contract
// P1 Each block('…') or block(stage…) call has a same-line // block: <category> annotation.
// Categories: owner-question, config-block, check-failed, verify-failed, budget, mcp-down,
// retries-exhausted, missing-requirement. Report the line numbers of violations.
// P2 {exports:true} exposes normalizeOutput. Trim strings deeply, unwrap one pair of double
// quotes and unescape inner quotes. A claim specPath of '""' means no spec and reaches Implement.
// P3 Plan specRead 'none' for docs/specs/a.md proceeds with a spec note and decisions:review.
// P4 QA keeps tests/a.test.js on overlap. Dev gets only src/x.js and the run proceeds.
// P5 Commit QA's extra src/extra.js in devFiles and ship with decisions:review.
// P6 Two empty Plan replies retreat with park --issue, devflow-claim-released, agent:ready,
// and <!-- devflow-retry count=1 -->. Report skipped with a reason starting with retry: Plan.
// P7 At retryCount 2, an empty Plan blocks with retries-exhausted and files a run-error bug.
// P8 Unresolved critical findings ship with "risk:high", decisions:review and Open review findings.
// P9 Two failing HTTP verification results block for verify-failed and file a run-error bug.
// P10 Two empty Ship replies retreat and report skipped with a reason starting with retry: Ship.
// P11 Successful Ship after retryCount 1 resets the marker to <!-- devflow-retry count=0 -->.
// P12 A skipped retry: entry's Next is "nothing (autopilot retries)".

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

test('P1 every block call names an allowed category', () => {
  const allowed = new Set(['owner-question', 'config-block', 'check-failed', 'verify-failed', 'budget',
    'mcp-down', 'retries-exhausted', 'missing-requirement']);
  const invalid = [];
  SRC.split('\n').forEach((line, i) => {
    // Any call of block( (whatever its first argument), except the definition itself.
    if (!/(?<![\w.$])block\(/.test(line.replace(/(?:async\s+)?function\s+block\(/, ''))) return;
    const annotation = /\/\/ block: (\S+)/.exec(line);
    if (!annotation || !allowed.has(annotation[1])) invalid.push(i + 1);
  });
  assert.ok(!invalid.length, 'missing or unknown block category on lines ' + invalid.join(', '));
});

test('P2 normalizeOutput unwraps one pair of quotes deeply', async () => {
  const { normalizeOutput } = await runEngine({ exports: true }, null);
  assert.equal(typeof normalizeOutput, 'function', 'normalizeOutput is missing from the exports hook');
  assert.deepEqual(normalizeOutput({ a: '"x"', b: [' "y" '], c: { d: '"\\"q\\""' }, e: 'plain', f: 3 }),
    { a: 'x', b: ['y'], c: { d: '"q"' }, e: 'plain', f: 3 });
});

test('P2 a quoted empty claim spec reaches Implement', async () => {
  const run = await runIssue({ replies: { claim: { specPath: '""' } } });
  noBlock(run);
  assert.doesNotMatch(promptFor(run, 'plan'), /git show [^\n`]*:""/);
  promptFor(run, 'implement');
});

test('P3 an unread Plan spec ships with a decision note', async () => {
  const run = await runIssue({ body: '[Spec](' + spec + ')', replies: { plan: { specRead: 'none' } } });
  noBlock(run);
  const ship = promptFor(run, 'ship');
  assert.match(ship, /decisions:review/);
  const decisions = jsonPayload(ship, 'DEVFLOW_PR_JSON').decisions.join('\n');
  assert.ok(decisions.includes(spec) || /\bspec\b/i.test(decisions), 'missing decision note about the unread spec');
});

test('P4 overlapping files stay with QA', async () => {
  const run = await runIssue({ replies: { plan: { qaFiles: [qaFile], devFiles: [qaFile, devFile] } } });
  noBlock(run);
  const impl = promptFor(run, 'implement');
  const dev = /files the plan gives to dev:\s*(\[[^\]]*\])/.exec(impl);
  assert.ok(dev, 'missing dev files JSON');
  assert.deepEqual(JSON.parse(dev[1]), [devFile]);
  assert.ok(promptFor(run, 'qa').includes(qaFile), 'QA keeps the overlapping test');
});

test('P5 a file changed outside QA ownership joins the code commit', async () => {
  const extra = 'src/extra.js';
  const run = await runIssue({ replies: { plan: { qaFiles: [qaFile] }, qa: { filesChanged: [qaFile, extra] } } });
  noBlock(run);
  const payload = jsonPayload(promptFor(run, 'commit'), 'DEVFLOW_COMMIT_JSON');
  assert.ok(payload.devFiles.includes(extra), 'devFiles must include ' + extra);
  assert.ok(!payload.qaFiles.includes(extra), 'extra file belongs only in the code commit');
  assert.match(promptFor(run, 'ship'), /decisions:review/);
});

test('P6 an empty Plan retreats for an autopilot retry', async () => {
  const run = await runIssue({ replies: { plan: null } });
  assert.equal(stageCalls(run, 'plan').length, 2);
  noBlock(run);
  const retreat = promptFor(run, 'retreat');
  for (const token of ['park --issue', 'devflow-claim-released', 'agent:ready', '<!-- devflow-retry count=1 -->']) {
    assert.ok(retreat.includes(token), 'missing from retreat prompt: ' + token);
  }
  assert.equal(run.entry.status, 'skipped');
  assert.match(run.entry.reason, /^retry: Plan\b/);
});

test('P7 a third transient failure blocks and files a run-error bug', async () => {
  const run = await runIssue({ replies: { claim: { retryCount: 2 }, plan: null } });
  assert.equal(stageCalls(run, 'plan').length, 2);
  assert.equal(run.entry.status, 'blocked');
  assert.ok(promptFor(run, 'blocked').includes('retries-exhausted'), 'block reason must mention retries-exhausted');
  assertRunErrorBug(run);
});

test('P8 open critical review findings ship for human review', async () => {
  const finding = { severity: 'critical', file: devFile, line: 4, problem: 'Empty input returns 500', fix: 'Handle empty input' };
  const run = await runIssue({
    labels: ['risk:low'], body: httpBody, config: { nextTask: { maxReviewRounds: 1 } },
    replies: { review: { verdict: 'changes', findings: [finding] } },
  });
  assert.equal(stageCalls(run, 'review').length, 2);
  assert.equal(stageCalls(run, 'fix').length, 1);
  noBlock(run);
  const ship = promptFor(run, 'ship');
  const prLabels = ship.split('\n').find((line) => line.includes('Label the new PR'));
  assert.match(prLabels, /"risk:high"/);
  assert.match(prLabels, /decisions:review/);
  assert.match(ship, /Open review findings/);
  assert.ok(ship.includes(finding.problem), 'ship the open finding itself');
});

test('P9 repeated HTTP verification failure blocks and files a run-error bug', async () => {
  const step = { action: 'GET /health', expected: '200', actual: '503', pass: false };
  const run = await runIssue({
    body: httpBody, config: { verify: { modes: ['http'], devServer: { run: 'make run', url: 'http://localhost:5050' } } },
    replies: { verify: { steps: [step] } },
  });
  assert.equal(stageCalls(run, 'verify').length, 2);
  assert.equal(run.entry.status, 'blocked');
  assert.match(promptFor(run, 'blocked'), /verify-failed|verification still failing/i);
  assertRunErrorBug(run);
});

test('P10 an empty Ship retreats for an autopilot retry', async () => {
  const run = await runIssue({ replies: { ship: null } });
  assert.equal(stageCalls(run, 'ship').length, 2);
  noBlock(run);
  promptFor(run, 'retreat');
  assert.equal(run.entry.status, 'skipped');
  assert.match(run.entry.reason, /^retry: Ship\b/);
});

test('P11 successful Ship resets the retry marker', async () => {
  const run = await runIssue({ replies: { claim: { retryCount: 1 } } });
  assert.equal(run.entry.status, 'pr', run.entry.reason);
  const shipIndex = run.calls.findIndex(({ label }) => label.startsWith('ship'));
  assert.ok(shipIndex >= 0);
  assert.ok(run.calls.slice(shipIndex).some(({ prompt }) => prompt.includes('<!-- devflow-retry count=0 -->')),
    'missing count=0 marker at or after Ship');
});

test('P12 the report maps a retry skip to nothing (autopilot retries)', () => {
  const report = read('skills/next-task/SKILL.md').split('## 4. Report')[1].split('\n## ')[0];
  const mapping = report.split(/\n\s*\n/).find((paragraph) => paragraph.includes('nothing (autopilot retries)'));
  assert.ok(mapping, 'missing Next text "nothing (autopilot retries)" in the report');
  assert.match(mapping, /skipped/i);
  assert.match(mapping, /retry:/);
});
