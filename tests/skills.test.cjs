'use strict';
// Keyword checks over skills/*/SKILL.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// T2.13
test('test_t2_13_doctor_fix_removes_only_own_assignee', () => {
  const line = read('skills/doctor/SKILL.md').split('\n').find((l) => /^6\. /.test(l));
  assert.ok(line, 'check 6 exists');
  const fix = line.slice(line.indexOf('--fix'));
  assert.match(fix, /assignee/i);
  assert.match(fix, /authenticated user/i);
  assert.match(fix, /only/i);
  assert.match(fix, /other assignees?[^.]*(kept|keep|left|untouched)|(keep|leave)[^.]*other assignees?/i);
});
