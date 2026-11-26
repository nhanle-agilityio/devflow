'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const cli = join(root, 'bin', 'devflow-autopilot');
const read = (file) => readFileSync(join(root, file), 'utf8');
const readSkill = () => read('skills/autopilot/SKILL.md');
const now = '2026-11-26T10:00:00Z';
const marker = '<!-- devflow-autopilot-plan -->';

function child(number, overrides = {}) {
  const { dependsOn = [], body = '', ...fields } = overrides;
  return {
    number, state: 'open', labels: [], hotspots: [], dependsOn, pr: null, lastActivity: now,
    body: [...dependsOn.map((n) => `Depends on #${n}`), body].join('\n'), ...fields,
  };
}

const readyChild = (number) => child(number, { labels: ['agent:ready'] });
const openPR = (number, aheadBy = 1) => ({ number, state: 'open', merged: false, aheadBy });
const tick = (children, options = {}) => require(cli).planTick({ now, children, ...options });

test('A1.1 the eligibility sweep readies satisfied children and explains body holds', () => {
  const result = tick([
    child(15, { dependsOn: [11], body: '## Open questions\nNone\n## Scope\nShip it.' }),
    child(14, { body: 'Summary\nReady: manual\n' }),
    child(13, { dependsOn: [10], body: '<!--\nReady: manual\n-->\n## Open questions\n<!-- draft -->' }),
    child(12, { body: '## Open questions\nWhich format should we use?' }),
    child(11, { labels: ['agent:review'], pr: openPR(40) }),
    child(10, { state: 'closed' }),
  ], { autoReady: 'all' });

  assert.deepEqual(result.ready, [13, 15]);
  assert.deepEqual(result.dispatch, [{ issues: [13] }, { issues: [15] }]);
  for (const [issue, reason] of [[14, 'Ready: manual'], [12, 'open questions']]) {
    assert.deepEqual(result.waiting.find((entry) => entry.issue === issue), { issue, reason });
  }
});

