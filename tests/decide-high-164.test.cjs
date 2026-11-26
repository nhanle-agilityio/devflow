'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'next-task-engine.js'), 'utf8').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const compile = () => new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);

const HIGH_FLAGS = ['productDecision', 'changesCriterion', 'changesContract', 'changesStoredFormat', 'lowersRisk'];
const STOP_FLAGS = ['skipsCheck', 'dropsMustRow', 'needsDestructiveGit', 'outsideRepo'];
const QUESTION = {
  text: 'Which response should clients receive?',
  tag: 'BA',
  recommended: 'Return the existing record',
  reason: 'Clients can repeat the request safely',
  reversible: true,
  ...Object.fromEntries([...HIGH_FLAGS, ...STOP_FLAGS].map((flag) => [flag, false])),
};
const CONTEXT = { onQuestion: 'decide', changedFiles: ['src/x.js'], highPaths: ['.github/**'] };
const BUG_TEMPLATE = path.join(ROOT, 'skills', 'spec', 'templates', 'bug.md');
const BUG_MARKER = '<!-- devflow-run-error #1 -->';
const BUG_URL = 'https://github.com/o/r/issues/901';
const RED_OUTPUT = 'AssertionError: expected 201, received 500';
const SECRET_OUTPUT = 'Required environment variable DEVFLOW_TEST_TOKEN is missing';
const CONFIG = {
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
  risk: { highPaths: CONTEXT.highPaths },
  nextTask: { onQuestion: 'decide', trustDecisions: true, maxFixRounds: 1 },
};

async function classifier() {
  const { classifyQuestion } = await compile()({ exports: true }, null, () => {}, () => {}, null);
  return (q, ctx = {}) => classifyQuestion(q, { ...CONTEXT, ...ctx });
}

test('A3.1 each high-risk decision flag yields decide-high', async () => {
  const classify = await classifier();
  assert.deepEqual(
    Object.fromEntries(HIGH_FLAGS.map((flag) => [flag, classify({ ...QUESTION, [flag]: true })])),
    Object.fromEntries(HIGH_FLAGS.map((flag) => [flag, 'decide-high'])),
  );
});

test('A3.2 a full-diff path matching a highPaths glob yields decide-high', async () => {
  const classify = await classifier();
  assert.equal(classify(QUESTION, { changedFiles: ['.github/workflows/x.yml'] }), 'decide-high');
});

test('A3.3 hard stops block even in the presence of high-risk flags and paths', async () => {
  const classify = await classifier();
  const ctx = { changedFiles: ['.github/workflows/x.yml'] };
  const stops = { reversible: false, ...Object.fromEntries(STOP_FLAGS.map((flag) => [flag, true])) };
  for (const [flag, value] of Object.entries(stops)) {
    assert.equal(classify({ ...QUESTION, productDecision: true, [flag]: value }, ctx), 'block', flag);
  }
});

test('A3.4 opt-out and incomplete or invalid inputs block', async () => {
  const classify = await classifier();
  assert.equal(classify(QUESTION, { onQuestion: 'block' }), 'block');
  for (const q of [null, 'question', { ...QUESTION, recommended: ' ' }, { ...QUESTION, reason: '' }]) {
    assert.equal(classify(q), 'block');
  }
  for (const key of ['recommended', 'reason', 'reversible', ...HIGH_FLAGS, ...STOP_FLAGS]) {
    const incomplete = { ...QUESTION };
    delete incomplete[key];
    assert.equal(classify(incomplete), 'block', `missing ${key}`);
    if (typeof QUESTION[key] === 'boolean') {
      assert.equal(classify({ ...QUESTION, [key]: 'false' }), 'block', `non-boolean ${key}`);
    }
  }
  assert.equal(classify(QUESTION, { changedFiles: null }), 'block');
  assert.equal(classify(QUESTION, { highPaths: '.github/**' }), 'block');
});

test('A3.5 a reversible question with no risk flags or high path yields decide', async () => {
  const classify = await classifier();
  assert.equal(classify(QUESTION), 'decide');
});

