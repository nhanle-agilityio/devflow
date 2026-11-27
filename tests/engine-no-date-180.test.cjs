'use strict';
// #180: the Workflow runtime forbids Date.now() / new Date(). A run that records a decision must not use the clock:
// the date of a "## Decisions" line comes from args.runDate, else the claimId prefix, else "undated".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'workflows', 'next-task-engine.js'), 'utf8');
const SRC = RAW.replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CFG = {
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
  risk: { highPaths: ['.github/**'] },
  nextTask: { onQuestion: 'decide' },
};
const BASE = { config: CFG, limit: 3, issues: [1], startBranch: 'main', prTemplatePath: '', pluginRoot: '/plugin' };

const BOOLS = ['productDecision', 'reversible', 'changesCriterion', 'dropsMustRow', 'changesContract', 'changesStoredFormat', 'lowersRisk', 'skipsCheck', 'needsDestructiveGit', 'outsideRepo'];
const question = (over = {}) => {
  const q = { text: 'Which name?', tag: 'BA', recommended: 'OPT-A', reason: 'because' };
  for (const b of BOOLS) q[b] = false;
  q.reversible = true;
  return { ...q, ...over };
};

// The runtime's Date: any use throws, like the Workflow sandbox.
const RealDate = Date;
const MSG = 'Date.now() / new Date() are unavailable in workflow scripts (breaks resume).';
function ThrowingDate() { throw new Error(MSG); }
ThrowingDate.now = () => { throw new Error(MSG); };

async function run(args, q) {
  const calls = [];
  let planN = 0;
  const agent = async (prompt, o) => {
    const l = o.label;
    calls.push({ l, prompt });
    const n = Number((/#(\d+)/.exec(l) || [])[1]);
    if (l === 'select issues') return { issues: args.issues.map((i) => ({ number: i, title: 't' + i, labels: ['risk:high'], body: 'spec docs/specs/a.md', dependsOn: [], parents: [] })), skipped: [] };
    if (l.startsWith('claim check')) return { claimPresent: true };
    if (l.startsWith('claim')) return { taken: false, claims: [{ commentId: 10 + n, claimId: String(args.claimId || 'run'), createdAt: '2026-01-01T00:00:05Z', author: 'me' }], labels: ['risk:high'], specPath: '', introducedBy: false };
    if (l.startsWith('branch')) return { ok: true, branch: 'feat/' + n + '-x' };
    if (l.startsWith('plan')) {
      const k = planN++;
      const ready = { status: 'ready', plan: 'PLAN', questions: [], qaFiles: [], devFiles: ['src/x.js'], specRead: 'docs/specs/a.md', acceptanceCriteria: 0, httpOrE2eRows: false };
      return k === 0 ? Object.assign(ready, { status: 'blocked', questions: [q] }) : ready;
    }
    if (l.startsWith('qa')) return { status: 'done', tests: [{ rowId: 'T1.1', test: 't' }], filesChanged: [], questions: [], specRead: 'docs/specs/a.md' };
    if (l.startsWith('commit')) return { ok: true, commits: ['t1 test(#1): x'], failedFirst: true, failureNote: '404' };
    if (l.startsWith('implement') || l.startsWith('fix')) return { status: 'done', summary: 's', commits: ['a b'], filesChanged: ['src/x.js'], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'docs/specs/a.md', questions: [] };
    if (l.startsWith('check')) return { passed: true, failures: [] };
    if (l.startsWith('verify')) return { ran: true, mode: 'http', steps: [], notes: '' };
    if (l.startsWith('scan')) return { scanned: true, hits: [], changedFiles: ['src/x.js'], files: ['src/x.js'] };
    if (l.startsWith('review')) return { issueRead: true, verdict: 'pass', findings: [] };
    if (l.startsWith('ship')) return { ok: true, prNumber: 100 + n, url: 'u' + n };
    if (l.startsWith('blocked')) return { ok: true, pushed: false };
    return { ok: true, files: ['src/x.js'], changedFiles: ['src/x.js'], paths: ['src/x.js'], labeled: true, recorded: true, added: true, released: true };
  };
  const parallel = async (fns) => Promise.all(fns.map((f) => f()));
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  globalThis.Date = ThrowingDate;
  try {
    const rep = await fn(args, agent, () => {}, () => {}, parallel);
    return { rep, calls };
  } finally {
    globalThis.Date = RealDate;
  }
}
const lineIn = (calls, re) => calls.some((c) => c.prompt.split('\n').some((ln) => re.test(ln.trim())));
const shipPrompt = (calls) => (calls.find((c) => c.l.startsWith('ship')) || {}).prompt || '';

// D1
test('D1 a decided question with the runtime Date ships, dated from the claimId prefix', async () => {
  const { rep, calls } = await run({ ...BASE, claimId: '20261126T101500-lane-8-123' }, question());
  assert.equal(rep[0].status, 'pr', `status ${rep[0].status}: ${rep[0].reason || ''}`);
  assert.ok(!calls.some((c) => c.l.startsWith('blocked')), 'no blocked stage');
  assert.ok(lineIn(calls, /^- 2026-11-26 decided by run: Which name\? -> OPT-A \(because\)$/), 'line dated 2026-11-26');
});

// D2
test('D2 a decide-high question with the runtime Date ships with decisions:review and risk:high', async () => {
  const { rep, calls } = await run({ ...BASE, claimId: '20261126T101500-lane-8-123' }, question({ productDecision: true }));
  assert.equal(rep[0].status, 'pr', `status ${rep[0].status}: ${rep[0].reason || ''}`);
  assert.ok(lineIn(calls, /^- 2026-11-26 decided by run: .*\[needs human review\]$/), 'flagged line');
  assert.match(shipPrompt(calls), /decisions:review/);
  assert.match(shipPrompt(calls), /"risk:high"/);
});

// D3
test('D3 args.runDate wins over the claimId prefix', async () => {
  const { rep, calls } = await run({ ...BASE, runDate: '2026-12-01', claimId: '20261126T101500-main-1' }, question());
  assert.equal(rep[0].status, 'pr');
  assert.ok(lineIn(calls, /^- 2026-12-01 decided by run: /), 'line dated from runDate');
});

// D4
test('D4 without runDate or a dated claimId the line says undated and the run continues', async () => {
  const { rep, calls } = await run({ ...BASE, claimId: 'C-me', runDate: 'not-a-date' }, question());
  assert.equal(rep[0].status, 'pr');
  assert.ok(lineIn(calls, /^- undated decided by run: /), 'undated line');
});

// D5
test('D5 the engine source never reads the clock', () => {
  assert.doesNotMatch(RAW, /Date\.now\s*\(/);
  assert.doesNotMatch(RAW, /new\s+Date\s*\(/);
});

// D6
test('D6 /devflow:next-task passes runDate in the workflow args', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'next-task', 'SKILL.md'), 'utf8');
  assert.match(skill, /"runDate":\s*"/);
  assert.match(skill, /date \+%Y-%m-%d/);
});