test('A1.2 two running children leave one free lane and cannot be dispatched again', () => {
  const children = [
    child(1, { labels: ['agent:ready', 'agent:in-progress'] }),
    child(2, { labels: ['agent:in-progress'] }),
    readyChild(3), readyChild(4), readyChild(5),
  ];
  const result = tick(children, { maxLanes: 3 });
  assert.deepEqual([...result.running].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(result.dispatch, [{ issues: [3] }]);
  assert.deepEqual(tick(children, { maxLanes: 1 }).dispatch, []);
});

test('A1.3 a ready child starts its own lane once the parent PR is ahead', () => {
  const result = tick([
    child(11, { labels: ['agent:ready'], pr: openPR(30) }),
    child(12, { labels: ['agent:ready'], dependsOn: [11] }),
  ]);
  assert.deepEqual(result.dispatch, [{ issues: [12] }]);
  assert.deepEqual(result.stacked, []);
});

test('A1.4 an epic with every child closed is done and has no work to report', () => {
  const result = tick([
    child(11, { state: 'closed', labels: ['agent:ready'] }),
    child(12, { state: 'closed', labels: ['agent:in-progress'], lastActivity: '2026-11-24T10:00:00Z' }),
  ], { autoReady: 'all', nextTaskMaxAgentCalls: 40 });
  assert.equal(result.done, true);
  for (const field of ['ready', 'running', 'dispatch', 'stacked', 'waiting', 'stalled', 'warnings']) {
    assert.deepEqual(result[field], [], field);
  }
});

test('A1.5 the agent budget limits three runnable lanes to one', () => {
  const children = [readyChild(1), readyChild(2), readyChild(3)];
  const result = tick(children, { agentCallsUsed: 19, maxAgentCallsPerTick: 20 });
  assert.deepEqual(result.dispatch, [{ issues: [1] }]);
  assert.ok(result.warnings.some((warning) => /agent budget/i.test(warning)));
  assert.equal(result.budgetLeft, 0);

  const exhausted = tick(children, { agentCallsUsed: 21, maxAgentCallsPerTick: 20 });
  assert.deepEqual(exhausted.dispatch, []);
  assert.equal(exhausted.budgetLeft, 0);
});

test('A1.6 repeated ticks are pure and skip relabelling already-ready children', () => {
  const { planTick } = require(cli);
  const state = { now, autoReady: 'all', children: [
    child(3, { hotspots: ['README.md'] }),
    child(2, { hotspots: ['README.md', 'a.js'] }),
    child(1, { hotspots: ['a.js'], labels: ['agent:ready'] }),
  ] };
  const original = structuredClone(state);
  const first = planTick(state);
  assert.deepEqual(planTick(state), first);
  assert.deepEqual(state, original);
  assert.equal(first.done, false);
  assert.deepEqual(first.ready, [2, 3]);
  assert.deepEqual(first.dispatch, [{ issues: [1, 2] }, { issues: [3] }]);
  assert.equal(first.budgetLeft, 18);
  assert.deepEqual(planTick({ ...state, ignoreHotspots: [] }).dispatch, [{ issues: [1, 2, 3] }]);
});

test('A1.7 the marked plan round-trips as fenced JSON followed by a progress table', () => {
  const { PLAN_MARKER, parsePlan, renderPlan } = require(cli);
  const plan = { epic: 10, children: [11, 12], lanesStarted: 1, lastTick: now, lastDigestDate: '2026-11-25' };
  assert.equal(PLAN_MARKER, marker);
  const body = renderPlan(plan);
  assert.ok(body.startsWith(marker));
  const block = /^\s*```json\s*\n([\s\S]*?)\r?\n```([\s\S]*)$/.exec(body.slice(marker.length));
  assert.ok(block, 'the marker is followed by fenced JSON');
  assert.deepEqual(JSON.parse(block[1]), plan);
  assert.match(block[2], /^\s*\|?\s*:?-+:?\s*\|\s*:?-+:?/m, 'a Markdown table follows the JSON');
  assert.deepEqual(parsePlan(body), plan);
  assert.equal(parsePlan(body.slice(marker.length)), null);
  assert.equal(parsePlan(marker + '\n```json\n{broken}\n```'), null);
});

test('A1.8 a running child stalls only after twelve hours and stays out of dispatch', () => {
  const children = [
    child(2, { labels: ['agent:in-progress'], lastActivity: '2026-11-25T22:00:00Z' }),
    child(1, { labels: ['agent:in-progress'], lastActivity: '2026-11-25T21:00:00Z' }),
  ];
  const result = tick(children, { stallHours: 12 });
  assert.deepEqual(result.stalled, [1]);
  assert.deepEqual(result.dispatch, []);
  assert.deepEqual(tick(children, { now: '2026-11-26T11:00:00Z' }).stalled, [1, 2]);
});

test('A1.9 the skill documents the ordered tick, trusted comments and loop lifecycle', () => {
  const skill = readSkill();
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  assert.ok(header, 'skill has frontmatter');
  assert.match(header[1], /^name: autopilot$/m);
  assert.match(header[1], /^disable-model-invocation: true$/m);
  assert.match(header[1], /^argument-hint: .*#<epic>/m);
  const body = skill.slice(header[0].length);
  assert.match(body, /\bsync\b[\s\S]*?\bcomments\b[\s\S]*?\bready\b[\s\S]*?\bdispatch\b[\s\S]*?\breport\b/i);
  for (const term of ['OWNER', 'MEMBER', 'COLLABORATOR', 'bin/devflow-autopilot', marker, 'labels.inProgress']) {
    assert.ok(body.includes(term), `skill must include ${term}`);
  }
  assert.match(body, /\/loop\s+\/devflow:autopilot\s+#<epic>/);
  assert.match(body, /\b(?:stop|end|cancel|terminate)s?\b[^.\n]*\bloop\b|\bloop\b[^.\n]*\b(?:stops|ends)\b/i);
  assert.match(body, /final (?:progress )?report/i);
  assert.match(skill, /\b(?:never|do not)\s+merges?\b/i);
  assert.match(skill, /\b(?:never|do not)\b[^.\n]*\bpush(?:es)?\b[^.\n]*\bprotected\b/i);
});

// Check required and declared keys as in approve.test.cjs, descending into the
// config so numeric constraints are tested against the supplied values too.
function accepts(schema, value) {
  const type = Array.isArray(value) ? 'array' : typeof value;
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return false;
  } else if (schema.type && schema.type !== type) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === 'number') return value >= (schema.minimum ?? -Infinity) && value > (schema.exclusiveMinimum ?? -Infinity);
  if (type === 'string') return value.length >= (schema.minLength ?? 0);
  if (type === 'array') return value.length >= (schema.minItems ?? 0) && value.every((item) => accepts(schema.items, item));
  if (type === 'object') {
    return value !== null && (schema.required || []).every((key) => Object.hasOwn(value, key)) &&
      Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties, key)
        ? accepts(schema.properties[key], item) : schema.additionalProperties !== false);
  }
  return true;
}

test('A1.10 the schema accepts legacy and autopilot configs and rejects a zero call budget', () => {
  const schema = require('../skills/init/templates/devflow.schema.json');
  const legacy = {
    devflowVersion: '3.1.0', github: { owner: 'acme', repo: 'shop' }, baseBranch: 'main',
    checks: [{ name: 'test', run: 'make test' }], spec: { autoReady: 'low' },
  };
  const autopilot = { maxLanes: 1, maxAgentCallsPerTick: 1, stallHours: 0.5 };
  assert.ok(accepts(schema, legacy), 'a 3.1.0 config without autopilot stays valid');
  assert.ok(accepts(schema, { ...legacy, autopilot }), 'schema must accept the autopilot block');
  for (const invalid of [{ maxAgentCallsPerTick: 0 }, { maxAgentCallsPerTick: 1.5 }, { maxLanes: 0 },
    { maxLanes: 1.5 }, { stallHours: 0 }, { typo: true }]) {
    assert.equal(accepts(schema, { ...legacy, autopilot: { ...autopilot, ...invalid } }), false, JSON.stringify(invalid));
  }
  const definition = schema.properties.autopilot;
  assert.equal(definition.type, 'object');
  assert.equal(definition.additionalProperties, false);
  assert.equal(definition.properties.maxAgentCallsPerTick.default, 20);
  assert.equal(definition.properties.stallHours.default, 12);
  const example = read('skills/init/templates/devflow.json').match(/^\s*"autopilot"\s*:\s*\{([^}]+)\}/m);
  assert.ok(example, 'the annotated config shows the autopilot block');
  for (const key of Object.keys(autopilot)) assert.ok(example[1].includes(`"${key}"`), key);
});

