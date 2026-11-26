'use strict';
// #183: the unattended autopilot loop must run every tick, every command it runs must be allowed, and a PR waiting for
// its merge must be reported instead of dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const frontmatter = (text) => (/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text) || [])[1] || '';
const BIN = path.join(ROOT, 'bin');
const CFG = { github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: [] };

// U1
test('U1 autopilot can be run by a /loop prompt, and only by the user or that prompt', () => {
  const head = frontmatter(read('skills/autopilot/SKILL.md'));
  assert.doesNotMatch(head, /disable-model-invocation/);
  const description = (/^description: (.*)$/m.exec(head) || [])[1] || '';
  assert.match(description, /\/loop/);
  assert.match(description, /never on your own/i);
});

// U2
test('U2 the autopilot digest step reads the report skill file instead of invoking /devflow:report', () => {
  const skill = read('skills/autopilot/SKILL.md');
  assert.match(skill, /skills\/report\/SKILL\.md/);
  assert.doesNotMatch(skill, /using `\/devflow:report --daily/);
});

// U3
test('U3 the lane rule matches numbered lanes', () => {
  const { allowRules } = require('../bin/devflow-setup');
  const allow = allowRules(CFG);
  assert.ok(allow.includes('Bash(claude --bg --name devflow-lane-*)'), 'lane rule');
  assert.ok(!allow.some((r) => r.includes('devflow-lane-:*')), 'no word-boundary lane rule');
  assert.ok(!allow.includes('Bash(claude:*)') && !allow.includes('Bash(claude --bg:*)'), 'no broad claude rule');
  const withDir = allowRules({ ...CFG, dispatch: { pluginDir: '/p/devflow' } });
  assert.ok(withDir.includes('Bash(claude --bg --plugin-dir /p/devflow --name devflow-lane-*)'));
});

// U4
test('U4 the allow list covers claude --version, claude agents --json, devflow-gh and devflow-scan', () => {
  const { allowRules } = require('../bin/devflow-setup');
  const allow = allowRules(CFG);
  assert.ok(allow.includes('Bash(claude --version)'));
  assert.ok(allow.includes('Bash(claude agents --json:*)'));
  for (const bin of ['devflow-gh', 'devflow-scan']) assert.ok(allow.includes(`Bash(node "${path.join(BIN, bin)}":*)`), bin);
});

// U5
test('U5 the skills run the commands the allow list covers', () => {
  const autopilot = read('skills/autopilot/SKILL.md');
  assert.match(autopilot, /claude agents --json/);
  assert.doesNotMatch(autopilot, /`claude agents`/);
  assert.match(read('skills/next-task/SKILL.md'), /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/devflow-gh"/);
});

// U6
test('U6 a child in review is reported as waiting for its merge, never dispatched', () => {
  const { planTick } = require('../bin/devflow-autopilot');
  const result = planTick({
    now: '2026-11-26T10:00:00Z', autoReady: 'all',
    children: [
      { number: 8, state: 'open', labels: ['agent:review', 'risk:high'], body: '', hotspots: [], dependsOn: [], lastActivity: null,
        pr: { number: 21, state: 'open', merged: false, aheadBy: 4 } },
      { number: 9, state: 'open', labels: ['agent:review'], body: '', hotspots: [], dependsOn: [], lastActivity: null, pr: null },
    ],
  });
  assert.deepEqual(result.dispatch, []);
  const byIssue = Object.fromEntries(result.waiting.map((w) => [w.issue, w.reason]));
  assert.match(byIssue[8] || '', /PR #21 in review/);
  assert.match(byIssue[8] || '', /merge/);
  assert.match(byIssue[9] || '', /in review/);
  assert.equal(result.done, false);
});
