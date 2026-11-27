'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const bin = path.join(root, 'bin/devflow-run');
const config = { github: { owner: 'o', repo: 'r' }, baseBranch: 'main', devflowVersion: '3.0.0' };

function invoke(t, checks, raw = JSON.stringify({ ...config, checks }), args = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-check-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  if (raw !== null) fs.writeFileSync(path.join(cwd, 'config.json'), raw);
  const result = spawnSync(process.execPath, [bin, 'check', '--config', 'config.json', ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.ok(result.stdout, result.stderr || String(result.error));
  return { status: result.status, ...JSON.parse(result.stdout) };
}

test('M1.1 checks pass in order', (t) => {
  const result = invoke(t, [{ name: 'first', run: 'touch marker' }, { name: 'second', run: 'test -f marker' }]);
  assert.equal(result.status, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks.map(({ name, exitCode }) => [name, exitCode]), [['first', 0], ['second', 0]]);
});

test('M1.2 failures preserve exit status and output and later checks run', (t) => {
  const result = invoke(t, [{ name: 'fail', run: 'echo out; echo err >&2; exit 7' }, { name: 'later', run: 'echo done' }]);
  assert.equal(result.status, 0);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].exitCode, 7);
  assert.equal(result.checks[0].outputTail, 'out\nerr');
  assert.equal(result.checks[1].outputTail, 'done');
});

test('#203 --only selects check positions and preserves config order', (t) => {
  const checks = [
    { name: 'test', run: 'touch marker' },
    { name: 'test', run: 'exit 7' },
    { name: 'lint', run: 'test -f marker' },
  ];
  const result = invoke(t, checks, undefined, ['--only', '3,1']);
  assert.equal(result.status, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks.map(({ name }) => name), ['test', 'lint']);
});

test('#203 rejects invalid check positions and redRun values', (t) => {
  for (const only of ['', '0', '2', '1,1', 'test']) {
    const result = invoke(t, [{ name: 'test', run: 'true' }], undefined, ['--only', only]);
    assert.equal(result.status, 1);
    assert.match(result.error, /--only/);
  }
  for (const redRun of [false, ' ']) {
    const result = invoke(t, [{ name: 'test', run: 'true', redRun }]);
    assert.equal(result.status, 1);
    assert.match(result.error, /redRun/);
  }
});

test('M1.3 a one-second timeout stops sleep', (t) => {
  const result = invoke(t, [{ name: 'slow', run: 'sleep 5', timeoutSeconds: 1 }]);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].timedOut, true);
  assert.ok(result.checks[0].durationMs < 4000);
});

test('M1.4 returns the final 60 lines', (t) => {
  const result = invoke(t, [{ name: 'lines', run: 'i=1; while [ "$i" -le 75 ]; do echo "$i"; i=$((i+1)); done' }]);
  assert.deepEqual(result.checks[0].outputTail.split('\n'), Array.from({ length: 60 }, (_, i) => String(i + 16)));
});

test('M1.5 missing or invalid configuration fails closed', (t) => {
  for (const raw of [null, '{', '{}', '{"checks":[{"name":"bad","run":"true","timeoutSeconds":0}]}']) {
    const result = invoke(t, [], raw);
    assert.equal(result.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.error, /config/i);
  }
});

test('M1.6 the engine maps check JSON and attributes QA failures', async () => {
  const fixturePath = path.join(__dirname, 'engine.test.cjs');
  const fixture = fs.readFileSync(fixturePath, 'utf8').split(/^test\(/m)[0];
  const { run, BASE } = new Function('require', '__dirname', fixture + '\nreturn { run, BASE };')(require, __dirname);
  let first = true;
  const { rep, calls } = await run({ ...BASE, issues: [1] }, {
    qaFiles: ['tests/a.test.cjs'],
    agentResult(prompt, { label }) {
      if (!label.startsWith('check')) return;
      assert.match(prompt, /node "\/plugin\/bin\/devflow-run" check/);
      if (!first) return { ok: true, passed: true, checks: [] };
      first = false;
      return { ok: true, passed: false, checks: [{ name: 'test', exitCode: 1, timedOut: false, outputTail: 'tests/a.test.cjs: failed' }] };
    },
  });
  assert.equal(rep[0].status, 'pr');
  assert.match(calls.find(({ l }) => l.startsWith('qa-fix')).prompt, /tests\/a\.test\.cjs: failed/);
});

test('M1.7 timeoutSeconds is an optional positive integer with a default', (t) => {
  const schema = require('../skills/init/templates/devflow.schema.json');
  const item = schema.properties.checks.items;
  assert.deepEqual(item.required, ['name', 'run']);
  const { type, minimum, default: seconds } = item.properties.timeoutSeconds;
  assert.deepEqual({ type, minimum, seconds }, { type: 'integer', minimum: 1, seconds: 600 });
  assert.equal(invoke(t, [{ name: 'legacy', run: 'true' }]).passed, true);
});

test('M1.8 setup emits the rule for the installed CLI', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/devflow-setup'), 'allow'], { input: '{}', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).permissions.allow.includes(`Bash(node "${bin}":*)`));
});
