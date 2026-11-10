'use strict';
// The reusable workflows in .github/workflows must stay in step with the copy-install templates, and the thin
// callers must point at them through the {{DEVFLOW_REF}} placeholder that /devflow:init fills with a tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const jobs = (text) => text.slice(text.indexOf('\njobs:'));

test('the reusable review has exactly the jobs of the copy template', () => {
  const reusable = read('.github/workflows/devflow-review.yml');
  assert.match(reusable, /\non:\n  workflow_call:/);
  assert.equal(jobs(reusable), jobs(read('skills/init/templates/github/workflows/claude-code-review.yml')));
});

test('the reusable gate runs the gate script that the copy template installs', () => {
  const reusable = read('.github/workflows/devflow-merge-gate.yml');
  assert.match(reusable, /\non:\n  workflow_call:/);
  const m = /require\('\.\/\.devflow-plugin\/(.+?)'\)/.exec(reusable);
  assert.ok(m, 'require path');
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), m[1]);
  assert.match(reusable, /sparse-checkout: skills\/init\/templates\/github\/scripts/);
  assert.match(reusable, /ref: \$\{\{ inputs\.devflow-ref \}\}/);
});

test('callers are pinned through the DEVFLOW_REF placeholder and keep the trigger names the gate needs', () => {
  const review = read('skills/init/templates/github/callers/claude-code-review.yml');
  const gate = read('skills/init/templates/github/callers/devflow-merge-gate.yml');
  assert.match(review, /^name: Claude Code Review$/m);
  assert.match(review, /uses: nhanle-agilityio\/devflow\/\.github\/workflows\/devflow-review\.yml@\{\{DEVFLOW_REF\}\}/);
  assert.match(review, /id-token: write/);
  assert.match(gate, /uses: nhanle-agilityio\/devflow\/\.github\/workflows\/devflow-merge-gate\.yml@\{\{DEVFLOW_REF\}\}/);
  assert.match(gate, /devflow-ref: "\{\{DEVFLOW_REF\}\}"/);
  assert.match(gate, /workflows: \["CI", "Claude Code Review"\]/);
  // secrets: inherit is only guaranteed inside one organization or enterprise; these repositories are user-owned.
  for (const t of [review, gate]) assert.doesNotMatch(t, /secrets: inherit/);
  assert.match(review, /secrets:\n      CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(gate, /secrets:\n      DEVFLOW_GATE_TOKEN: \$\{\{ secrets\.DEVFLOW_GATE_TOKEN \}\}\n      DEVFLOW_READ_TOKEN: \$\{\{ secrets\.DEVFLOW_READ_TOKEN \}\}/);
});

test('every secret a caller passes is declared by the reusable workflow it calls', () => {
  const pairs = [
    ['skills/init/templates/github/callers/claude-code-review.yml', '.github/workflows/devflow-review.yml'],
    ['skills/init/templates/github/callers/devflow-merge-gate.yml', '.github/workflows/devflow-merge-gate.yml'],
  ];
  for (const [caller, called] of pairs) {
    const passed = [...read(caller).matchAll(/^      ([A-Z_]+): \$\{\{ secrets\./gm)].map((m) => m[1]);
    const declared = read(called);
    assert.ok(passed.length, caller);
    for (const name of passed) assert.match(declared, new RegExp(`\\n      ${name}:\\n        required:`), `${name} in ${called}`);
  }
});
