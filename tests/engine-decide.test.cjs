'use strict';
// #105 T4: decide-or-block classification of questions. Black box against workflows/next-task-engine.js:
// `classifyQuestion` through the test export hook, everything else through engine runs with stub agents.
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
let captured;
async function capture() {
  if (captured) return captured;
  const qaFiles = ['tests/a.test.cjs'];
  const once = () => { let k = 0; return () => (k++ === 0 ? { verdict: 'changes', findings: [{ severity: 'warning', file: 'tests/a.test.cjs', line: 1, problem: 'p', fix: 'f' }] } : { verdict: 'pass', findings: [] }); };
  const { calls } = await run(
    { ...BASE, issues: [1] },
    { qaFiles, labels: ['risk:high'], checkFirstFails: true, review: once(), parents: () => [{ issue: 8, prNumber: 80, branch: 'feat/8-p', inRun: false }, { issue: 9, prNumber: 90, branch: 'feat/9-p', inRun: false }] },
  );
  captured = {};
  for (const s of STAGES) {
    const c = calls.find((x) => labelOf(x) === s);
    assert.ok(c, `the stage ${s} was called`);
    captured[s] = c;
  }
  return captured;
}
const questionItem = (schema) => schema && schema.properties && schema.properties.questions && schema.properties.questions.items;
function schemaProblems(schema) {
  const item = questionItem(schema);
  if (!item || typeof item !== 'object') return ['no questions item schema'];
  const out = [];
  const req = item.required || [];
  for (const k of ['text', 'tag', 'recommended', 'reason', ...BOOLS]) if (!req.includes(k)) out.push(`required lacks ${k}`);
  for (const b of BOOLS) if (!item.properties || !item.properties[b] || item.properties[b].type !== 'boolean') out.push(`${b} is not a boolean property`);
  return out;
}

// T4.1
test('T4.1 every stage schema that returns questions requires text, recommended, reason and the 10 booleans', async () => {
  const cap = await capture();
  for (const s of STAGES) assert.deepEqual(schemaProblems(cap[s].schema), [], s);
});

// T4.2
test('T4.2 a stage schema missing outsideRepo from required fails the schema check', async () => {
  const cap = await capture();
  for (const s of STAGES) {
    const copy = JSON.parse(JSON.stringify(cap[s].schema));
    const item = questionItem(copy);
    item.required = item.required.filter((k) => k !== 'outsideRepo');
    assert.ok(schemaProblems(copy).some((p) => /outsideRepo/.test(p)), s);
  }
});

// T4.32
test('T4.32 the question tag is required with the enum BA, QA, Dev in every stage schema', async () => {
  const cap = await capture();
  for (const s of STAGES) {
    const item = questionItem(cap[s].schema);
    assert.ok(item, s);
    assert.ok((item.required || []).includes('tag'), `${s}: tag required`);
    assert.deepEqual([...item.properties.tag.enum].sort(), ['BA', 'Dev', 'QA'], s);
  }
});

// ---- T4.3-T4.12, T4.24: classifyQuestion --------------------------------------------------------
// T4.3
test('T4.3 an all-clear question decides', async () => {
  assert.equal(await classify(clear()), 'decide');
});

// T4.4
test('T4.4 each flag alone requires human review or blocks', async () => {
  const stops = ['skipsCheck', 'dropsMustRow', 'needsDestructiveGit', 'outsideRepo'];
  for (const b of OTHER_BOOLS) assert.equal(await classify(clear({ [b]: true })), stops.includes(b) ? 'block' : 'decide-high', b);
});

// T4.5
test('T4.5 reversible false blocks', async () => {
  assert.equal(await classify(clear({ reversible: false })), 'block');
});

// T4.6
test('T4.6 a changed file matching risk.highPaths requires human review', async () => {
  assert.equal(await classify(clear(), { changedFiles: ['.github/workflows/x.yml'] }), 'decide-high');
});

// T4.7
test('T4.7 one high-path match among 50 changed files requires human review', async () => {
  const files = Array.from({ length: 50 }, (_, i) => `src/f${i}.js`);
  files[37] = '.github/workflows/x.yml';
  assert.equal(await classify(clear(), { changedFiles: files }), 'decide-high');
  assert.equal(await classify(clear(), { changedFiles: files.map((f, i) => (i === 37 ? 'src/f37.js' : f)) }), 'decide');
});

// T4.8
test('T4.8 a boolean field that is absent, "false", null or 0 blocks', async () => {
  for (const b of BOOLS) {
    assert.equal(await classify(without(clear(), b)), 'block', `${b} absent`);
    for (const bad of ['false', null, 0]) assert.equal(await classify(clear({ [b]: bad })), 'block', `${b}=${JSON.stringify(bad)}`);
  }
});

