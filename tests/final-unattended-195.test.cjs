'use strict';
// #195: unattended ticks recover stopped lanes and keep ownership through Ship.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planTick, renderPlan, parsePlan } = require('../bin/devflow-autopilot');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const autopilot = read('skills/autopilot/SKILL.md');
const loop = autopilot.split('## 3. Loop')[1].split('## 4.')[0];
const SRC = read('workflows/next-task-engine.js').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);

test('U1 only matched working sessions hold their issues', () => {
  const activity = autopilot.split(/\n\s*\n/).filter((p) => p.includes('activeIssues') || p.includes('unknownLanes')).join('\n');
  assert.match(activity, /state:\s*working/i, 'activeIssues requires state: working');
  assert.match(autopilot, /lanesStarted[^\n]*full session id|full session id[^\n]*lanesStarted/i);
  assert.match(autopilot, /`id`[^\n]*`sessionId`|`sessionId`[^\n]*`id`/);
  assert.match(autopilot, /short[^\n]*prefix|prefix[^\n]*short/i);
  const unknown = activity.slice(activity.indexOf('unknownLanes')).split(/\n\s*[-*] /)[0];
  assert.match(unknown, /working/i);
  assert.match(unknown, /devflow-lane-\*/);
  assert.match(unknown, /this repo/i);
  assert.match(unknown, /unmatched|no (?:matching |plan )?entry|not (?:in|matched)|does not match/i);
  // A failed `claude agents --json` keeps unknownLanes true (safe default: no orphan reset).
});

test('U2 the Monitor wakes on changes since it was armed', () => {
  assert.match(loop, /baseline|snapshot|record[^.]*ids/i, 'record a baseline of working session ids when arming the Monitor');
  assert.match(loop, /arm/i);
  assert.match(loop, /ids/i);
  assert.match(loop, /working/i);
  assert.match(loop, /(?:those|baseline|recorded|snapshot)[^.]*?(?:no longer|stops?|leaves?)[^.]*working/i);
  assert.match(loop, /new[^.]*devflow-lane-\*[^.]*appear/i);
});

test('U3 each tick acquires and releases the epic lock', () => {
  assert.ok(autopilot.includes('lock acquire --name autopilot-<epic> --wait 0'), 'tick must acquire the epic lock without waiting');
  assert.match(autopilot, /(?:acquired.{0,24}false|not acquired)[^.]*?(?:end|stop|exit|return)/i);
  assert.ok(autopilot.includes('lock release --name autopilot-<epic>'));
  assert.match(autopilot, /release[^.]*every (?:tick|exit)|every (?:tick|exit)[^.]*release/i);
  assert.match(autopilot, /release[^.]*error|error[^.]*release/i);
});

const now = '2026-11-26T12:00:00Z';
const child = (number, pr = null) => ({
  number, state: 'open', labels: ['agent:ready'], body: '', hotspots: [], dependsOn: [], lastActivity: null, pr,
});
const input = (children, options = {}) => ({ now, children, activeIssues: [], unknownLanes: false, ...options });

test('U4 failed launches wait for the retry window', () => {
  const old = { issue: 7, at: '2026-11-26T11:29:00Z' };
  const recent = { issue: 7, at: '2026-11-26T11:31:00Z' };
  const tick = (recentFailures, options) => planTick(input([child(7)], { recentFailures, ...options }));
  assert.deepEqual(tick([old]).dispatch, [{ issues: [7] }], 'a failure 31 minutes ago has expired');
  assert.deepEqual(tick([recent], { retryMinutes: 10 }).dispatch, [{ issues: [7] }]);
  const result = tick([recent, old]); // Latest by time, even when an older failure comes last.
  assert.deepEqual(result.dispatch, [], 'a failure 29 minutes ago still blocks dispatch');
  assert.ok(result.warnings.some((w) => w.includes('lane for #7 exited before claiming at ' + recent.at)));
  assert.deepEqual(tick([old], { retryMinutes: 60 }).dispatch, []);
});

