'use strict';
// A stacked issue that reuses its open PR while the parent merged: step 0 and 1b must agree on the base.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'next-task-engine.js'), 'utf8');

test('ship step 0 retargets to the base when step 1b finds the parent merged', () => {
  const line0 = SRC.split('\n').find((l) => l.startsWith('0. Look for an open PR with head'));
  assert.ok(line0);
  assert.match(line0, /when step 1b finds the parent merged/);
  assert.match(line0, /\$\{base\}/);
  assert.match(SRC, /in steps 0, 2 and 3 use base \$\{base\}/);
});
