'use strict';
// Pre-release review of Wave 5 (epic #162): regressions found after the six issues merged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'next-task-engine.js'), 'utf8').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const compile = () => new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);

const CONFIG = {
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
  risk: { highPaths: ['.github/**'] },
  nextTask: { onQuestion: 'decide', trustDecisions: true, maxFixRounds: 1 },
};

// One issue whose body already holds a decision an earlier run flagged for human review; this run asks nothing.
async function resumedRun(body) {
  const calls = [];
  const files = ['src/x.js'];
  const labels = ['risk:low'];
  const args = {
    config: CONFIG, issues: [1], limit: 3, startBranch: 'main', prTemplatePath: '', claimId: 'C-me', pluginRoot: '/plugin',
  };
  const agent = async (prompt, { label }) => {
    calls.push({ label, prompt });
    const stage = label.split(' ')[0];
    if (label === 'select issues') {
      return { issues: [{ number: 1, title: 'Issue 1', labels, dependsOn: [], parents: [], body }], skipped: [] };
    }
    if (label.startsWith('claim check')) return { claimPresent: true };
    if (stage === 'claim') {
      return { taken: false, claims: [{ commentId: 11, claimId: 'C-me', createdAt: new Date().toISOString() }], labels, specPath: '', introducedBy: false };
    }
    if (stage === 'branch') return { ok: true, branch: 'feat/1-x' };
    if (stage === 'implement' || stage === 'fix') {
      return { status: 'done', summary: 'Implemented', commits: ['abc feat: x'], filesChanged: files, assumptions: [], outOfScope: [], touchesUi: false, specRead: 'docs/specs/a.md', questions: [] };
    }
    if (stage === 'check') return { passed: true, failures: [] };
    if (stage === 'scan') return { scanned: true, hits: [], changedFiles: files, files };
    if (stage === 'review') return { issueRead: true, verdict: 'pass', findings: [] };
    if (stage === 'ship') return { ok: true, prNumber: 101, url: 'https://github.com/o/r/pull/101', mergeState: 'clean' };
    return { ok: true, pushed: false, files, changedFiles: files };
  };
  const report = await compile()(args, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((fn) => fn())));
  return { report, calls };
}

const prLabels = (calls) => {
  const ship = calls.find((c) => c.label === 'ship #1')?.prompt ?? '';
  const line = ship.match(/^.*Label the new PR.*$/m)?.[0] ?? '';
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

const BODY = '## Acceptance criteria\n- Clients can retry.\n\nSpec: docs/specs/a.md\n\n## Decisions\n\n';

test('R1 a resumed run keeps a decision an earlier run flagged for human review', async () => {
  const { report, calls } = await resumedRun(
    `${BODY}- 2026-11-25 decided by run: Which status? -> 409 (safe) [needs human review]\n`);
  const labels = prLabels(calls);
  assert.ok(labels.includes('decisions:review'), 'PR keeps decisions:review');
  assert.ok(labels.includes('risk:high') && !labels.includes('risk:low'), 'PR stays risk:high');
  assert.equal(report[0].next, 'merge');
});

test('R2 a plain earlier decision does not force human review', async () => {
  const { report, calls } = await resumedRun(`${BODY}- 2026-11-25 decided by run: Which name? -> a (short)\n`);
  assert.ok(prLabels(calls).includes('risk:low'));
  assert.notEqual(report[0].risk, 'high');
});

test('R3 the allow list covers the plugin helpers and lane sessions autopilot runs unattended', () => {
  const { allowRules } = require('../bin/devflow-setup');
  const allow = allowRules({ github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: [] });
  for (const bin of ['devflow-lanes', 'devflow-autopilot', 'devflow-digest']) {
    assert.ok(allow.includes(`Bash(node "${path.join(ROOT, 'bin', bin)}":*)`), bin);
  }
  assert.ok(allow.includes('Bash(claude --bg --name devflow-lane-*)'));
  assert.ok(!allow.includes('Bash(claude:*)') && !allow.includes('Bash(claude --bg:*)'), 'no broad claude rule');
  const withDir = allowRules({ github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: [], dispatch: { pluginDir: '/p/devflow' } });
  assert.ok(withDir.includes('Bash(claude --bg --plugin-dir /p/devflow --name devflow-lane-*)'));
});

test('R4 autopilot dispatches a ready child with an open PR and no run', () => {
  const { planTick } = require('../bin/devflow-autopilot');
  const result = planTick({
    now: '2026-11-26T10:00:00Z', autoReady: 'all',
    children: [{ number: 7, state: 'open', labels: ['agent:ready'], body: '', hotspots: [], dependsOn: [], lastActivity: null,
      pr: { number: 70, state: 'open', merged: false, aheadBy: 2 } }],
  });
  assert.deepEqual(result.dispatch, [{ issues: [7] }]);
  assert.deepEqual(result.waiting, []);
});
