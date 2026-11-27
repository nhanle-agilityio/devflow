'use strict';
// #105 T4 review fixes: decided options reach later agents as answers; decisions:review on a new PR. Same harness as engine-decide.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'next-task-engine.js'), 'utf8').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CFG = {
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
  risk: { highPaths: ['.github/**'] },
};
const BASE = { config: CFG, limit: 3, startBranch: 'main', prTemplatePath: '', claimId: 'C-me', runDate: '2026-11-18', pluginRoot: '/plugin' };
const withNt = (nt, extra = {}) => ({ ...BASE, config: { ...CFG, nextTask: nt }, issues: [1], ...extra });

const BOOLS = ['productDecision', 'reversible', 'changesCriterion', 'dropsMustRow', 'changesContract', 'changesStoredFormat', 'lowersRisk', 'skipsCheck', 'needsDestructiveGit', 'outsideRepo'];
const OTHER_BOOLS = BOOLS.filter((b) => b !== 'reversible');
const clear = (over = {}) => {
  const q = { text: 'Which name?', tag: 'BA', recommended: 'A', reason: 'r' };
  for (const b of BOOLS) q[b] = false;
  q.reversible = true;
  return { ...q, ...over };
};
const without = (q, k) => { const c = { ...q }; delete c[k]; return c; };

async function helpers() {
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  return fn({ exports: true }, null, () => {}, () => {}, null);
}
const OPTS = { onQuestion: 'decide', changedFiles: ['src/a.js'], highPaths: ['.github/**'] };
const norm = (r) => (r && typeof r === 'object' ? r.decision || r.result || r.verdict || r.kind : r);
async function classify(q, o = {}) {
  const h = await helpers();
  assert.equal(typeof h.classifyQuestion, 'function', 'the engine exports classifyQuestion');
  return norm(h.classifyQuestion(q, { ...OPTS, ...o }));
}

// ---- engine run with stub agents --------------------------------------------------------------
const RealDate = Date;
const NOW = '2026-11-18T12:00:00Z';
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return new RealDate(NOW).getTime(); }
}

