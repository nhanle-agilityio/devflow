'use strict';
// #57: the fix and review prompts of an issue with a spec path (or no spec at all) behave as in 2.9.0:
// the base ref is interpolated, nothing reads the epic. Own file: tests/engine.test.cjs is QA-owned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'next-task-engine.js'), 'utf8').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { github: { owner: 'o', repo: 'r', remote: 'origin' }, baseBranch: 'main', checks: [{ name: 'test', run: 'make test' }], specDir: 'docs/specs' };
const ARGS = { config: CFG, limit: 1, startBranch: 'main', prTemplatePath: '', claimId: 'C-me', pluginRoot: '/plugin', issues: [1] };

// Runs one issue whose first check fails, so a fix prompt is built; returns every prompt by stage.
async function run(body, specRead) {
  const prompts = {};
  let checks = 0;
  const agent = async (prompt, o) => {
    const l = o.label.split(' ')[0];
    if (!(l in prompts)) prompts[l] = prompt;
    switch (l) {
      case 'select': return { issues: [{ number: 1, title: 't', labels: [], body, dependsOn: [], parents: [] }], skipped: [] };
      case 'claim': return { taken: false, claims: [{ commentId: 11, claimId: 'C-me', createdAt: '2026-01-01T00:00:05Z' }], labels: [], specPath: '', introducedBy: false };
      case 'branch': return { ok: true, branch: 'feat/1-x' };
      case 'plan': return { status: 'ready', plan: 'P', questions: [], qaFiles: [], devFiles: ['src/x.py'], specRead, acceptanceCriteria: 0, httpOrE2eRows: false };
      case 'implement':
      case 'fix': return { status: 'done', summary: 's', commits: ['a b'], filesChanged: ['src/x.py'], assumptions: [], outOfScope: [], touchesUi: false, specRead };
      case 'check': return ++checks === 1 ? { passed: false, failures: [{ check: 'test', output: 'boom' }] } : { passed: true, failures: [] };
      case 'scan': return { scanned: true, hits: [] };
      case 'review': return { issueRead: true, verdict: 'pass', findings: [] };
      case 'ship': return { ok: true, prNumber: 101, url: 'u' };
      case 'restore': return { ok: true };
      default: throw new Error('unexpected agent ' + o.label);
    }
  };
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  const rep = await fn(ARGS, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((f) => f())));
  return { rep, prompts };
}

function assertClean(prompts, expectSpec) {
  for (const l of ['plan', 'implement', 'fix', 'review']) {
    const p = prompts[l];
    assert.ok(p, `${l} prompt exists`);
    assert.doesNotMatch(p, /\$\{/, `${l} has no uninterpolated placeholder`);
    assert.doesNotMatch(p, /\\`/, `${l} has no escaped backtick`);
    assert.doesNotMatch(p, /issue_read|epicRead|read epic|#42/i, `${l} does not read the epic`);
  }
  if (expectSpec) for (const l of ['plan', 'implement', 'fix']) assert.match(prompts[l], /git show origin\/main:/, `${l} reads the spec from the base ref`);
  assert.match(prompts.fix, /git show origin\/main:/, 'fix prompt interpolates the base ref');
}

test('test_t6_7_fix_and_review_prompts_with_spec_path', async () => {
  const spec = 'docs/specs/2026-11-17-x.md';
  const { rep, prompts } = await run(`Spec: ${spec}\nEpic: #42\n`, spec);
  assert.equal(rep[0].status, 'pr');
  assertClean(prompts, true);
});

test('test_t6_8_fix_and_review_prompts_issue_alone', async () => {
  const { rep, prompts } = await run('Just an issue\n', 'none');
  assert.equal(rep[0].status, 'pr');
  assertClean(prompts, false);
});