// Run the workflow as text with stub agents, as in engine-decide.test.cjs.
async function run({ question, redOutput, missingEnv = false, chain = false, nextTask, claimMissing = false } = {}) {
  const calls = [];
  const args = {
    config: { ...CONFIG, nextTask: { ...CONFIG.nextTask, ...nextTask } },
    issues: chain ? [1, 2] : [1],
    chain,
    limit: 3,
    startBranch: 'main',
    prTemplatePath: '',
    bugTemplatePath: BUG_TEMPLATE,
    claimId: 'C-me',
    runDate: '2026-11-26',
    pluginRoot: '/plugin',
  };
  const files = ['src/x.js'];
  const labels = ['risk:low'];
  const agent = async (prompt, { label }) => {
    calls.push({ label, prompt });
    const n = Number(/#(\d+)/.exec(label)?.[1]);
    const stage = label.split(' ')[0];
    if (label === 'select issues') {
      return {
        issues: args.issues.map((number) => ({
          number, title: `Issue ${number}`, labels, dependsOn: [], parents: [],
          body: '## Acceptance criteria\n- Clients can retry a request.\n\nSpec: docs/specs/a.md',
        })),
        skipped: [],
      };
    }
    if (stage === 'claim') {
      const claim = { commentId: 10 + n, claimId: args.claimId, createdAt: new Date().toISOString() };
      return { taken: false, claims: claimMissing ? [] : [claim], labels, specPath: '', introducedBy: false };
    }
    if (stage === 'branch') return { ok: true, branch: `feat/${n}-x` };
    if (stage === 'implement' || stage === 'fix') {
      const asks = stage === 'implement' && n === 1 && question &&
        calls.filter((call) => call.label === label).length === 1;
      return {
        status: asks ? 'blocked' : 'done', summary: 'Implemented',
        commits: ['abc feat: implement'], filesChanged: files, assumptions: [],
        outOfScope: [], touchesUi: false, specRead: 'docs/specs/a.md',
        questions: asks ? [question] : [],
      };
    }
    if (stage === 'check') {
      if (n === 1 && missingEnv) return { ok: false, error: SECRET_OUTPUT };
      if (n === 1 && redOutput) return { passed: false, failures: [{ check: 'test', output: redOutput }] };
      return { passed: true, failures: [] };
    }
    if (stage === 'scan') return { scanned: true, hits: [], changedFiles: files, files };
    if (stage === 'review') return { issueRead: true, verdict: 'pass', findings: [] };
    if (stage === 'ship') return { ok: true, prNumber: 100 + n, url: `https://github.com/o/r/pull/${100 + n}`, mergeState: 'clean' };

    // Simulate a bug number and URL if the workflow delegates filing to an agent.
    if (isBugFilingPrompt(prompt)) return { ok: true, pushed: false, bugNumber: 901, bugUrl: BUG_URL, number: 901, url: BUG_URL };
    return { ok: true, pushed: false, files, changedFiles: files };
  };
  const report = await compile()(args, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((fn) => fn())));
  return { report, calls };
}

const highRun = () => run({ question: { ...QUESTION, changesCriterion: true } });
const stagePrompt = (calls, label) => calls.find((call) => call.label === label)?.prompt ?? '';