const badOptions = [
  { recentFailures: {} },
  { recentFailures: [{ issue: -1, at: now }] },
  { recentFailures: [{ issue: 7, at: 'yesterday afternoon' }] },
  { retryMinutes: -1 },
];

test('U4b planTick rejects invalid backoff inputs', () => {
  for (const options of badOptions) {
    assert.throws(() => planTick(input([child(7)], options)), JSON.stringify(options));
  }
});

test('U4c the CLI exits 1 for invalid backoff inputs', () => {
  for (const options of badOptions) {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin/devflow-autopilot')], {
      input: JSON.stringify(input([child(7)], options)), encoding: 'utf8',
    });
    assert.ifError(run.error);
    assert.equal(run.status, 1, JSON.stringify(options));
  }
});

test('U4d isolated setup parks and reuses a dirty inactive worktree', () => {
  const setup = read('skills/next-task/SKILL.md').split('## 2b.')[1].split('## 3.')[0];
  assert.match(setup, /park --issue\s+\S+\s+--stage Setup/, 'park the kept worktree at stage Setup');
  assert.match(setup, /dirty|uncommitted/i);
  assert.match(setup, /(?:not|no|unused)[^.!?\n]*(?:cwd[^.!?\n]*working|working[^.!?\n]*cwd)|working[^.!?\n]*cwd[^.!?\n]*(?:stop|skip)/i,
    'only park a worktree that is not the cwd of a working session');
  assert.match(setup.slice(setup.indexOf('--stage Setup')), /reus/i);
});

test('U5 a ready child resumes its open PR', () => {
  // wave5-review-fixes R4 asserted the old waiting behaviour for an open PR with no run.
  const result = planTick(input([child(7, { number: 17, state: 'open', merged: false, aheadBy: 2 })]));
  assert.deepEqual(result.dispatch, [{ issues: [7] }]);
});

test('U6 only a merge into the configured base closes the child', () => {
  const merged = (number, base) => ({ number, state: 'closed', merged: true, base });
  const result = planTick(input([child(7, merged(17, 'develop')), child(8, merged(18, 'main'))], { baseBranch: 'develop' }));
  assert.deepEqual(result.close, [7], 'close the child merged into develop only');
  assert.ok(!result.dispatch.some((lane) => lane.issues.includes(7)), 'a merged child cannot be dispatched');
});

const claimId = '20261126T120000-lane-7-195';
async function runIssue(claimPresent) {
  const args = {
    config: { github: { owner: 'o', repo: 'r' }, baseBranch: 'develop', checks: [{ name: 'test', run: 'make test' }] },
    issues: [7], limit: 1, isolated: true, startBranch: '', claimId, runDate: '2026-11-26', pluginRoot: '/plugin',
  };
  const calls = [];
  const labels = ['risk:high'];
  const agent = async (prompt, o) => {
    const label = o.label;
    calls.push({ label, prompt });
    if (label === 'select issues') return { issues: [{ number: 7, title: 'Task', body: '', labels, dependsOn: [], parents: [] }], skipped: [] };
    if (label.startsWith('claim check')) return { claimPresent };
    if (label.startsWith('claim #')) return { taken: false, assignedByRun: false, labels, claims: [{ claimId, commentId: 1, createdAt: now }] };
    if (label.startsWith('branch')) return { ok: true, branch: 'feat/7-task' };
    if (label.startsWith('plan')) return { status: 'ready', plan: 'Implement the task', qaFiles: [], devFiles: ['src/x.js'], questions: [], acceptanceCriteria: 0 };
    if (label.startsWith('implement')) return { status: 'done', filesChanged: ['src/x.js'], commits: [], questions: [] };
    if (label.startsWith('check')) return { passed: true, failures: [] };
    if (label.startsWith('changed-files')) return { files: ['src/x.js'] };
    if (label.startsWith('scan')) return { scanned: true, hits: [], changedFiles: ['src/x.js'] };
    if (label.startsWith('review')) return { issueRead: true, verdict: 'pass', findings: [] };
    if (label.startsWith('ship')) return { ok: true, prNumber: 17, url: 'pr/17' };
    assert.fail('unexpected agent call: ' + label);
  };
  const report = await engine(args, agent, () => {}, () => {}, (tasks) => Promise.all(tasks.map((task) => task())));
  assert.equal(report.length, 1);
  assert.equal(report[0].issue, 7, report[0].reason);
  return { entry: report[0], calls };
}

