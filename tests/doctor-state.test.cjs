'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const doctor = fs.readFileSync(path.join(__dirname, '..', 'skills', 'doctor', 'SKILL.md'), 'utf8');
const checks = doctor.split(/^## Checks\s*$/m)[1].split(/^## /m)[0].split(/^\d+\.\s+/m);

test('T20.11 doctor lists closed issues with state labels and removes labels with confirmation', () => {
  const check = checks.find((text) => /\bclosed issues\b/i.test(text) && /labels\.inProgress/.test(text));
  assert.ok(check, 'doctor must check closed issues for lingering DevFlow state labels');
  for (const label of ['inProgress', 'review', 'blocked']) {
    assert.ok(check.includes(`labels.${label}`), `doctor must check for labels.${label} on closed issues`);
  }
  assert.match(check, /\b(?:list|report)\b/i, 'doctor must list the matching closed issues');
  assert.match(check, /--fix[\s\S]*\b(?:after a yes|confirm\w*)\b[\s\S]*\bremove\b[^.]*\blabels?\b/i,
    'doctor must remove the state labels only with --fix after a yes');
});

test('T20.16 doctor lists stale claims and deletes them with confirmation while protecting in-progress issues', () => {
  const check = checks.find((text) => /\bdevflow-claim\b/.test(text));
  assert.ok(check, 'doctor must check for devflow-claim comments');
  assert.match(check, /\bopen issues?\b/i, 'stale claims must be limited to open issues');
  assert.match(check, /\bno open PR\b/i, 'a stale claim must have no open PR');
  assert.match(check, /\bstale claims?\b/i, 'doctor must identify stale claims');
  assert.match(check, /\b(?:list|report)\b/i, 'doctor must list stale claims');
  assert.match(check, /--fix[\s\S]*\b(?:after a yes|confirm\w*)\b[\s\S]*\bdelete\b[^.]*\bclaim comments?\b/i,
    'doctor must delete stale claim comments only with --fix after a yes');
  assert.match(check, /\b(?:never|do not)\b[^.]*\b(?:in-progress|labels\.inProgress)\b/i,
    'doctor must explicitly protect in-progress issues from stale-claim cleanup');
  assert.doesNotMatch(check, /\bswap\s+`?labels\.inProgress\b/i,
    'doctor must leave in-progress issues untouched');
});