// T4.9
test('T4.9 an empty, whitespace-only or missing recommended blocks', async () => {
  assert.equal(await classify(clear({ recommended: '' })), 'block');
  assert.equal(await classify(clear({ recommended: '   ' })), 'block');
  assert.equal(await classify(without(clear(), 'recommended')), 'block');
});

// T4.10
test('T4.10 an empty or whitespace-only reason blocks', async () => {
  assert.equal(await classify(clear({ reason: '' })), 'block');
  assert.equal(await classify(clear({ reason: '  \t ' })), 'block');
});

// T4.11
test('T4.11 unavailable changedFiles block', async () => {
  assert.equal(await classify(clear(), { changedFiles: undefined }), 'block');
  assert.equal(await classify(clear(), { changedFiles: null }), 'block');
});

// T4.12
test('T4.12 an empty changedFiles array decides', async () => {
  assert.equal(await classify(clear(), { changedFiles: [] }), 'decide');
});

// T4.24
test('T4.24 onQuestion block blocks an all-clear question', async () => {
  assert.equal(await classify(clear(), { onQuestion: 'block' }), 'block');
});

// ---- T4.13: changedFiles is the full branch diff ----------------------------------------------------
// T4.13
test('T4.13 changedFiles holds an earlier commit\'s high-path file, so the decision requires human review', async () => {
  const q = clear({ text: 'Which colour?', recommended: 'OPT-RED' });
  const full = ['.github/workflows/ci.yml', 'src/x.js'];
  const { rep, calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith([q])], changed: full });
  assert.equal(rep[0].status, 'pr');
  assert.match(prompt(calls, 'ship'), /"risk:high"/);
  assert.match(prompt(calls, 'decisions'), /decided by run: .*needs human review/);
  const ctl = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith([q])], changed: ['src/x.js'] });
  assert.equal(ctl.rep[0].status, 'pr');
});

// ---- decide path ------------------------------------------------------------------------------------------
const D1 = clear({ text: 'Which name?', recommended: 'OPT-ALPHA', reason: 'because one' });
const D2 = clear({ text: 'Which colour?', recommended: 'OPT-BETA', reason: 'because two', tag: 'QA' });
const LINE1 = '- 2026-11-18 decided by run: Which name? -> OPT-ALPHA (because one)';
const LINE2 = '- 2026-11-18 decided by run: Which colour? -> OPT-BETA (because two)';

// T4.14
test('T4.14 two decide questions: the next agent gets both options, two Decisions lines, the PR lists both and gets decisions:review', async () => {
  const { rep, calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith([D1, D2])] });
  assert.equal(rep[0].status, 'pr');
  assert.ok(!calls.some((c) => labelOf(c) === 'blocked'));
  const i = calls.findIndex((c) => labelOf(c) === 'plan');
  const next = calls[i + 1];
  assert.ok(next, 'a call follows the plan');
  assert.match(next.prompt, /OPT-ALPHA/);
  assert.match(next.prompt, /OPT-BETA/);
  assert.ok(occurrences(calls, LINE1) >= 1, 'line 1 is written');
  assert.ok(occurrences(calls, LINE2) >= 1, 'line 2 is written');
  const ship = prompt(calls, 'ship');
  assert.match(ship, /Decisions taken/);
  assert.match(ship, /OPT-ALPHA/);
  assert.match(ship, /OPT-BETA/);
  assert.match(ship, /decisions:review/);
});

// T4.15
test('T4.15 a decision line is exactly "- <date> decided by run: <question> -> <option> (<reason>)"', async () => {
  const { calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith([clear({ text: 'Q', recommended: 'O', reason: 'R' })])] });
  assert.ok(calls.some((c) => c.prompt.split('\n').some((ln) => ln.trim() === '- 2026-11-18 decided by run: Q -> O (R)')), 'the exact line is in a prompt');
});