test('U7 Ship rechecks claim ownership', async () => {
  const live = await runIssue(true);
  assert.equal(live.entry.status, 'pr', live.entry.reason);
  assert.ok(live.calls.some((c) => c.label.startsWith('ship')));
  const released = await runIssue(false);
  assert.equal(released.entry.status, 'skipped', 'an issue whose claim was released must be skipped');
  assert.match(released.entry.reason, /claim released while this run was waiting/);
  assert.ok(!released.calls.some((c) => c.label.startsWith('ship')));
  const labels = live.calls.map((c) => c.label);
  const check = labels.findIndex((label) => label.startsWith('claim check'));
  assert.ok(check > labels.findIndex((label) => label.startsWith('review')));
  assert.ok(check < labels.findIndex((label) => label.startsWith('ship')));
});

test('U8 Ship releases this run’s claim', async () => {
  const { entry, calls } = await runIssue(true);
  assert.equal(entry.status, 'pr', entry.reason);
  const ship = calls.find((c) => c.label.startsWith('ship'));
  assert.ok(ship.prompt.includes('<!-- devflow-claim-released id=' + claimId + ' -->'), 'Ship must include the released marker for this claimId');
});

test('U9 claim order compares seconds and milliseconds chronologically', async () => {
  const { pickClaimWinner } = await engine({ exports: true }, null, () => {}, () => {}, null);
  const later = { commentId: 1, claimId: 'later', createdAt: '2026-11-26T12:00:00.500Z' };
  const earlier = { commentId: 2, claimId: 'earlier', createdAt: '2026-11-26T12:00:00Z' };
  assert.equal(pickClaimWinner([later, earlier], null).claimId, 'earlier');
});

test('U10 the loop starts after preflight and schedules a wake-up on every tick exit', () => {
  const preflight = autopilot.split('## 0. Preflight')[1].split('## 1. Load')[0];
  assert.ok(preflight.includes('/loop /devflow:autopilot #<epic>'), 'start the loop after preflight, before loading the plan');
  assert.match(preflight, /outside (?:of )?a loop|not (?:already )?in a loop/i);
  assert.match(preflight, /first tick/i);
  const exits = autopilot.split(/\n\s*\n/).find((p) => p.includes('ScheduleWakeup') && /every (?:tick )?exit|all (?:tick )?exits/i.test(p));
  assert.ok(exits, 'schedule a wake-up on every exit after preflight');
  assert.match(exits, /error/i);
  assert.match(exits, /lock|acquired/i);
});

test('U11 the rendered plan keeps the 20 newest lane starts', () => {
  const lanesStarted = Array.from({ length: 25 }, (_, i) => ({
    sessionId: 'session-' + i, issues: [i + 1], startedAt: new Date(Date.parse(now) + i * 60000).toISOString(),
  }));
  const expected = lanesStarted.slice(-20);
  // plan.running lists issues held by running lanes. All 25 lanes have stopped in this case.
  const body = renderPlan({ epic: 100, children: lanesStarted.flatMap((lane) => lane.issues), lanesStarted, running: [], progress: [] });
  const saved = parsePlan(body).lanesStarted;
  assert.equal(saved.length, 20);
  assert.deepEqual(saved, expected);
});