test('A3.6 decide-high ships with high-risk labels and a human merge route even when trusted', async () => {
  const { report, calls } = await highRun();
  assert.equal(report[0].status, 'pr', 'the decide-high question must allow shipping');
  assert.equal(stagePrompt(calls, 'blocked #1'), '');
  const ship = stagePrompt(calls, 'ship #1');
  const labelStep = ship.match(/^.*Label the new PR.*$/m)?.[0] ?? '';
  const prLabels = [...labelStep.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(prLabels.includes('decisions:review'), 'the PR gets decisions:review');
  assert.ok(prLabels.includes('risk:high'), 'the PR gets risk:high');
  assert.ok(!prLabels.includes('risk:low'), 'the PR excludes risk:low');
  assert.match(ship, /On issue #1[^\n]*add "risk:high"[^\n]*remove "risk:low"/);
  assert.equal(report[0].risk, 'high');
  assert.equal(report[0].next, 'merge');
  const implementations = calls.filter(({ label }) => label === 'implement #1');
  assert.equal(implementations.length, 2, 'retry implementation after taking the decision');
  assert.ok(implementations[1].prompt.includes(QUESTION.recommended), 'the retry gets the recommended option');
});

test('A3.7 the issue and PR record the answer for human review without editing acceptance criteria', async () => {
  const { calls } = await highRun();
  const { text, recommended, reason } = QUESTION;
  const answer = `${text} -> ${recommended} (${reason})`;
  const record = stagePrompt(calls, 'decisions #1');
  assert.match(record, /## Decisions/, 'the issue decision is recorded under ## Decisions');
  assert.ok(record.split('\n').some((line) =>
    /^- \d{4}-\d{2}-\d{2} decided by run: /.test(line) &&
    line.includes(answer) && /needs human review/i.test(line)), 'the issue decision line carries the answer and review flag');

  const ship = stagePrompt(calls, 'ship #1');
  const payload = ship.match(/<<'DEVFLOW_PR_JSON'\n([\s\S]*?)\nDEVFLOW_PR_JSON/);
  assert.ok(payload, 'the ship prompt contains the PR renderer payload');
  assert.ok(JSON.parse(payload[1]).decisions.some((line) =>
    line.includes(answer) && /needs human review/i.test(line)), 'the PR decision line carries the answer and review flag');

  const editCriteria = /\b(?:edit|change|update|modify|rewrite|replace|amend)\s+(?:(?:the|issue(?:'s)?|body|section)\s+)*[`"']*(?:##\s+)?acceptance criteria\b/i;
  for (const { label, prompt } of calls) {
    for (const sentence of prompt.split(/\n|(?<=[.!?;])\s+/)) {
      const edit = editCriteria.exec(sentence);
      if (!edit || /\b(?:never|do not|don't|must not)\s*$/i.test(sentence.slice(0, edit.index))) continue;
      assert.fail(`${label} asks to edit issue acceptance criteria: ${sentence}`);
    }
  }
});

function isBugFilingPrompt(prompt) {
  return /\b(?:file|create|open)\s+(?:(?:a|an|one|new|single|GitHub|triage)\s+)*(?:bug\b|issue\b(?=[^.\n]*\b(?:bug template|needs-triage)\b))/i.test(prompt);
}

const bugPrompts = (calls) => calls
  .filter(({ label, prompt }) => !label.startsWith('ship ') && isBugFilingPrompt(prompt))
  .map(({ prompt }) => prompt);

function assertBugFiled({ report, calls }, output) {
  assert.deepEqual(report.map(({ issue, status }) => [issue, status]), [[1, 'blocked'], [2, 'pr']]);
  const block = stagePrompt(calls, 'blocked #1');
  assert.match(block, /add (?:the label )?["`]?agent:blocked/);
  const filings = bugPrompts(calls);
  assert.equal(filings.length, 1, 'one agent step must request filing a bug');
  const [filing] = filings;
  assert.ok(filing.includes(BUG_TEMPLATE), 'use args.bugTemplatePath');
  assert.ok(filing.includes(BUG_MARKER), 'include the hidden marker in the bug body');
  assert.ok(filing.includes(output), 'quote the failing output');
  assert.match(filing.replace(BUG_MARKER, ''), /#1\b|https:\/\/github\.com\/o\/r\/issues\/1\b/);
  assert.match(filing,
    /(?:\blabel(?:s|led|ed)?\b[ :]*["`']?needs-triage["`']?\s+only\b|\bonly\b[^.\n]{0,45}["`']?needs-triage\b)/i,
    'the bug receives only needs-triage');
  const comment = /comment[^.\n]*\b(?:bug|new issue)\b[^.\n]*\b(?:link|url)\b|comment[^.\n]*\b(?:link|url)\b[^.\n]*\b(?:bug|new issue)\b/i;
  assert.ok(calls.some(({ prompt }) => /comment[^\n]*https:\/\/github\.com\/o\/r\/issues\/901\b/i.test(prompt)) ||
    [block, filing].some((prompt) => comment.test(prompt) && /comment[^\n]*#1\b/i.test(prompt)),
  'the blocked issue gets a comment linking the bug');
}

test('A3.8 checks still red after the final fix file one triage bug and the lane continues', async () => {
  const result = await run({ chain: true, redOutput: RED_OUTPUT });
  const { report, calls } = result;
  assert.equal(calls.filter(({ label }) => label.startsWith('check #1')).length, 2);
  assert.equal(calls.filter(({ label }) => label === 'fix #1').length, 1);
  assert.match(report[0].reason, /^Check: Checks still failing after 1 fix round/);
  assertBugFiled(result, RED_OUTPUT);
});

test('A3.8 a missing required environment variable files one triage bug and the lane continues', async () => {
  const result = await run({ chain: true, missingEnv: true });
  assert.ok(result.report[0].reason.includes(SECRET_OUTPUT));
  assertBugFiled(result, SECRET_OUTPUT);
});

test('A3.9 search for the hidden marker and reuse an existing bug before creating one', async () => {
  const { calls } = await run({ redOutput: RED_OUTPUT });
  const [filing] = bugPrompts(calls);
  assert.ok(filing, 'the error block must delegate filing a bug');
  const search = /\b(?:search|look for|find|check for)\b[^.\n]*<!-- devflow-run-error #1 -->/i.exec(filing);
  assert.ok(search, 'the filing step searches by the exact marker');
  const afterSearch = filing.slice(search.index + search[0].length);
  assert.match(afterSearch, /\breuse\b[^.\n]*|\buse\b[^.\n]*\bexisting\b/i);
  assert.match(afterSearch, /\b(?:if|unless|only)\b[^.\n]*(?:no (?:match|issue|bug)|none|not found|does not exist|doesn't exist|existing)[^.\n]*|\botherwise\b[^.\n]*\b(?:file|create|open)\b/i,
    'creation is conditional on there being no existing bug');
});

test('A3.10 an unanswerable question, budget block or claim block files no bug', async () => {
  for (const [options, reason] of [
    [{ question: { ...QUESTION, reversible: false } }, /open question/],
    [{ nextTask: { maxAgentCalls: 1 } }, /budget/i],
    [{ claimMissing: true }, /^Claim:/],
  ]) {
    const { report, calls } = await run(options);
    assert.equal(report[0].status, 'blocked');
    assert.match(report[0].reason, reason);
    assert.deepEqual(bugPrompts(calls), []);
    assert.ok(calls.every(({ prompt }) => !prompt.includes('devflow-run-error')));
  }
});