// T4.16
test('T4.16 a missing ## Decisions section is created and holds the line', async () => {
  const { calls } = await run(withNt({ onQuestion: 'decide' }), { body: 'spec docs/specs/a.md\n## Context\nnothing', plans: [planWith([D1])] });
  const rec = calls.filter((c) => c.prompt.includes(LINE1) && /## Decisions/.test(c.prompt));
  assert.ok(rec.length >= 1, 'a prompt asks for the ## Decisions section with the line');
  assert.ok(rec.some((c) => /creat/i.test(c.prompt)), 'it says to create the section when missing');
});

// T4.17
test('T4.17 one blocking question blocks all three in one comment with Recommended lines and records no decision', async () => {
  const qs = [
    clear({ text: 'First one?', recommended: 'OPT-ONE', reason: 'why one' }),
    clear({ text: 'Second one?', recommended: 'OPT-TWO', reason: 'why two', needsDestructiveGit: true }),
    clear({ text: 'Third one?', recommended: 'OPT-THREE', reason: 'why three' }),
  ];
  const { rep, calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith(qs)] });
  assert.equal(rep[0].status, 'blocked');
  assert.equal(count(calls, 'blocked'), 1);
  const b = prompt(calls, 'blocked');
  assert.match(b, /<!-- devflow-questions -->/);
  for (const [t, o, r] of [['First one?', 'OPT-ONE', 'why one'], ['Second one?', 'OPT-TWO', 'why two'], ['Third one?', 'OPT-THREE', 'why three']]) {
    assert.ok(b.includes(t), t);
    assert.ok(b.includes(`Recommended: ${o} (${r})`), `Recommended line for ${t}`);
  }
  assert.ok(!calls.some((c) => /decided by run/.test(c.prompt)), 'no decision recorded');
  assert.ok(!calls.some((c) => labelOf(c) === 'implement'));
});

// ---- T4.18-T4.20: leftover findings after maxReviewRounds ---------------------------------------------
const finding = (severity, over = {}) => ({
  severity, file: 'src/x.js', line: 1, problem: 'LEFTOVER-PROBLEM', fix: 'fix it',
  recommended: 'ship as is', reason: 'minor', ...Object.fromEntries(BOOLS.map((b) => [b, false])), reversible: true, ...over,
});
const always = (f) => () => ({ verdict: 'changes', findings: [f] });

// T4.18
test('T4.18 a leftover warning with decide ships, listed in Decisions taken, with decisions:review', async () => {
  const { rep, calls } = await run(withNt({ onQuestion: 'decide', maxReviewRounds: 1 }), { review: always(finding('warning')) });
  assert.equal(rep[0].status, 'pr');
  const ship = prompt(calls, 'ship');
  assert.match(ship, /LEFTOVER-PROBLEM/);
  assert.match(ship, /Decisions taken/);
  assert.match(ship, /decisions:review/);
});

// T4.19
test('T4.19 a leftover warning with a changed high-path file ships for human review', async () => {
  const { rep, calls } = await run(withNt({ onQuestion: 'decide', maxReviewRounds: 1 }), { review: always(finding('warning')), changed: ['.github/workflows/x.yml', 'src/x.js'] });
  assert.equal(rep[0].status, 'pr');
  assert.match(prompt(calls, 'ship'), /needs human review/);
});

// T4.20
test('T4.20 a leftover critical finding ships for human review', async () => {
  const { rep, calls } = await run(withNt({ onQuestion: 'decide', maxReviewRounds: 1 }), { review: always(finding('critical')) });
  assert.equal(rep[0].status, 'pr');
  assert.equal(rep[0].risk, 'high');
  assert.match(prompt(calls, 'ship'), /LEFTOVER-PROBLEM/);
});

// ---- T4.21-T4.23: decision text, resume, label ----------------------------------------------------------------
// T4.21
test('T4.21 newlines in a decision\'s question and option become spaces', async () => {
  const { calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith([clear({ text: 'a\nb', recommended: 'c\r\nd', reason: 'R' })])] });
  assert.ok(calls.some((c) => /- 2026-11-18 decided by run: a b -> c {1,2}d \(R\)/.test(c.prompt)), 'the line is one line with spaces');
  assert.ok(!calls.some((c) => /decided by run: a\nb/.test(c.prompt) || /-> c\r?\nd/.test(c.prompt)));
});

// T4.22
test('T4.22 a resumed run does not append a line already in ## Decisions', async () => {
  const q = clear({ text: 'Which name?', recommended: 'OPT-ALPHA', reason: 'because one' });
  const fresh = await run(withNt({ onQuestion: 'decide' }), { body: 'spec docs/specs/a.md\n## Decisions\n- 2026-11-01 decided by run: other -> x (y)', plans: [planWith([q])] });
  const resumed = await run(withNt({ onQuestion: 'decide' }), { body: 'spec docs/specs/a.md\n## Decisions\n' + LINE1, plans: [planWith([q])] });
  assert.equal(resumed.rep[0].status, 'pr');
  assert.ok(occurrences(fresh.calls, LINE1) >= 1, 'a new line is written when it is not there yet');
  assert.ok(occurrences(resumed.calls, LINE1) < occurrences(fresh.calls, LINE1), 'the identical line is not appended again');
});

