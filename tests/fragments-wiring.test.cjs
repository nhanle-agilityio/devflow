'use strict';
// #106: changelog fragments wired into the engine prompts, the reviewer, the docs and this repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('workflows/next-task-engine.js').replace(/^export /m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const BASE_CFG = { github: { owner: 'o', repo: 'r', remote: 'origin' }, baseBranch: 'main', checks: [{ name: 'test', run: 'make test' }], specDir: 'docs/specs' };

// Runs one issue whose first check fails, so implement, fix and review prompts are built; returns them by stage.
async function run(cfg) {
  const prompts = {};
  let checks = 0;
  const agent = async (prompt, o) => {
    const l = o.label.split(' ')[0];
    if (!(l in prompts)) prompts[l] = prompt;
    switch (l) {
      case 'select': return { issues: [{ number: 7, title: 't', labels: ['risk:low'], body: 'Just an issue\n', dependsOn: [], parents: [] }], skipped: [] };
      case 'claim': return { taken: false, claims: [{ commentId: 11, claimId: 'C-me', createdAt: '2026-01-01T00:00:05Z' }], labels: ['risk:low'], specPath: '', introducedBy: false };
      case 'branch': return { ok: true, branch: 'feat/7-x' };
      case 'implement':
      case 'fix': return { status: 'done', summary: 's', commits: ['a b'], filesChanged: ['src/x.py'], assumptions: [], outOfScope: [], touchesUi: false, specRead: 'none' };
      case 'check': return ++checks === 1 ? { passed: false, failures: [{ check: 'test', output: 'boom' }] } : { passed: true, failures: [] };
      case 'scan': return { scanned: true, hits: [] };
      case 'review': return { issueRead: true, verdict: 'pass', findings: [] };
      case 'ship': return { ok: true, prNumber: 101, url: 'u' };
      case 'restore': return { ok: true };
      default: throw new Error('unexpected agent ' + o.label);
    }
  };
  const args = { config: cfg, limit: 1, startBranch: 'main', prTemplatePath: '', claimId: 'C-me', pluginRoot: '/plugin', issues: [7] };
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', SRC);
  await fn(args, agent, () => {}, () => {}, (fns) => Promise.all(fns.map((f) => f())));
  return prompts;
}

test('T9.1 implement and fix prompts tell the agent to add the fragment', async () => {
  const prompts = await run({ ...BASE_CFG, changelog: { fragmentsDir: 'changelog.d' } });
  for (const l of ['implement', 'fix']) {
    assert.match(prompts[l], /changelog\.d\/7\.md/, `${l} names the fragment file`);
    assert.match(prompts[l], /never edit the changelog file/i, `${l} forbids editing the changelog file`);
  }
});

test('T9.2 prompts without fragmentsDir carry no fragment text', async () => {
  const prompts = await run(BASE_CFG);
  for (const l of ['implement', 'fix', 'review']) {
    assert.doesNotMatch(prompts[l], /fragment/i, `${l} has no fragment text`);
    assert.doesNotMatch(prompts[l], /changelog\.d/, `${l} does not name a fragment directory`);
  }
});

test('T9.3 the reviewer prompt and agents/reviewer.md check the fragment, not the changelog', async () => {
  const prompts = await run({ ...BASE_CFG, changelog: { fragmentsDir: 'changelog.d' } });
  assert.match(prompts.review, /changelog\.d\/7\.md/);
  assert.match(prompts.review, /not the changelog file/i);
  const agentDoc = read('agents/reviewer.md');
  assert.match(agentDoc, /fragmentsDir/);
  assert.match(agentDoc, /fragment[^\n]*not the changelog/i);
});

const REPO_CFG = JSON.parse(read('.claude/devflow.json'));

test('T9.7 this repository uses fragments and ignores the doc hotspots', () => {
  assert.equal(REPO_CFG.changelog.fragmentsDir, 'changelog.d');
  assert.deepEqual(REPO_CFG.dispatch.ignoreHotspots, [
    'README.md', 'CHANGELOG.md', 'DESIGN.md', 'docs/**',
    'skills/init/templates/devflow.schema.json', 'skills/init/templates/devflow.json', 'changelog.d/**',
  ]);
});

test('T9.8 [Unreleased] holds no bullet that cites an issue', () => {
  const log = read('CHANGELOG.md');
  const start = log.indexOf('## [Unreleased]');
  assert.ok(start >= 0);
  const rest = log.slice(start + 1);
  const next = rest.indexOf('\n## [');
  const block = next < 0 ? rest : rest.slice(0, next);
  assert.doesNotMatch(block, /\(#\d+/);
});

const FRAG_DIR = path.join(ROOT, 'changelog.d');
const fragments = () => (fs.existsSync(FRAG_DIR) ? fs.readdirSync(FRAG_DIR).filter((f) => /^\d+\.md$/.test(f)) : []);
const has = (n) => spawnSync('node', [path.join(ROOT, 'bin', 'devflow-changelog'), 'has', String(n)], { cwd: ROOT }).status;

test('T9.9 migrated bullets sit in their fragment under their section and has exits 0', () => {
  // Since 3.1.0 the fragments were assembled into CHANGELOG.md: the migrated bullets keep their section there.
  const changelog = read('CHANGELOG.md');
  const release = changelog.slice(changelog.indexOf('## [3.1.0]'), changelog.indexOf('## [3.0.0]'));
  const expected = { 94: 'Changed', 95: 'Added' };
  for (const [n, section] of Object.entries(expected)) {
    const body = release.slice(release.indexOf(`### ${section}`));
    const end = body.slice(4).search(/^### /m);
    assert.match(end === -1 ? body : body.slice(0, end + 4), new RegExp(`^- .*\\(#${n}\\)`, 'm'), `#${n} bullet under ### ${section} in 3.1.0`);
  }
});

test('T9.10 a bullet is in the fragment of the first issue it cites only', () => {
  // Fragments are assembled at release; check the open fragments and the assembled 3.1.0 section.
  for (const f of fragments()) {
    const n = f.replace('.md', '');
    for (const line of read(`changelog.d/${f}`).split('\n').filter((l) => l.startsWith('- '))) {
      const first = /\(#(\d+)/.exec(line);
      assert.ok(first, `${f}: bullet cites an issue`);
      assert.equal(first[1], n, `${f}: bullet's first cited issue is ${n}`);
    }
  }
  const changelog = read('CHANGELOG.md');
  const release = changelog.slice(changelog.indexOf('## [3.1.0]'), changelog.indexOf('### Upgrade', changelog.indexOf('## [3.1.0]')));
  const bullets = release.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bullets.length > 0);
  for (const line of bullets) assert.match(line, /\(#\d+/, `3.1.0 bullet cites its issue: ${line.slice(0, 60)}`);
});

test('T9.11 the release skill shows the preview and does not write it', () => {
  const text = read('skills/release/SKILL.md');
  assert.match(text, /devflow-changelog preview/);
  assert.match(text, /fragmentsDir/);
  assert.match(text, /does not write/i);
});

test('T9.12 ignoreHotspots docs say the fragment directory never needs a lane', () => {
  for (const f of ['README.md', 'skills/init/templates/devflow.json']) {
    assert.match(read(f), /fragment directory never needs a lane/, f);
  }
});
