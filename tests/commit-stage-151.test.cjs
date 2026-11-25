'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const fixture = fs.readFileSync(path.join(__dirname, 'engine.test.cjs'), 'utf8').split(/^test\(/m)[0];
const { BASE, QA, run, prompt } = new Function(
  'require', '__dirname', fixture + '\nreturn { BASE, QA, run, prompt };',
)(require, __dirname);

const commitCommand = /devflow-run["']?\s+commit\b/;
const cliResult = {
  ok: true,
  commits: [
    { sha: 'abc1234', message: 'test(#151): tests for t151', files: QA.qaFiles },
    { sha: 'def5678', message: 'feat(#151): t151', files: QA.devFiles },
  ],
  leftover: [],
  redConfirmed: false,
  redOutput: 'QA passed at the test commit',
};

test('M3.7 sets the commit JSON type to fix for type:fix and feat with no labels', async () => {
  const { rep, calls } = await run({ ...BASE, issues: [151, 152] }, {
    ...QA,
    selectLabels: (number) => number === 151 ? ['type:fix'] : [],
  });
  assert.deepEqual(rep.map(({ status }) => status), ['pr', 'pr']);
  const types = [151, 152].map((number) => {
    const commit = prompt(calls, 'commit #' + number);
    assert.ok(commit, 'Expected a commit stage for #' + number);
    const payload = commit.match(/\{[^{}]*"type"\s*:\s*"[^"]+"[^{}]*\}/);
    assert.ok(payload, 'Expected engine-built commit input JSON with a type for #' + number);
    return JSON.parse(payload[0]).type;
  });
  assert.deepEqual(types, ['fix', 'feat']);
});

test('M3.8 runs devflow-run commit and carries a passing red check into PR assumptions', async () => {
  const { rep, calls, logs } = await run({ ...BASE, issues: [151] }, {
    ...QA,
    agentResult: (_prompt, { label }) => label === 'commit #151' ? cliResult : undefined,
  });
  assert.equal(rep[0].status, 'pr', rep[0].reason);
  assert.match(calls.map(({ l }) => l.split(' ')[0]).join(','), /plan,qa,implement,commit,check/);
  assert.ok(commitCommand.test(prompt(calls, 'commit #151')), 'Expected Commit to run devflow-run commit');
  assert.ok(logs.some((log) => log.includes('QA tests did not fail') && log.includes(cliResult.redOutput)),
    'Expected the red-check output in the log for tests that passed');
  assert.match(rep[0].notes.join('\n'), /QA tests did not fail before the implementation/);
  const ship = prompt(calls, 'ship #151');
  assert.ok(ship.includes('QA tests did not fail before the implementation: ' + cliResult.redOutput));
  for (const { sha, message } of cliResult.commits) {
    assert.ok(ship.includes(sha + ' ' + message), 'Expected the Commit result in the Ship prompt');
  }
});

test('M4.4 uses devflow-run to acquire and release the default Verify lock', async () => {
  const config = {
    ...BASE.config,
    verify: { modes: ['http'], devServer: { run: 'make run', url: 'http://127.0.0.1:5050' } },
  };
  const { rep, calls } = await run({ ...BASE, config, issues: [151] }, { labels: ['needs-e2e'] });
  assert.equal(rep[0].status, 'pr', rep[0].reason);
  const verify = prompt(calls, 'verify #151');
  assert.ok(verify, 'Expected a Verify stage');
  assert.ok(/devflow-run["']?\s+lock acquire --name verify\b/.test(verify),
    'Expected Verify to run devflow-run lock acquire --name verify');
  assert.ok(/devflow-run["']?\s+lock release --name verify\b/.test(verify),
    'Expected Verify to run devflow-run lock release --name verify');
  assert.doesNotMatch(verify, /\b(?:mkdir|rmdir)\b/);
});
