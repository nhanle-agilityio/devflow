'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const bin = path.join(root, 'bin', 'devflow-run');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const SRC = read('workflows/next-task-engine.js').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
const noop = () => {};
const parallel = (tasks) => Promise.all(tasks.map((task) => task()));

function ThrowingDate() { throw new Error('Workflow scripts cannot read the clock'); }
ThrowingDate.now = ThrowingDate;

async function runEngine(args, agent) {
  const realDate = globalThis.Date;
  globalThis.Date = ThrowingDate;
  try {
    return await engine(args, agent, noop, noop, parallel);
  } finally {
    globalThis.Date = realDate;
  }
}

const qaFile = 'tests/a.test.js';
const devFile = 'src/x.js';
const httpBody = '## Test cases\n\n| ID | Level | Case |\n| --- | --- | --- |\n| T1 | http | GET /health returns 200 |';
const claimId = '20261127T120000-lane-7-203';
const stageOf = (label) => label.startsWith('restore ') ? 'restore' : label.split(' #')[0];

async function runIssue({ risk = 'high', qaFiles = [qaFile], devFiles = [devFile], config = {}, replies = {} } = {}) {
  const labels = ['risk:' + risk];
  const args = {
    config: {
      github: { owner: 'o', repo: 'r' }, baseBranch: 'main',
      checks: [{ name: 'test', run: 'make test' }],
      verify: { modes: ['http'], devServer: { run: 'make serve', url: 'http://localhost:3000' } },
      ...config,
    },
    issues: [7], limit: 1, startBranch: '', isolated: true, claimId, runDate: '2026-11-27', pluginRoot: '/plugin',
  };
  const implemented = {
    status: 'done', summary: 'Added health check', commits: [], filesChanged: devFiles,
    assumptions: [], outOfScope: [], touchesUi: false, questions: [], specRead: 'none',
  };
  const defaults = {
    'select issues': {
      issues: [{ number: 7, title: 'Health check', body: httpBody, labels, parents: [], dependsOn: [] }], skipped: [],
    },
    claim: {
      taken: false, assignedByRun: false, labels, specPath: '', retryCount: 0,
      claims: [{ claimId, commentId: 1, createdAt: '2026-11-27T12:00:00Z' }],
    },
    'claim check': { claimPresent: true },
    branch: { ok: true, branch: 'feat/7-health' },
    plan: {
      status: 'ready', plan: 'Add health check', questions: [], qaFiles, devFiles,
      specRead: 'none', acceptanceCriteria: 0, httpOrE2eRows: true,
    },
    qa: { status: 'done', tests: [{ rowId: 'T1', test: 'health' }], filesChanged: qaFiles, questions: [], specRead: 'none' },
    implement: implemented,
    fix: implemented,
    'qa-fix': { ...implemented, filesChanged: qaFiles },
    commit: { ok: true, commits: ['abc test(#7): health', 'def feat(#7): health'], redConfirmed: true },
    check: { passed: true, failures: [] },
    verify: {
      ran: true, mode: 'http', notes: '',
      steps: [{ action: 'GET /health', expected: '200', actual: '200', pass: true }],
    },
    'changed-files': { ok: true, files: devFiles },
    scan: { scanned: true, hits: [], changedFiles: devFiles },
    review: { issueRead: true, verdict: 'pass', findings: [] },
    ship: { ok: true, prNumber: 17, url: 'pr/17' },
    decisions: { ok: true },
    blocked: { ok: true, pushed: false },
    'release check': { claimPresent: false },
    'release retry': { ok: true },
    release: { ok: true },
    integrate: { ok: true, integrationSha: 'abcd123', merged: [] },
    'run error': { ok: true },
    retreat: { ok: true },
    restore: { ok: true, restored: true },
  };
  const calls = [];
  const unexpected = [];
  const agent = async (prompt, o) => {
    const call = { label: o.label, prompt, model: o.model };
    calls.push(call);
    const stage = stageOf(call.label);
    if (Object.hasOwn(defaults, stage)) {
      const reply = replies[stage];
      return { ...defaults[stage], ...(typeof reply === 'function' ? reply(call) : reply) };
    }
    // The engine catches agent exceptions, so assert on unknown labels after the run.
    unexpected.push(call.label);
    return null;
  };
  const report = await runEngine(args, agent);
  assert.deepEqual(unexpected, [], 'unexpected agent labels');
  assert.deepEqual(report.map((entry) => entry.issue), [7]);
  return { entry: report[0], calls };
}