// T4.23
test('T4.23 decisions:review is added again only when the run took a new decision', async () => {
  const q = clear({ text: 'Which name?', recommended: 'OPT-ALPHA', reason: 'because one' });
  const fresh = await run(withNt({ onQuestion: 'decide' }), { body: 'spec docs/specs/a.md\n## Decisions\n- 2026-11-01 decided by run: other -> x (y)', plans: [planWith([q])] });
  const resumed = await run(withNt({ onQuestion: 'decide' }), { body: 'spec docs/specs/a.md\n## Decisions\n' + LINE1, plans: [planWith([q])] });
  assert.ok(occurrences(fresh.calls, 'decisions:review') >= 1, 'a new decision adds the label');
  assert.ok(occurrences(resumed.calls, 'decisions:review') < occurrences(fresh.calls, 'decisions:review'), 'no new decision, no label');
});

// ---- T4.24 (engine), T4.25 --------------------------------------------------------------------------------
// T4.24
test('T4.24 with onQuestion block questions block and a leftover warning ships', async () => {
  const a = await run(withNt({ onQuestion: 'block' }), { plans: [planWith([clear()])] });
  assert.equal(a.rep[0].status, 'blocked');
  assert.match(prompt(a.calls, 'blocked'), /<!-- devflow-questions -->/);
  const b = await run(withNt({ onQuestion: 'block', maxReviewRounds: 1 }), { review: always(finding('warning')) });
  assert.equal(b.rep[0].status, 'pr');
  assert.equal(b.rep[0].risk, 'high');
});

// T4.25
test('T4.25 a config without nextTask.onQuestion behaves as decide', async () => {
  const none = { ...BASE, issues: [1] };
  const { rep, calls } = await run(none, { plans: [planWith([D1])] });
  assert.equal(rep[0].status, 'pr');
  assert.ok(occurrences(calls, LINE1) >= 1);
  const empty = await run(withNt({}), { plans: [planWith([D1])] });
  assert.equal(empty.rep[0].status, 'pr');
});

// ---- T4.29-T4.31 ------------------------------------------------------------------------------------------------
// T4.29
test('T4.29 the PR template has a ## Decisions taken section with None as the empty value', () => {
  const md = fs.readFileSync(path.join(ROOT, 'skills', 'next-task', 'templates', 'pr.md'), 'utf8');
  const m = /^## Decisions taken[ \t]*$/m.exec(md);
  assert.ok(m, 'the heading exists');
  const rest = md.slice(m.index + m[0].length);
  const section = rest.split(/^## /m)[0];
  assert.match(section, /None/);
});

// T4.30
test('T4.30 only a changesCriterion block question ends with the typed-answer suffix', async () => {
  const SUFFIX = '[changes a criterion: typed answer needed]';
  const qs = [
    clear({ text: 'Plain one?', recommended: 'OPT-P1', reason: 'rp1', needsDestructiveGit: true }),
    clear({ text: 'Criterion one?', recommended: 'OPT-C', reason: 'rc', changesCriterion: true }),
    clear({ text: 'Plain two?', recommended: 'OPT-P2', reason: 'rp2', outsideRepo: true }),
  ];
  const { rep, calls } = await run(withNt({ onQuestion: 'decide' }), { plans: [planWith(qs)] });
  assert.equal(rep[0].status, 'blocked');
  const b = prompt(calls, 'blocked');
  assert.equal(b.split(SUFFIX).length - 1, 1, 'the suffix appears once');
  const at = (s) => b.indexOf(s);
  assert.ok(at('Criterion one?') < at(SUFFIX) && at(SUFFIX) < at('Plain two?'), 'the suffix follows the criterion question and ends before the next');
  assert.ok(at('Recommended: OPT-C (rc)') < at(SUFFIX), 'the suffix ends the question, after its Recommended line');
  assert.ok(at('Plain one?') < at('Criterion one?'));
});

// T4.31
test('T4.31 every question-returning prompt defines changesCriterion and says a mere mention leaves it false', async () => {
  const cap = await capture();
  for (const s of STAGES) {
    const p = cap[s].prompt;
    assert.match(p, /changesCriterion/, `${s} names changesCriterion`);
    assert.match(p, /the recommended option alters what an acceptance criterion requires/, `${s} has the definition`);
    assert.match(p, /(only|merely|just)\s+mentions?[^.]*criteri[^.]*\bfalse\b|mentions? (a|an|the) (acceptance )?criterion[^.]*\bfalse\b/i, `${s} says a mere mention leaves it false`);
  }
});
