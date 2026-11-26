'use strict';
// #192: claims are released by editing (the GitHub MCP server cannot delete comments), stale claims never win because
// of a quoted timestamp, and autopilot recovers an in-progress issue that no lane works on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ENGINE = read('workflows/next-task-engine.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const RELEASED = '<!-- devflow-claim-released id=';

async function helpers() {
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', ENGINE.replace(/^export /m, ''));
  return fn({ exports: true }, null, () => {}, () => {}, null);
}

// C1
test('C1 pickClaimWinner ignores a claim older than a quoted lastBlockedAt and reads quoted createdAt', async () => {
  const { pickClaimWinner } = await helpers();
  const old = { commentId: 1, claimId: 'old', createdAt: '2026-11-26T09:25:48Z' };
  const fresh = { commentId: 2, claimId: 'new', createdAt: '"2026-11-26T15:23:02Z"' };
  assert.equal(pickClaimWinner([old, fresh], '"2026-11-26T09:29:52Z"').claimId, 'new');
  assert.equal(pickClaimWinner([old, fresh], ' 2026-11-26T09:29:52.000Z ').claimId, 'new');
  assert.equal(pickClaimWinner([old, fresh], null).claimId, 'old');
  assert.equal(pickClaimWinner([old, fresh], 'none').claimId, 'old', 'no timestamp counts as missing');
});

// C2
test('C2 the engine releases claims by editing them to the released marker, never by deleting', () => {
  assert.doesNotMatch(ENGINE, /Delete only the comment\(s\) on the issue whose body contains "<!-- devflow-claim id=/);
  assert.doesNotMatch(ENGINE, /Delete the comment\(s\) whose body contains "<!-- devflow-claim id=/);
  assert.doesNotMatch(ENGINE, /Delete only comments on \$\{target\} whose bodies contain/);
  assert.ok(ENGINE.split(RELEASED).length - 1 >= 3, 'blocked cleanup, lost race and release retry use the released marker');
  assert.match(ENGINE, /update_issue_comment/);
});

// C3
test('C3 answer and doctor release claims by editing', () => {
  const answer = read('skills/answer/SKILL.md');
  assert.doesNotMatch(answer, /Delete every comment on the issue that contains `<!-- devflow-claim id=`/);
  assert.ok(answer.includes(RELEASED));
  const doctor = read('skills/doctor/SKILL.md');
  const c14 = /^14\. \*\*Stale claims\.\*\*.*$/m.exec(doctor)[0];
  assert.doesNotMatch(c14, /delete only the listed claim comments/);
  assert.ok(c14.includes(RELEASED));
});

// C4
const now = '2026-11-26T16:00:00Z';
const child = (number, labels, lastActivity) => ({ number, state: 'open', labels, body: '', hotspots: [], dependsOn: [], lastActivity, pr: null });
const tick = (children, extra = {}) => require('../bin/devflow-autopilot').planTick({ now, autoReady: 'all', children, ...extra });

test('C4 planTick reports an in-progress issue with no working lane as orphaned', () => {
  const stale = child(10, ['agent:in-progress'], '2026-11-26T15:23:02Z');
  const orphan = tick([stale], { activeIssues: [], unknownLanes: false });
  assert.deepEqual(orphan.orphaned, [10]);
  assert.ok(!orphan.running.includes(10), 'not counted as running');

  assert.deepEqual(tick([stale], { activeIssues: [10], unknownLanes: false }).orphaned, []);
  assert.deepEqual(tick([stale], { activeIssues: [], unknownLanes: true }).orphaned, []);
  assert.deepEqual(tick([stale]).orphaned, [], 'off unless unknownLanes is false');
  const recent = child(10, ['agent:in-progress'], '2026-11-26T15:50:00Z');
  assert.deepEqual(tick([recent], { activeIssues: [], unknownLanes: false }).orphaned, [], 'recent activity');
  assert.deepEqual(tick([recent], { activeIssues: [], unknownLanes: false, orphanMinutes: 5 }).orphaned, [10]);
});

test('C4b an orphaned issue frees its lane slot', () => {
  const kids = [child(10, ['agent:in-progress'], '2026-11-26T15:00:00Z'), child(20, ['agent:ready'], null)];
  assert.deepEqual(tick(kids, { maxLanes: 1 }).dispatch, [], 'slot taken while counted as running');
  assert.deepEqual(tick(kids, { maxLanes: 1, activeIssues: [], unknownLanes: false }).dispatch, [{ issues: [20] }]);
});

// C5
test('C5 the autopilot skill passes lane activity and resets orphaned issues', () => {
  const skill = read('skills/autopilot/SKILL.md');
  assert.match(skill, /activeIssues/);
  assert.match(skill, /unknownLanes/);
  assert.match(skill, /orphaned/);
  assert.ok(skill.includes(RELEASED), 'releases claims by editing');
  assert.match(skill, /labels\.inProgress[^.\n]*labels\.ready|in-progress[^.\n]*ready/);
});
