'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'next-task-engine.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', source.replace(/^export /m, ''));
const epicBody = [
  'Epic: #42',
  '',
  '## Acceptance criteria',
  '- [ ] Valid input is saved.',
  '',
  '## Test cases',
  '| ID | Given | When | Then |',
  '| --- | --- | --- | --- |',
  '| T1 | Valid input | Save | Input is stored |',
].join('\n');

async function run({ body = '', sourceRead = 'none', plan = {}, review = {}, nextTask = {}, emptyImplements = 0 } = {}) {
  const calls = [];
  const implementCalls = [];
  const issue = { number: 155, title: 'Save valid input', body, labels: [], dependsOn: [] };
  const agent = async (prompt, options) => {
    const stage = options.label.split(' ')[0];
    calls.push({ stage, prompt });
    if (options.label.startsWith('claim check')) return { claimPresent: true };
    switch (stage) {
      case 'select':
        return { issues: [issue], skipped: [] };
      case 'claim':
        return {
          taken: false, labels: [], specPath: '', introducedBy: false,
          claims: [{ commentId: 1, claimId: 'C-me', createdAt: '2026-01-01T00:00:05Z' }],
        };
      case 'branch':
        return { ok: true, branch: 'feat/155' };
      case 'plan':
        return {
          status: 'ready', plan: '## Files to change\n- `src/x.js` (Dev)',
          questions: [], qaFiles: [], devFiles: ['src/x.js'], specRead: sourceRead,
          acceptanceCriteria: body === epicBody ? 1 : 0, httpOrE2eRows: false, ...plan,
        };
      case 'implement':
        implementCalls.push({ prompt, options });
        if (implementCalls.length <= emptyImplements) return undefined;
        return {
          status: 'done', summary: 'Saved input', commits: ['abc1234'], filesChanged: ['src/x.js'],
          assumptions: [], outOfScope: [], touchesUi: false, specRead: sourceRead,
        };
      case 'check':
        return { passed: true, failures: [] };
      case 'scan':
        return { scanned: true, hits: [] };
      case 'review':
        return { verdict: 'pass', findings: [], issueRead: true, ...review };
      case 'ship':
        return { ok: true, prNumber: 1155, url: 'https://example.test/pull/1155' };
      case 'decisions':
        return { ok: true };
      case 'retreat':
      case 'blocked':
      case 'release':
      case 'restore':
        return { ok: true };
      default:
        throw new Error('unexpected agent ' + options.label);
    }
  };
  const args = {
    config: {
      github: { owner: 'o', repo: 'r', remote: 'origin' },
      baseBranch: 'main',
      checks: [{ name: 'test', run: 'make test' }],
      specDir: 'docs/specs',
      nextTask,
    },
    issues: [155], limit: 1, startBranch: 'main', claimId: 'C-me', pluginRoot: '/plugin',
  };
  const [result] = await engine(args, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((fn) => fn())));
  return { result, calls, implementCalls };
}

const epic = { body: epicBody, sourceRead: 'epic #42' };

function assertShipped({ result, calls }) {
  assert.equal(result.status, 'pr', result.reason);
  assert.equal(calls.some(({ stage }) => stage === 'blocked'), false, 'Expected no block cleanup');
  assert.equal(result.prNumber, 1155);
  const ships = calls.filter(({ stage }) => stage === 'ship');
  assert.equal(ships.length, 1, 'Expected one Ship call');
  return ships[0].prompt;
}

function assertEpicDecision(runResult, stage) {
  const ship = assertShipped(runResult);
  const line = `epic #42 could not be read at ${stage}; continued on the issue's criteria and Test cases`;
  const payload = ship.match(/<<'DEVFLOW_PR_JSON'\n([\s\S]+?)\nDEVFLOW_PR_JSON/);
  assert.ok(payload, 'Expected the Ship PR data');
  const { decisions } = JSON.parse(payload[1]);
  assert.equal(decisions.filter((entry) => entry === line).length, 1, 'Expected the decision once in the PR data');
  assert.equal(runResult.result.notes.filter((note) => note === line).length, 1, 'Expected the decision once in the run notes');
  assert.match(ship, /^3\. Label the new PR .*"decisions:review"/m);
}

function assertBlocked({ result, calls }, reason) {
  assert.equal(result.status, 'blocked', result.reason);
  assert.equal(result.reason, reason);
  assert.equal(calls.some(({ stage }) => stage === 'ship'), false, 'Expected no Ship call');
}

test('B1 Plan epicRead=false ships with one Plan decision', async () => {
  const result = await run({ ...epic, plan: { epicRead: false, specRead: 'none' } });
  assertEpicDecision(result, 'Plan');
});

test('B2 Review epicRead=false ships with one Review decision', async () => {
  const result = await run({ ...epic, review: { epicRead: false } });
  assertEpicDecision(result, 'Review');
});

test('B3 Plan specRead missing the epic ships with one Plan decision', async () => {
  const result = await run({ ...epic, plan: { epicRead: true, specRead: 'none' } });
  assertEpicDecision(result, 'Plan');
});

test('B4 onQuestion block preserves the unreadable epic Plan block', async () => {
  const result = await run({
    ...epic, plan: { epicRead: false, specRead: 'none' }, nextTask: { onQuestion: 'block' },
  });
  assertBlocked(result, 'Plan: epic #42 could not be read');
});

test('B5 a missing spec file read is a Plan decision', async () => {
  const specPath = 'docs/specs/save.md';
  const result = await run({ body: `Spec: ${specPath}`, sourceRead: specPath, plan: { specRead: 'none' } });
  assertShipped(result);
  assert.ok(result.result.notes.includes(`Plan did not read the spec ${specPath}`));
});

test('B6 one empty Implement result retries with the same prompt and options and ships', async () => {
  const result = await run({ emptyImplements: 1 });
  assertShipped(result);
  assert.equal(result.implementCalls.length, 2, 'Expected two Implement calls');
  assert.deepEqual(result.implementCalls[1], result.implementCalls[0]);
});

test('B7 two empty Implement results retreat with the stage and original reason', async () => {
  const result = await run({ emptyImplements: 2 });
  assert.equal(result.result.status, 'skipped');
  assert.equal(result.result.reason, 'retry: Implement: The implement agent died.');
  assert.ok(result.calls.some(({ stage }) => stage === 'retreat'));
  assert.ok(result.calls.every(({ stage }) => stage !== 'ship'));
  assert.equal(result.implementCalls.length, 2, 'Expected two Implement calls before retreat');
});

test('B8 the Implement retry respects and consumes the agent budget', async () => {
  const exhausted = await run({ emptyImplements: 2, nextTask: { maxAgentCalls: 4 } });
  assertBlocked(exhausted, 'agent budget exceeded (4 calls)');
  assert.equal(exhausted.implementCalls.length, 1, 'Expected no retry after the budget was exhausted');

  const retryUsesLastCall = await run({ emptyImplements: 2, nextTask: { maxAgentCalls: 5 } });
  assertBlocked(retryUsesLastCall, 'agent budget exceeded (5 calls)');
  assert.equal(retryUsesLastCall.implementCalls.length, 2, 'Expected the retry to consume the final call');
});
