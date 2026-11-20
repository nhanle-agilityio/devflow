'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const repoFile = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const SRC = repoFile('workflows/next-task-engine.js').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
const config = {
  devflowVersion: '3.0.0',
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
};

async function run({ risks = [undefined], nextTask = {} } = {}) {
  const calls = [];
  const issues = risks.map((risk, index) => ({
    number: 141 + index,
    title: 'Review model and agent budget',
    labels: risk ? ['risk:' + risk] : [],
    body: '',
    dependsOn: [],
  }));
  const agent = async (_prompt, options) => {
    calls.push(options);
    const { label } = options;
    const number = Number(/#(\d+)/.exec(label)?.[1]);
    switch (label.split(' ')[0]) {
      case 'select':
        return { issues, skipped: [] };
      case 'claim':
        return {
          taken: false,
          claims: [{ commentId: 1, claimId: 'C-me', createdAt: '2026-01-01T00:00:05Z' }],
          labels: issues.find((issue) => issue.number === number).labels,
          specPath: '', introducedBy: false,
        };
      case 'branch':
        return { ok: true, branch: 'feat/' + number };
      case 'plan':
        return {
          status: 'ready', plan: '## Files to change\n- `src/x.js` (Dev)',
          questions: [], qaFiles: [], devFiles: ['src/x.js'], specRead: 'none',
          acceptanceCriteria: 0, httpOrE2eRows: false,
        };
      case 'implement':
        return {
          status: 'done', summary: 'Implemented', commits: ['abc1234'], filesChanged: ['src/x.js'],
          assumptions: [], outOfScope: [], touchesUi: false, specRead: 'none',
        };
      case 'check':
        return { passed: true, failures: [] };
      case 'scan':
        return { scanned: true, hits: [] };
      case 'review':
        return { verdict: 'pass', findings: [], issueRead: true };
      case 'ship':
        return { ok: true, prNumber: number + 1000, url: 'https://example.test/pull/' + (number + 1000) };
      case 'blocked':
      case 'restore':
        return { ok: true };
      default:
        throw new Error('unexpected agent ' + label);
    }
  };
  const args = {
    config: { ...config, nextTask: { onQuestion: 'block', ...nextTask } },
    issues: issues.map(({ number }) => number),
    limit: issues.length, startBranch: 'main', claimId: 'C-me', pluginRoot: '/plugin',
  };
  const report = await engine(args, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((fn) => fn())));
  return { report, calls };
}

function issueCalls(calls, number) {
  const labelForIssue = new RegExp(` #${number}(?: |$)`);
  return calls.filter(({ label }) => labelForIssue.test(label));
}

async function reviewModels(risks, nextTask) {
  const { report, calls } = await run({ risks, nextTask });
  return risks.map((_, index) => {
    const number = 141 + index;
    const result = report.find(({ issue }) => issue === number);
    assert.equal(result?.status, 'pr', result?.reason);
    const reviews = issueCalls(calls, number).filter(({ label }) => label.startsWith('review #'));
    assert.equal(reviews.length, 1, `Expected one review agent call for #${number}`);
    return reviews[0].model;
  });
}

test('X2.1 low-risk review defaults to sonnet', async () => {
  assert.deepEqual(await reviewModels(['low']), ['sonnet'], 'Expected sonnet for a low-risk review');
});

test('X2.2 high-risk review defaults to opus', async () => {
  assert.deepEqual(await reviewModels(['high']), ['opus'], 'Expected opus for a high-risk review');
});

test('X2.3 review with no risk label defaults to opus', async () => {
  assert.deepEqual(await reviewModels([undefined]), ['opus'], 'Expected opus for a review with unknown risk');
});

test('X2.4 partial reviewModel overrides one risk and preserves the other default', async () => {
  const lowOverride = await reviewModels(['low', 'high'], { reviewModel: { low: 'haiku' } });
  const highOverride = await reviewModels(['low', 'high'], { reviewModel: { high: 'haiku' } });
  assert.deepEqual({ lowOverride, highOverride }, {
    lowOverride: ['haiku', 'opus'],
    highOverride: ['sonnet', 'haiku'],
  }, 'Expected each partial reviewModel override to preserve the other default');
});

test('X2.5 omitting maxAgentCalls permits a full run beyond three issue calls', async () => {
  const { report, calls } = await run();
  assert.ok(issueCalls(calls, 141).length > 3, 'Expected more than three issue agent calls');
  assert.equal(report[0]?.status, 'pr', report[0]?.reason);
});

test('X2.6 maxAgentCalls blocks the issue when it reaches three calls', async () => {
  const { report, calls } = await run({ nextTask: { maxAgentCalls: 3 } });
  assert.deepEqual([report[0]?.status, report[0]?.reason], ['blocked', 'agent budget exceeded (3 calls)'],
    'Expected the issue to block with agent budget exceeded (3 calls)');
  const workCalls = issueCalls(calls, 141).filter(({ label }) => !label.startsWith('blocked '));
  assert.equal(workCalls.length, 3, 'Expected exactly three issue calls before block cleanup');
});

test('X2.7 the second issue gets a fresh agent budget', async () => {
  const { report, calls } = await run({ risks: ['high', 'high'], nextTask: { maxAgentCalls: 3 } });
  assert.deepEqual(report.map(({ issue, status, reason }) => [issue, status, reason]), [
    [141, 'blocked', 'agent budget exceeded (3 calls)'],
    [142, 'blocked', 'agent budget exceeded (3 calls)'],
  ], 'Expected both issues to reach their own three-call budget');
  for (const number of [141, 142]) {
    const workCalls = issueCalls(calls, number).filter(({ label }) => !label.startsWith('blocked '));
    assert.equal(workCalls.length, 3, `Expected #${number} to receive all three calls before block cleanup`);
  }
});
function validate(schema, value, at = '$') {
  const errs = [];
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) errs.push(`${at}: not in enum`);
  const t = schema.type;
  if (t) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = t === actual || (t === 'number' && actual === 'integer');
    if (!ok) return [`${at}: expected ${t}, got ${actual}`];
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: too short`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: too few items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}: missing ${k}`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
    }
  }
  return errs;
}
const stripJsonc = (text) => {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
};

test('X2.8 schema and annotated example define both defaults and accept a 3.0.0 config', () => {
  const schema = JSON.parse(repoFile('skills/init/templates/devflow.schema.json'));
  const example = JSON.parse(stripJsonc(repoFile('skills/init/templates/devflow.json')));
  const { reviewModel, maxAgentCalls } = schema.properties.nextTask.properties;
  const defaults = { reviewModel: { low: 'sonnet', high: 'opus' }, maxAgentCalls: 0 };

  assert.deepEqual(validate(schema, { ...config, nextTask: { maxReviewRounds: 2 } }), []);
  assert.deepEqual(validate(schema, example), []);
  assert.deepEqual({
    schema: { reviewModel: reviewModel?.default, maxAgentCalls: maxAgentCalls?.default },
    example: { reviewModel: example.nextTask.reviewModel, maxAgentCalls: example.nextTask.maxAgentCalls },
  }, { schema: defaults, example: defaults }, 'Expected both keys and their defaults in the schema and annotated example');
  assert.equal(maxAgentCalls.type, 'integer');
  for (const partial of [{ low: 'haiku' }, { high: 'haiku' }]) {
    assert.deepEqual(validate(schema, { ...config, nextTask: { reviewModel: partial, maxAgentCalls: 3 } }), []);
  }
});