function stageCalls(run, stage) {
  return run.calls.filter(({ label }) => stageOf(label) === stage);
}

function commitPayload(run) {
  assert.equal(run.entry.status, 'pr', run.entry.reason);
  const [call] = stageCalls(run, 'commit');
  assert.ok(call, 'expected a commit call');
  const marker = 'DEVFLOW_COMMIT_JSON';
  const start = "<<'" + marker + "'\n";
  assert.ok(call.prompt.includes(start), 'missing commit payload');
  return JSON.parse(call.prompt.split(start)[1].split('\n' + marker)[0]);
}

test('S1 full low- and high-risk runs use explicit stage models', async () => {
  const mismatches = [];
  const stageModels = {
    'select issues': 'haiku', claim: 'haiku', branch: 'haiku', integrate: 'haiku',
    commit: 'haiku', check: 'haiku', scan: 'haiku', 'claim check': 'haiku',
    plan: 'sonnet', qa: 'sonnet', implement: 'sonnet', fix: 'sonnet',
  };
  for (const risk of ['low', 'high']) {
    let checks = 0;
    const run = await runIssue({
      risk,
      replies: {
        branch: { baseConflict: true, conflictFiles: [devFile] },
        check: () => ++checks === 1 ? { passed: false, failures: [{ check: 'test', output: 'failed' }] } : {},
      },
    });
    assert.equal(run.entry.status, 'pr', run.entry.reason);
    assert.equal(run.entry.risk, risk);
    for (const stage of [...Object.keys(stageModels), 'verify', 'review', 'ship']) {
      assert.ok(stageCalls(run, stage).length, `risk:${risk} must reach ${stage}`);
    }
    const fixIndex = run.calls.indexOf(stageCalls(run, 'fix')[0]);
    assert.ok(run.calls.indexOf(stageCalls(run, 'check')[0]) < fixIndex);
    assert.ok(run.calls.indexOf(stageCalls(run, 'check')[1]) > fixIndex);
    for (const { label, model } of run.calls) {
      assert.ok(['haiku', 'sonnet', 'opus'].includes(model), `risk:${risk} ${label} needs an explicit model`);
      if (model === 'opus') assert.ok(risk === 'high' && label.startsWith('review'), `unexpected Opus call: risk:${risk} ${label}`);
      const stage = stageOf(label);
      const want = stage === 'review' ? (risk === 'high' ? 'opus' : 'sonnet') : stageModels[stage];
      if (want && model !== want) mismatches.push(`risk:${risk} ${label}: expected ${want}, got ${model}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('S2a the commit payload expands redRun with shell-quoted QA paths', async () => {
  const qaFiles = ['tests/test_a.py', 'tests/b c.py'];
  const config = { checks: [{ name: 'test', run: 'make test', redRun: 'make db-reset && uv run pytest -q {files}' }] };
  const payload = commitPayload(await runIssue({ qaFiles, config }));
  assert.deepEqual(payload.qaFiles, qaFiles);
  assert.equal(payload.testCommand, "make db-reset && uv run pytest -q tests/test_a.py 'tests/b c.py'");
});

function tempRepo(t, config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-203-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);

  function git(...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }

  function write(file, contents) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  git('init', '-b', 'main');
  git('config', 'user.name', 'Devflow Test');
  git('config', 'user.email', 'devflow@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write('.claude/devflow.json', JSON.stringify({ baseBranch: 'main', ...config }));
  write('focused.sh', 'echo "focused red check"\nsh qa.sh focused\n');
  git('add', '--', '.claude/devflow.json', 'focused.sh');
  git('commit', '-m', 'initial config and focused runner');
  git('switch', '-c', 'feat/7-health');
  return { cwd, write };
}

test('S2b devflow-run commit confirms red using the configured focused command', async (t) => {
  const config = { checks: [{ name: 'test', run: 'sh qa.sh', redRun: 'sh focused.sh' }] };
  // Exercise the generated payload all the way through the real commit runner.
  const payload = commitPayload(await runIssue({ qaFiles: ['qa.sh'], devFiles: ['impl.txt'], config }));
  const repo = tempRepo(t, config);
  // The regular check is green. The focused invocation requires the implementation.
  repo.write('qa.sh', 'if [ "${1-}" = focused ]; then test -f impl.txt; fi\n');
  repo.write('impl.txt', 'implemented\n');

  const result = spawnSync(process.execPath, [bin, 'commit'], {
    cwd: repo.cwd, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.redConfirmed, true, `expected sh focused.sh to fail at the test commit (payload ran ${payload.testCommand})`);
  assert.match(out.redOutput, /focused red check/);
});

test('S2c both schemas define checks[].redRun as a string', () => {
  const template = read('skills/init/templates/devflow.schema.json');
  assert.equal(template, read('.claude/devflow.schema.json'));
  assert.equal(JSON.parse(template).properties.checks.items.properties.redRun?.type, 'string');
});

test('S3 Verify and Ship use the model for the issue risk', async () => {
  const actual = {};
  for (const risk of ['low', 'high']) {
    const run = await runIssue({ risk });
    assert.equal(run.entry.status, 'pr', run.entry.reason);
    assert.equal(run.entry.risk, risk);
    actual[risk] = ['verify', 'ship'].map((stage) => {
      const [call] = stageCalls(run, stage);
      assert.ok(call, `risk:${risk} must reach ${stage}`);
      return call.model;
    });
  }
  assert.deepEqual(actual, { low: ['haiku', 'haiku'], high: ['sonnet', 'sonnet'] });
});

const checks = [{ name: 'test', run: 'make test' }, { name: 'lint', run: 'make lint' }];

function promptedChecks(prompt) {
  if (prompt.includes('/bin/devflow-run" check`')) return checks.map(({ name }) => name);
  return checks.filter(({ run }) => prompt.includes(run)).map(({ name }) => name);
}

async function runCheckRound(testStillFails) {
  let runs = 0;
  return runIssue({
    config: { checks, nextTask: { maxFixRounds: 1 } },
    replies: {
      check: ({ prompt }) => {
        const testFails = ++runs === 1 || testStillFails;
        const results = promptedChecks(prompt).map((name) => {
          const failed = name === 'test' && testFails;
          return { name, exitCode: failed ? 1 : 0, timedOut: false, outputTail: failed ? 'test failure' : '' };
        });
        return { ok: true, passed: results.every(({ exitCode }) => exitCode === 0), checks: results };
      },
    },
  });
}

function checkRoundAfterFix(run) {
  const [initial, retried] = stageCalls(run, 'check');
  const [fix] = stageCalls(run, 'fix');
  assert.ok(initial && fix && retried, 'expected a check, a fix and a check retry');
  assert.ok(run.calls.indexOf(initial) < run.calls.indexOf(fix));
  assert.ok(run.calls.indexOf(fix) < run.calls.indexOf(retried));
  assert.deepEqual(promptedChecks(initial.prompt), ['test', 'lint']);
  return stageCalls(run, 'check').slice(1);
}

// After a fix the failed check runs first; when it passes only the checks not yet passed this round run (each check
// passes at least once after the last code change before review, without running the test suite twice).
test('S4 a passing focused retry is followed by the remaining checks before review', async () => {
  const run = await runCheckRound(false);
  assert.equal(run.entry.status, 'pr', run.entry.reason);
  const afterFix = checkRoundAfterFix(run);
  assert.deepEqual(afterFix.map(({ prompt }) => promptedChecks(prompt)), [['test'], ['lint']]);
  const [review] = stageCalls(run, 'review');
  assert.ok(review && run.calls.indexOf(afterFix[1]) < run.calls.indexOf(review));
});

test('S4 a failing focused retry skips lint for that fix round', async () => {
  const run = await runCheckRound(true);
  const afterFix = checkRoundAfterFix(run);
  assert.match(run.entry.reason, /Checks still failing after 1 fix round/);
  assert.deepEqual(stageCalls(run, 'review'), []);
  assert.deepEqual(stageCalls(run, 'ship'), []);
  assert.deepEqual(afterFix.map(({ prompt }) => promptedChecks(prompt)), [['test']]);
});
