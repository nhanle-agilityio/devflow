'use strict';
// Keyword checks over DESIGN.md, README.md and CHANGELOG.md. Append-only: each task adds its own cases.
// A task's changelog entry is found by its issue number "(#NN)" anywhere in CHANGELOG.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const changelogEntry = (n) => read('CHANGELOG.md').split('\n').filter((l) => l.includes(`(#${n})`)).join('\n');
const KEY = /assignedByRun|authenticated user/;

// T1.10
test('test_t1_10_docs_describe_the_claim_assignee_rule', () => {
  const design = read('DESIGN.md');
  const claimLines = design.split('\n').filter((l) => /\bClaim\b/.test(l));
  assert.ok(claimLines.some((l) => KEY.test(l)), 'a DESIGN.md Claim line mentions the rule');
  assert.match(design, /assignedByRun/);
  const cleanup = design.split('\n').filter((l) => /cleanup/i.test(l));
  assert.ok(cleanup.some((l) => KEY.test(l)), 'a DESIGN.md blocked cleanup line mentions the rule');
  const entry = changelogEntry(28);
  assert.ok(entry, 'CHANGELOG has an entry citing (#28)');
  assert.match(entry, KEY);
  const readme = read('README.md');
  if (/claims/i.test(readme)) assert.match(readme, KEY);
});

// T2.14
test('test_t2_14_docs_describe_throw_cleanup_and_doctor_assignee', () => {
  const design = read('DESIGN.md');
  assert.match(design, /cleanup failed; run \/devflow:doctor/);
  assert.match(design, /Error:/);
  const doctor = design.split('\n').filter((l) => /doctor/i.test(l) && /assignee/i.test(l));
  assert.ok(doctor.some((l) => /authenticated user|own assignee/i.test(l)), 'DESIGN.md doctor line limits assignee removal');
  const entry = changelogEntry(29);
  assert.ok(entry, 'CHANGELOG has an entry citing (#29)');
  assert.match(entry, /Error:|thrown|throws?/i);
  assert.match(entry, /cleanup failed; run \/devflow:doctor/);
  assert.match(entry, /assignee/i);
});