// opts: plans (array of plan overrides, one per plan call), review (fn), body, changed (files of the branch's full diff),
// qaFiles, devFiles, parents, checkFirstFails, onCall.
async function run(args, opts = {}) {
  const calls = [];
  let planN = 0;
  const changed = opts.changed || ['src/x.js'];
  const agent = async (prompt, o) => {
    const l = o.label;
    calls.push({ l, prompt, schema: o.schema });
    const n = Number((/#(\d+)/.exec(l) || [])[1]);
    if (l === 'select issues') {
      return {
        issues: (args.issues || []).map((i) => ({ number: i, title: 't' + i, labels: opts.labels || ['risk:high'], body: opts.body !== undefined ? opts.body : 'spec docs/specs/a.md', dependsOn: [], parents: opts.parents ? opts.parents() : [] })),
        skipped: [],
      };
    }
    if (l.startsWith('claim check')) return { claimPresent: true };
    if (l.startsWith('claim')) return { taken: false, claims: [{ commentId: 10 + n, claimId: args.claimId, createdAt: '2026-01-01T00:00:05Z' }], labels: opts.labels || ['risk:high'], specPath: '', introducedBy: false };
    if (l.startsWith('release')) return { ok: true };
    if (l.startsWith('integrate')) return { ok: true, integrationSha: 'abc1234def', merged: ['a', 'b'] };
    if (l.startsWith('branch')) return { ok: true, branch: 'feat/' + n + '-x' };
    if (l.startsWith('plan')) {
      const k = planN++;
      const ready = { status: 'ready', plan: 'PLAN' + n, questions: [], qaFiles: opts.qaFiles || [], devFiles: opts.devFiles || ['src/x.js'], specRead: 'docs/specs/a.md', acceptanceCriteria: 0, httpOrE2eRows: false };
      return Object.assign(ready, (opts.plans && opts.plans[k]) || {});
    }
    if (l.startsWith('qa-fix')) return { status: 'done', summary: 'qf', commits: [], filesChanged: [], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'none', questions: [] };
    if (l.startsWith('qa')) return { status: 'done', tests: [{ rowId: 'T1.1', test: 't' }], filesChanged: opts.qaFiles || [], questions: [], specRead: 'docs/specs/a.md' };
    if (l.startsWith('commit')) return { ok: true, commits: ['t1 test(#1): x'], failedFirst: true, failureNote: '404' };
    if (l.startsWith('implement') || l.startsWith('fix')) return { status: 'done', summary: 's', commits: ['a b'], filesChanged: ['src/x.js'], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'docs/specs/a.md', questions: [] };
    if (l.startsWith('check')) {
      const c = calls.filter((x) => x.l.startsWith('check')).length;
      if (opts.checkFirstFails && c === 1) return { passed: false, failures: [{ check: 'test', output: 'boom' }] };
      return { passed: true, failures: [] };
    }
    if (l.startsWith('verify')) return { ran: true, mode: 'http', steps: [], notes: '' };
    if (l.startsWith('scan')) return { scanned: true, hits: [], changedFiles: changed, files: changed };
    if (l.startsWith('review')) {
      const k = calls.filter((x) => x.l.startsWith('review')).length - 1;
      const r = opts.review ? opts.review(k) : null;
      return Object.assign({ issueRead: true }, r ? JSON.parse(JSON.stringify(r)) : { verdict: 'pass', findings: [] });
    }
    if (l.startsWith('ship')) return { ok: true, prNumber: 100 + n, url: 'u' + n };
    if (l.startsWith('blocked')) return { ok: true, pushed: false };
    if (l.startsWith('restore')) return { ok: true };
    // Any other agent (for example one that lists the branch's changed files or records a decision).
    return { ok: true, files: changed, changedFiles: changed, paths: changed, labeled: true, recorded: true, added: true };
  };
  const parallel = async (fns) => Promise.all(fns.map((f) => f()));
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  globalThis.Date = FixedDate;
  try {
    const rep = await fn(args, agent, () => {}, () => {}, parallel);
    return { rep, calls };
  } finally {
    globalThis.Date = RealDate;
  }
}
const labelOf = (c) => c.l.split(' ')[0];
const count = (calls, label) => calls.filter((c) => labelOf(c) === label).length;
const prompt = (calls, label) => (calls.find((c) => labelOf(c) === label) || {}).prompt || '';
const occurrences = (calls, text) => calls.reduce((n, c) => n + c.prompt.split(text).length - 1, 0);
const planWith = (questions, status = 'blocked') => ({ status, questions });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- T4.1, T4.2, T4.32: the stage schemas ----------------------------------------------------
const STAGES = ['plan', 'qa', 'implement', 'fix', 'qa-fix', 'review', 'branch', 'integrate'];

const D1 = clear({ text: 'Which name?', recommended: 'OPT-ALPHA', reason: 'because one' });
const D2 = clear({ text: 'Which colour?', recommended: 'OPT-BETA', reason: 'because two', tag: 'QA' });
const LINE1 = '- 2026-11-18 decided by run: Which name? -> OPT-ALPHA (because one)';
const LINE2 = '- 2026-11-18 decided by run: Which colour? -> OPT-BETA (because two)';
const ANS = /Answers \(/;

test('re-run plan and the following implement prompt carry an Answers section with both options', async () => {
  const { rep, calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith([D1, D2])] });
  assert.equal(rep[0].status, 'pr');
  const plans = calls.filter((c) => labelOf(c) === 'plan');
  assert.equal(plans.length, 2);
  assert.match(plans[1].prompt, ANS);
  assert.match(plans[1].prompt, /OPT-ALPHA/);
  assert.match(plans[1].prompt, /OPT-BETA/);
  const impl = calls.find((c) => labelOf(c) === 'implement');
  assert.match(impl.prompt, ANS);
  assert.match(impl.prompt, /OPT-ALPHA/);
  assert.match(impl.prompt, /OPT-BETA/);
});

test('answers reach agents when the issue body already holds the decision lines', async () => {
  const body = `spec docs/specs/a.md\n## Decisions\n${LINE1}\n${LINE2}\n`;
  const { rep, calls } = await run(withNt({ onQuestion: 'decide' }), { body, plans: [planWith([D1, D2])] });
  assert.equal(rep[0].status, 'pr');
  const plans = calls.filter((c) => labelOf(c) === 'plan');
  assert.match(plans[1].prompt, ANS);
  assert.match(plans[1].prompt, /OPT-BETA/);
  assert.match(calls.find((c) => labelOf(c) === 'implement').prompt, /OPT-ALPHA/);
});

test('a new PR gets decisions:review when the decision lines were already on the issue', async () => {
  const body = `spec docs/specs/a.md\n## Decisions\n${LINE1}\n${LINE2}\n`;
  const { calls } = await run(withNt({ onQuestion: 'decide' }), { body, plans: [planWith([D1, D2])] });
  assert.match(prompt(calls, 'ship'), /decisions:review/);
});

test('no decision, no decisions:review', async () => {
  const { calls } = await run(withNt({ onQuestion: 'decide' }), {});
  assert.doesNotMatch(prompt(calls, 'ship'), /decisions:review/);
});
