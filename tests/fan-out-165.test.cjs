'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { planLanes } = require('../bin/devflow-lanes');

const iss = (number, hotspots = [], dependsOn = []) => ({ number, hotspots, dependsOn });
const plan = (issues) => planLanes({ maxLanes: 4, issues });
const laneIssues = (result) => result.lanes.map((lane) => lane.issues);
const readSource = (...parts) => readFileSync(join(__dirname, '..', ...parts), 'utf8');

test('A2.1 siblings with distinct hotspots are stacked separately on their parent', () => {
  const result = plan([
    iss(4, ['d.js'], [1]),
    iss(1, ['a.js']),
    iss(3, ['c.js'], [1]),
    iss(2, ['b.js'], [1]),
  ]);

  assert.deepEqual(laneIssues(result), [[1]]);
  assert.deepEqual(result.stacked, [
    { issue: 2, on: [1] },
    { issue: 3, on: [1] },
    { issue: 4, on: [1] },
  ]);
});

test('A2.2 a linear link keeps the parent first and leaves stacked empty', () => {
  const result = plan([iss(1, [], [5]), iss(5), iss(2)]);

  assert.deepEqual(laneIssues(result), [[5, 1], [2]]);
  assert.deepEqual(result.stacked, []);
});

test('A2.3 a shared hotspot keeps a child in the parent lane', () => {
  // The child's lower issue number makes dependency ordering observable.
  for (const parent of [1, 4]) {
    const result = plan([iss(2, ['a.js'], [parent]), iss(3, ['b.js'], [parent]), iss(parent, ['a.js'])]);

    assert.deepEqual(laneIssues(result), [[parent, 2]]);
    assert.deepEqual(result.stacked, [{ issue: 3, on: [parent] }]);
  }
});

test('A2.4 a child with two parents is stacked on both in issue order', () => {
  const result = plan([iss(3, [], [2, 1]), iss(2), iss(1)]);

  assert.deepEqual(laneIssues(result), [[1], [2]]);
  assert.deepEqual(result.stacked, [{ issue: 3, on: [1, 2] }]);
});

test('A2.5 output always includes stacked and help documents it', async (t) => {
  await t.test('empty and independent inputs return stacked alongside existing output', () => {
    for (const issues of [[], [iss(1)]]) {
      const result = plan(issues);
      assert.deepEqual(Object.keys(result).sort(), [
        'deferred', 'ignoredHotspots', 'lanes', 'stacked', 'warnings',
      ]);
      assert.deepEqual(result.stacked, []);
    }
  });

  await t.test('--help mentions stacked', () => {
    const help = execFileSync(process.execPath, [join(__dirname, '..', 'bin', 'devflow-lanes'), '--help'], {
      encoding: 'utf8',
    });
    assert.match(help, /\bstacked\b/i);
  });
});

test('A2.6 a three-issue linear chain stays in one lane', () => {
  const result = plan([iss(3, [], [2]), iss(2, [], [1]), iss(1)]);

  assert.deepEqual(laneIssues(result), [[1, 2, 3]]);
});

test('A2.7 the approval sweep accepts qualifying open dependencies at either parent risk', () => {
  const skill = readSource('skills', 'approve', 'SKILL.md');
  const sweep = skill.split(/^## /m).find((section) => section.startsWith('Eligibility sweep\n'));
  assert.ok(sweep, 'approval documents the eligibility sweep');
  const dependencyRule = sweep.match(/Depends on[\s\S]*/i)?.[0] ?? '';

  assert.match(dependencyRule, /\bopen (?:dependency|issue|parent)\b|\b(?:dependency|issue|parent)\b[^.\n]*\bis open\b/i,
    'the dependency rule covers an open parent');
  assert.match(dependencyRule, /\bopen PR\b/i, 'an open parent can qualify through an open PR');
  assert.match(dependencyRule, /\b(?:at least one|at least 1|one or more|1 or more)\s+commits?\s+ahead of (?:the )?base\b/i);
  assert.match(dependencyRule, /labels\.blocked/);
  assert.match(dependencyRule, /waits for #(?:<n>|n)/i);
  for (const reason of ['(blocked)', '(no PR yet)', '(PR closed without merge)']) {
    assert.ok(dependencyRule.includes(reason), 'missing wait reason ' + reason);
  }
  assert.match(dependencyRule, /\b(?:parent|dependency)(?:['’]s)?\s+risk\s+(?:does not matter|does not affect|is irrelevant)|\bregardless of (?:the )?(?:parent|dependency)(?:['’]s)?\s+risk/i);
});

test('A2.8 dispatch reports planner-stacked issues without starting sessions for them', () => {
  const skill = readSource('skills', 'dispatch', 'SKILL.md');
  const stackedReport = skill.split(/\n\s*\n/).find((paragraph) =>
    /\bstacked\b/i.test(paragraph) && /starts when #(?:p|<p>) has an open PR/i.test(paragraph));

  assert.ok(stackedReport, 'dispatch reports stacked output as "starts when #p has an open PR"');
  assert.match(stackedReport, /\b(?:starts? no sessions?|no sessions? (?:starts?|(?:is|are) started)|(?:do(?:es)? not|never) start (?:a |any )?sessions?)\b/i);
});

test('A2.9 autoReadyAfterMerge still waits for dependencies to close', () => {
  const source = readSource('skills', 'init', 'templates', 'github', 'scripts', 'devflow-merge-gate.cjs');
  const autoReady = source.match(/^async function autoReadyAfterMerge\b[\s\S]*?^}/m);
  assert.ok(autoReady, 'the merge gate defines autoReadyAfterMerge');
  assert.match(autoReady[0], /if\s*\([^)\n]*\bdependency\.state\s*!==\s*['"]closed['"][^)\n]*\)\s*{\s*waiting\s*=\s*true\b/);
});
