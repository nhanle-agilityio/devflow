'use strict';
// #186: doctor --fix check 8 must not leave .claude/settings.json uncommitted (autopilot, accept, next-task and
// dispatch stop on a dirty tree); it writes the rules on a branch, opens a PR and lists the current rule set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'doctor', 'SKILL.md'), 'utf8');
const check = (n) => {
  const m = new RegExp(`^${n}\\. \\*\\*[^\\n]*(?:\\n(?!\\d+\\. \\*\\*|## )[^\\n]*)*`, 'm').exec(skill);
  assert.ok(m, `check ${n} exists`);
  return m[0];
};

// G1
test('G1 check 8 --fix writes the rules on a branch, commits, opens a PR and switches back', () => {
  const c8 = check(8);
  assert.match(c8, /chore\/devflow-allow-rules-<version>/);
  assert.match(c8, /<remote>\/<baseBranch>/);
  assert.match(c8, /chore\(devflow\): allow rules for devflow <version>/);
  assert.match(c8, /labels\.devflow/);
  assert.match(c8, /labels\.riskHigh/);
  assert.match(c8, /compare/);
  assert.match(c8, /back to the starting branch/i);
});

// G2
test('G2 check 8 --fix needs a clean tree and commits only .claude/settings.json', () => {
  const c8 = check(8);
  assert.match(c8, /git status --porcelain/);
  assert.match(c8, /only `\.claude\/settings\.json`/);
  assert.match(c8, /clean/i);
});

// G3
test('G3 check 8 --fix removes stale devflow rules and nothing else', () => {
  const c8 = check(8);
  assert.match(c8, /older plugin version/i);
  assert.match(c8, /`Bash\(claude --bg[^`]*devflow-lane-:\*\)`/);
  assert.match(c8, /never removes? any other rule/i);
});

// G4
test('G4 check 8 lists the current rule set', () => {
  const c8 = check(8);
  for (const s of ['devflow-lane-*)', 'Bash(claude --version)', 'Bash(claude agents --json:*)', 'devflow-gh', 'devflow-scan']) {
    assert.ok(c8.includes(s), s);
  }
  assert.ok(!/lane-session rule `Bash\(claude --bg --name devflow-lane-:\*\)`/.test(c8), 'no outdated lane rule as the rule to add');
});

// G5
test('G5 check 6 uses claude agents --json', () => {
  assert.match(check(6), /claude agents --json/);
});

// G6
test('G6 the report says to merge the PR and pull before autopilot or dispatch', () => {
  const report = skill.slice(skill.indexOf('## Report'));
  assert.match(report, /git pull/);
  assert.match(report, /autopilot/);
  assert.match(report, /dispatch/);
});
