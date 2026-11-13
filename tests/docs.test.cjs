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

// T7.11
test('test_t7_11_docs_describe_worked_limit_and_findings_only_review', () => {
  const design = read('DESIGN.md');
  const entry = changelogEntry(34);
  assert.ok(entry, 'CHANGELOG has an entry citing (#34)');
  const skipRe = /claim[\s\S]{0,120}(do(es)? not|not) count[\s\S]{0,80}limit|limit[\s\S]{0,120}(not count|only (counts )?worked)/i;
  const findingsRe = /(exit(s)?|ends?|leaves?)[\s\S]{0,80}(on )?findings only|findings only|verdict[\s\S]{0,80}(no longer|not)/i;
  for (const [name, text] of [['DESIGN.md', design], ['CHANGELOG entry', entry]]) {
    assert.match(text, skipRe, `${name} says Claim skips do not count toward the limit`);
    assert.match(text, findingsRe, `${name} says the review exits on findings only`);
  }
});

// T8.7
test('test_t8_7_docs_describe_reusing_an_open_pr', () => {
  const design = read('DESIGN.md');
  const shipLines = design.split('\n').filter((l) => /\bShip\b/.test(l) && /open PR/i.test(l) && /(reus|branch)/i.test(l));
  assert.ok(shipLines.length, 'a DESIGN.md Ship line mentions reusing an open PR for the branch');
  const entry = changelogEntry(35);
  assert.ok(entry, 'CHANGELOG has an entry citing (#35)');
  assert.match(entry, /reus/i);
  assert.match(entry, /open PR/i);
});

// T4.12
test('test_t4_12_docs_describe_the_update_slot', () => {
  const WAIT = 'deferred: waits for its turn';
  const design = read('DESIGN.md');
  const section = design.split(/^## /m).find((s) => /^Risk and the merge gate/i.test(s));
  assert.ok(section, 'DESIGN.md has a "Risk and the merge gate" section');
  assert.ok(section.includes(WAIT), 'DESIGN.md section has the deferred reason');
  assert.match(section, /in[- ]flight/i);
  assert.match(section, /window/i);
  assert.match(section, /(stuck|never resolves|does not resolve|not resolve)[\s\S]{0,80}pending|pending[\s\S]{0,120}(stuck|never resolves|does not resolve|not resolve)/i);
  assert.match(section, /re-?run|replace/i);
  const readme = read('README.md');
  if (/merge gate/i.test(readme)) assert.ok(readme.includes(WAIT), 'README lists the deferred reason');
  const entry = changelogEntry(31);
  assert.ok(entry, 'CHANGELOG has an entry citing (#31)');
  assert.ok(entry.includes(WAIT), 'CHANGELOG entry has the deferred reason');
});

// T5.12
test('test_t5_12_docs_describe_the_collaborator_thread_rule', () => {
  const RULE = /collaborator/i;
  const design = read('DESIGN.md');
  const section = design.split(/^## /m).find((s) => /^Risk and the merge gate/i.test(s));
  assert.ok(section, 'DESIGN.md has a "Risk and the merge gate" section');
  assert.match(section, RULE);
  assert.match(section, /resolved/i);
  assert.match(section, /CONTRIBUTOR/);
  const readme = read('README.md');
  if (/merge gate/i.test(readme)) assert.match(readme, RULE);
  const entry = changelogEntry(32);
  assert.ok(entry, 'CHANGELOG has an entry citing (#32)');
  assert.match(entry, RULE);
  assert.match(entry, /resolved|unresolved/i);
});

// T3.8
test('test_t3_8_docs_describe_the_trust_rule', () => {
  const trust = /OWNER\W+MEMBER\W+(or\s+)?COLLABORATOR/;
  const design = read('DESIGN.md');
  const sec = (re) => {
    const i = design.search(re);
    assert.ok(i >= 0, `DESIGN.md has ${re}`);
    const rest = design.slice(i + 1);
    const e = rest.search(/^## /m);
    return e < 0 ? design.slice(i) : design.slice(i, i + 1 + e);
  };
  for (const re of [/^## `\/devflow:sync/m, /^## `\/devflow:answer/m]) {
    const s = sec(re);
    assert.match(s, trust);
    assert.match(s, /ignored: not a collaborator/);
  }
  const readme = read('README.md');
  const rline = (re) => {
    const l = readme.split('\n').find((x) => re.test(x));
    assert.ok(l, `README.md has a line for ${re}`);
    return l;
  };
  for (const re of [/^- `\/devflow:sync/, /^- `\/devflow:answer/]) {
    const l = rline(re);
    assert.match(l, trust);
    assert.match(l, /ignored: not a collaborator/);
  }
  assert.match(readme, trust);
  assert.match(readme, /ignored: not a collaborator/);
  const entry = changelogEntry(30);
  assert.ok(entry, 'CHANGELOG has an entry citing (#30)');
  assert.match(entry, trust);
  assert.match(entry, /ignored: not a collaborator/);
});