test('A1.11 an unlimited next-task budget produces a warning and a finite budget clears it', () => {
  const warns = (options) => tick([readyChild(1)], options).warnings.some((w) => w.includes('nextTask.maxAgentCalls'));
  assert.equal(warns({ nextTaskMaxAgentCalls: 0 }), true);
  assert.equal(warns({}), true);
  assert.equal(warns({ nextTaskMaxAgentCalls: 40 }), false);
});

test('A1.12 the skill stops on a missing epic approval and directs the user to approve it', () => {
  const section = readSkill().split(/^#{1,6} /m).find((s) => s.includes('labels.epicApproved') && s.includes('/devflow:approve'));
  assert.ok(section, 'the epic approval check names /devflow:approve');
  assert.match(section, /\b(?:absent|missing|lacks?|without|unless|not|no|unapproved|otherwise)\b/i);
  assert.match(section, /\b(?:stop|exit|abort|refuse|return)s?\b/i);
});

test('A1.13 low risk policy holds high risk work and off holds every eligible child', () => {
  const children = [child(1, { labels: ['risk:high'] }), child(2, { labels: ['risk:low'] })];
  const low = tick(children, { autoReady: 'low' });
  assert.deepEqual(low.ready, [2]);
  assert.deepEqual(low.waiting, [{ issue: 1, reason: 'high risk (spec.autoReady: low)' }]);
  for (const options of [{ autoReady: 'off' }, {}]) {
    const off = tick(children, options);
    assert.deepEqual(off.ready, []);
    assert.deepEqual(off.dispatch, []);
    for (const { number } of children) {
      assert.deepEqual(off.waiting.find((w) => w.issue === number), { issue: number, reason: 'spec.autoReady is off' });
    }
  }
});

test('A1.14 the executable documents planTick, reads JSON and rejects malformed stdin', () => {
  const run = (args, input = '') => {
    const result = spawnSync(cli, args, { encoding: 'utf8', input });
    assert.ifError(result.error);
    return result;
  };
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\bplanTick\b/);
  assert.match(help.stdout, /\b(?:input|stdin)\b/i);
  const invalid = run([], '{broken');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr + invalid.stdout, /\S/, 'invalid JSON needs a diagnostic');
  const state = { now, children: [readyChild(1)] };
  const valid = run([], JSON.stringify(state));
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), require(cli).planTick(state));
});

test('A1.15 unsatisfied dependencies have specific wait reasons and prevent dispatch', () => {
  const result = tick([
    child(1, { labels: ['agent:blocked'], pr: openPR(31) }),
    child(2, { labels: ['agent:in-progress'] }),
    child(3, { labels: ['agent:review'], pr: { number: 33, state: 'closed', merged: false, aheadBy: 1 } }),
    child(11, { dependsOn: [1] }), child(12, { dependsOn: [2] }), child(13, { dependsOn: [3] }),
    child(14, { dependsOn: [4] }), child(15, { dependsOn: [6, 5] }),
    child(16, { labels: ['agent:ready'], dependsOn: [2] }),
    child(17, { dependsOn: [6] }),
  ], { autoReady: 'all', external: [
    { number: 4, state: 'open', labels: [], pr: openPR(34, 0) },
    { number: 6, state: 'open', labels: [], pr: openPR(36) },
  ] });
  for (const [issue, reason] of [
    [11, 'waits for #1 (blocked)'], [12, 'waits for #2 (no PR yet)'],
    [13, 'waits for #3 (PR closed without merge)'], [14, 'waits for #4 (no PR yet)'],
    [15, 'waits for #5 (unknown)'],
  ]) {
    assert.deepEqual(result.waiting.find((w) => w.issue === issue), { issue, reason });
  }
  assert.deepEqual(result.ready, [17]);
  assert.deepEqual(result.dispatch, [{ issues: [17] }]);
});

test('A1.16 blocked and untriaged children are reported as waiting, not skipped silently', () => {
  const result = tick([
    child(1, { labels: ['agent:blocked'] }),
    child(2, { labels: ['needs-triage'] }),
  ], { autoReady: 'all' });

  assert.deepEqual(result.waiting, [
    { issue: 1, reason: 'agent:blocked' },
    { issue: 2, reason: 'needs-triage' },
  ]);
  assert.deepEqual(result.dispatch, []);
});

test('A1.17 the skill never cancels its own loop during preflight while the epic is approved', () => {
  assert.doesNotMatch(readSkill(), /Cancel any active autopilot loop/);
});
