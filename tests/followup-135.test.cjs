'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'workflows', 'next-task-engine.js'), 'utf8').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const engine = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
const config = {
  github: { owner: 'o', repo: 'r', remote: 'origin' },
  baseBranch: 'main',
  checks: [{ name: 'test', run: 'make test' }],
  specDir: 'docs/specs',
  nextTask: { maxReviewRounds: 0, onQuestion: 'block' },
};

async function helpers() {
  return engine({ exports: true }, null, () => {}, () => {}, null);
}

async function run({ diff = '', plannedFile = 'src/x.js', ghCli = false, review }) {
  const calls = [];
  const agent = async (prompt, { label, agentType }) => {
    calls.push({ label, agentType, prompt });
    if (label.startsWith('claim check')) return { claimPresent: true };
    switch (label.split(' ')[0]) {
      case 'select':
        return { issues: [{ number: 135, title: 'Regression', labels: [], body: '', dependsOn: [] }], skipped: [] };
      case 'claim':
        return {
          taken: false,
          claims: [{ commentId: 1, claimId: 'C-me', createdAt: '2026-01-01T00:00:05Z' }],
          labels: [], specPath: '', introducedBy: false,
        };
      case 'branch':
        return { ok: true, branch: 'feat/135' };
      case 'plan':
        return {
          status: 'ready', plan: '## Files to change\n- `' + plannedFile + '` (Dev)',
          questions: [], qaFiles: [], devFiles: [plannedFile], specRead: 'none',
          acceptanceCriteria: 0, httpOrE2eRows: false,
        };
      case 'implement':
        return {
          status: 'done', summary: 'Implemented', commits: ['abc1234'], filesChanged: [plannedFile],
          assumptions: [], outOfScope: [], touchesUi: false, specRead: 'none',
        };
      case 'check':
        return { passed: true, failures: [] };
      case 'scan': {
        const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
        return { scanned: true, hits: scanWeakenedChecks(diff, checkConfigGlobs(config.checks)) };
      }
      case 'review':
        return review ? review(agentType) : { verdict: 'pass', findings: [], issueRead: true };
      case 'ship':
        return { ok: true, prNumber: 136, url: 'https://example.test/pull/136' };
      case 'blocked':
        return { ok: true, pushed: false };
      case 'restore':
        return { ok: true };
      default:
        throw new Error('unexpected agent ' + label);
    }
  };
  const args = { config, issues: [135], limit: 1, startBranch: 'main', claimId: 'C-me', pluginRoot: '/plugin', ghCli };
  const report = await engine(args, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((fn) => fn())));
  return { result: report[0], calls };
}

function diffOf(file, hunk) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunk}\n`;
}

test('T1.1 a deleted 200-line test or fixture file yields one hit, not one per line', async () => {
  const files = ['tests/a.test.cjs', 'fixtures/a.txt'];
  const removed = Array.from({ length: 200 }, (_, i) => `-assert.equal(actual[${i}], ${i});`);
  const diff = files.map((file) => [
    `diff --git a/${file} b/${file}`, 'deleted file mode 100644',
    `--- a/${file}`, '+++ /dev/null', '@@ -1,200 +0,0 @@', ...removed, '',
  ].join('\n')).join('');
  const { scanWeakenedChecks, parseDiff, checkConfigGlobs } = await helpers();
  assert.deepEqual(parseDiff(diff).map(({ file, deleted, removed }) => [file, deleted, removed.length]),
    files.map((file) => [file, true, 200]));
  const hits = scanWeakenedChecks(diff, checkConfigGlobs(config.checks));
  // A deleted test file keeps its single critical 'deleted test file' hit; a deleted fixture gets one changed-existing-test hit.
  const kinds = files.map((file) => hits.filter((hit) => hit.file === file).map((hit) => hit.kind));
  assert.deepEqual(kinds, [['deleted test file'], ['changed-existing-test']],
    `Expected one hit per deleted file, got ${files.map((file, i) => `${file}: ${kinds[i].join('+')}`).join(', ')}`);
});

test('T1.2 review does not warn about an existing test line changed in a planned file', async () => {
  const plannedFile = 'tests/a.test.cjs';
  const diff = diffOf(plannedFile, '@@ -3 +3 @@\n-assert.equal(a, 1);\n+assert.equal(a, 2);');
  const { result, calls } = await run({ diff, plannedFile });
  assert.ok(calls.some(({ label }) => label.startsWith('review ')));
  const blocked = calls.find(({ label }) => label.startsWith('blocked '));
  const warning = blocked?.prompt.match(/\[warning\] tests\/a\.test\.cjs:3:[^\n]*\n\s*Suggested fix: Restore the original line/)?.[0];
  assert.equal(warning, undefined, warning?.replace(/\n\s*/g, ' '));
  assert.equal(result.status, 'pr', result.reason);
});

test('T1.3 eslint-disable in a source string literal produces no hit', async () => {
  const diff = diffOf('src/x.js', "@@ -0,0 +1 @@\n+const s = 'eslint-disable'");
  const { scanWeakenedChecks, checkConfigGlobs } = await helpers();
  const hits = scanWeakenedChecks(diff, checkConfigGlobs(config.checks));
  assert.deepEqual(hits, [], `Expected no scan hits, got ${hits.map(({ file, line, kind }) => `${file}:${line} ${kind}`).join(', ')}`);
});

test('T1.4 devflow-gh reports gh availability and the skill uses it for ghCli', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-gh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Keep the script's interpreters available without exposing the host's gh.
  fs.symlinkSync(process.execPath, path.join(directory, 'node'));
  fs.symlinkSync('/bin/bash', path.join(directory, 'bash'));
  fs.symlinkSync('/bin/sh', path.join(directory, 'sh'));
  const script = path.join(root, 'bin', 'devflow-gh');
  const probe = () => {
    const output = execFileSync(script, { encoding: 'utf8', env: { ...process.env, PATH: directory } });
    assert.equal(output.trimEnd().split('\n').length, 1);
    return JSON.parse(output);
  };
  assert.deepEqual(probe(), { gh: false });
  fs.writeFileSync(path.join(directory, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.deepEqual(probe(), { gh: true });

  const skill = fs.readFileSync(path.join(root, 'skills', 'next-task', 'SKILL.md'), 'utf8');
  assert.match(skill, /^6\. [^\n]*bin\/devflow-gh[^\n]*ghCli/m);
});

test('T1.5 reviewer GitHub MCP unavailable result falls back to the default agent', async () => {
  const { result, calls } = await run({
    ghCli: true,
    review: (agentType) => ({
      verdict: 'pass',
      findings: [],
      issueRead: !agentType,
      ...(agentType ? { problem: 'GitHub MCP unavailable: could not run gh' } : {}),
    }),
  });
  const reviews = calls.filter(({ label }) => label.startsWith('review '));
  assert.equal(reviews[0]?.agentType, 'devflow:reviewer');
  assert.equal(result.status, 'pr', result.reason);
  assert.deepEqual(reviews.map(({ label, agentType }) => [label, agentType]), [
    ['review #135 (round 1)', 'devflow:reviewer'],
    ['review #135 (round 1)', undefined],
  ]);
});
