'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const schema = require('../skills/init/templates/devflow.schema.json');

test('R1.10 approve and dispatch name the eligibility sweep and result table', () => {
  const approval = read('skills/approve/SKILL.md');
  assert.match(approval, /^disable-model-invocation: true$/m);
  for (const term of ['GitHub MCP', 'epicApproved', 'spec.autoReady', 'get_sub_issues', 'Depends on', 'Open questions', 'Ready: manual', 'high risk', 'waits for', 'devflow-auto-ready']) {
    assert.ok(approval.includes(term), term);
  }
  assert.match(approval, /table.*sub-issue.*action/i);
  const dispatch = read('skills/dispatch/SKILL.md');
  assert.match(dispatch, /before collecting ready issues/i);
  assert.match(dispatch, /approve\/SKILL\.md/);
  for (const file of ['skills/spec/SKILL.md', 'skills/spec/templates/issue.md']) {
    assert.match(read(file), /Ready: manual/);
  }
});

test('R1.10 configuration keys are optional with backward-compatible defaults', () => {
  const { labels, spec } = schema.properties;
  assert.equal(labels.properties.epicApproved.default, 'epic:approved');
  assert.equal(spec.properties.autoReady.default, 'off');
  assert.deepEqual(spec.properties.autoReady.enum, ['off', 'low', 'all']);
  const legacy = {
    github: { owner: 'o', repo: 'r' }, baseBranch: 'main', checks: [{ name: 'test', run: 'make test' }],
    labels: { ready: 'agent:ready' }, spec: { qaModel: 'opus' }, devflowVersion: '3.0.0',
  };
  for (const [definition, value] of [[schema, legacy], [labels, legacy.labels], [spec, legacy.spec]]) {
    assert.ok((definition.required || []).every((key) => Object.hasOwn(value, key)));
    assert.ok(Object.keys(value).every((key) => Object.hasOwn(definition.properties, key)));
  }
});
