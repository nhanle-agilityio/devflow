'use strict';
// bin/devflow-smoke and the release smoke procedure (#108). Test titles start with the Test cases row id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'devflow-smoke');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const REPO = 'acme/sandbox';
const ISSUE = 7;
const GATE_MARKER = '<!-- devflow-gate-merged -->';
const TRAILER = 'Merged-by: devflow merge gate';

function prBody({ risk = 'low', review = true, marker = { path: 'short', reviewRounds: 1, claimedAt: 'x' }, closes = ISSUE } = {}) {
  const lines = ['## Summary', '', 'Smoke change.', '', '## Risk', '', `Risk: ${risk} - smoke fixture`, ''];
  if (review) lines.push('## Review', '', 'Reviewer: devflow:reviewer', 'Rounds: 1', 'Result: pass', '');
  if (marker) lines.push(`<!-- devflow-run ${JSON.stringify(marker)} -->`, '');
  lines.push(`Closes #${closes}`);
  return lines.join('\n');
}

// A PR fixture: {number, labels, state, merged, body, gateComment, trailer}.
function pr(over = {}) {
  return {
    number: 20,
    labels: ['devflow', 'risk:low'],
    state: 'closed',
    merged: true,
    body: prBody(),
    gateComment: true,
    trailer: false,
    ...over,
  };
}

// Builds an injected reader from fixture data; records every path read.
function fixtureReader({ issue = { state: 'closed' }, prs = [pr()] } = {}) {
  const calls = [];
  const reader = (apiPath) => {
    calls.push(apiPath);
    const [p] = apiPath.split('?');
    const page = Number((/[?&]page=(\d+)/.exec(apiPath) || [])[1] || 1);
    let m;
    if (p === `repos/${REPO}/issues/${ISSUE}`) return issue ? { number: ISSUE, state: issue.state, title: 'smoke' } : null;
    if (p === `repos/${REPO}/issues/${ISSUE}/timeline`) {
      if (!issue || page > 1) return [];
      return prs.map((x) => ({
        event: 'cross-referenced',
        source: { type: 'issue', issue: { number: x.number, pull_request: { url: 'u' }, repository: { full_name: REPO } } },
      }));
    }
    if ((m = new RegExp(`^repos/${REPO}/pulls/(\\d+)$`).exec(p))) {
      const x = prs.find((y) => y.number === Number(m[1]));
      if (!x) return null;
      return {
        number: x.number,
        state: x.merged ? 'closed' : x.state,
        merged_at: x.merged ? '2026-11-19T00:00:00Z' : null,
        merge_commit_sha: x.merged ? `sha${x.number}` : null,
        body: x.body,
        labels: x.labels.map((name) => ({ name })),
      };
    }
    if ((m = new RegExp(`^repos/${REPO}/issues/(\\d+)/comments$`).exec(p))) {
      const x = prs.find((y) => y.number === Number(m[1]));
      if (!x || page > 1) return [];
      return x.gateComment ? [{ body: `${GATE_MARKER}\nMerged by the devflow merge gate.` }] : [{ body: 'looks good' }];
    }
    if ((m = new RegExp(`^repos/${REPO}/commits/sha(\\d+)$`).exec(p))) {
      const x = prs.find((y) => y.number === Number(m[1]));
      return { sha: p, commit: { message: x && x.trailer ? `feat: x\n\n${TRAILER}` : 'Merge pull request' } };
    }
    throw new Error(`unexpected read ${apiPath}`);
  };
  reader.calls = calls;
  return reader;
}

function runSmoke(expect, data, extra = {}) {
  const { run } = require(BIN);
  let out = '';
  let err = '';
  const reader = fixtureReader(data);
  const spawn = () => { throw new Error('real gh must not run with an injected reader'); };
  const code = run(['--repo', REPO, '--issue', String(ISSUE), '--expect', expect, ...(extra.args || [])], {
    reader,
    spawn,
    out: (s) => { out += s; },
    err: (s) => { err += s; },
  });
  const lines = out.split('\n').filter(Boolean);
  return { code, out, err, lines, reader };
}

const failLines = (r) => r.lines.filter((l) => l.startsWith('fail'));
const highPr = (over = {}) => pr({ labels: ['devflow', 'risk:high'], state: 'open', merged: false, gateComment: false, body: prBody({ risk: 'high' }), ...over });

test('T13.1 all checks pass for a low issue merged by the gate', () => {
  const r = runSmoke('low', {});
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.length >= 5, `one line per check:\n${r.out}`);
  for (const l of r.lines) assert.match(l, /^ok /, `every line is ok: ${l}`);
});

test('T13.2 a missing ## Review section fails that check and exits non-zero', () => {
  const r = runSmoke('low', { prs: [pr({ body: prBody({ review: false }) })] });
  assert.notEqual(r.code, 0);
  assert.equal(failLines(r).length, 1, r.out);
  assert.match(failLines(r)[0], /review/i);
});

test('T13.3 low: two closing devflow PRs fail', () => {
  const r = runSmoke('low', { prs: [pr(), pr({ number: 21 })] });
  assert.notEqual(r.code, 0);
  assert.ok(failLines(r).some((l) => /closing PR/i.test(l)), r.out);
});

test('T13.4 low: a closing PR without the devflow label fails', () => {
  const r = runSmoke('low', { prs: [pr({ labels: ['risk:low'] })] });
  assert.notEqual(r.code, 0);
  assert.ok(failLines(r).some((l) => /closing PR/i.test(l)), r.out);
});

test('T13.5 low: the Merged-by trailer counts as a gate merge', () => {
  const r = runSmoke('low', { prs: [pr({ gateComment: false, trailer: true })] });
  assert.equal(r.code, 0, r.out);
  assert.equal(failLines(r).length, 0, r.out);
});

test('T13.6 low: merged with neither marker nor trailer fails', () => {
  const r = runSmoke('low', { prs: [pr({ gateComment: false, trailer: false })] });
  assert.notEqual(r.code, 0);
  assert.ok(failLines(r).some((l) => /merge/i.test(l)), r.out);
});

test('T13.7 low: an open issue fails', () => {
  const r = runSmoke('low', { issue: { state: 'open' } });
  assert.notEqual(r.code, 0);
  assert.ok(failLines(r).some((l) => /issue/i.test(l)), r.out);
});

test('T13.8 a missing issue fails for either expect', () => {
  for (const expect of ['low', 'high']) {
    const r = runSmoke(expect, { issue: null, prs: [] });
    assert.notEqual(r.code, 0, expect);
    assert.notEqual(r.code, 2, `${expect}: a missing issue is a failed check, not a usage error`);
    assert.ok(failLines(r).some((l) => /issue/i.test(l)), r.out);
  }
});

test('T13.9 high: one open risk:high devflow PR passes', () => {
  const r = runSmoke('high', { prs: [highPr()] });
  assert.equal(r.code, 0, r.out + r.err);
  for (const l of r.lines) assert.match(l, /^ok /, l);
});

test('T13.10 high: merged by a human (neither marker nor trailer) passes', () => {
  const r = runSmoke('high', { prs: [highPr({ merged: true })] });
  assert.equal(r.code, 0, r.out);
});

test('T13.11 high: merged by the gate fails', () => {
  for (const over of [{ merged: true, gateComment: true }, { merged: true, trailer: true }]) {
    const r = runSmoke('high', { prs: [highPr(over)] });
    assert.notEqual(r.code, 0, JSON.stringify(over));
    assert.ok(failLines(r).some((l) => /merge/i.test(l)), r.out);
  }
});

test('T13.12 high: a PR without risk:high fails', () => {
  const r = runSmoke('high', { prs: [highPr({ labels: ['devflow'] })] });
  assert.notEqual(r.code, 0);
  assert.ok(failLines(r).some((l) => /risk:high/i.test(l)), r.out);
});

test('T13.13 high: an open issue with an open closing PR is ok', () => {
  const r = runSmoke('high', { issue: { state: 'open' }, prs: [highPr()] });
  assert.equal(r.code, 0, r.out);
  for (const l of r.lines) assert.match(l, /^ok /, l);
});

test('T13.14 a devflow-run marker without path or reviewRounds fails', () => {
  for (const marker of [{ path: 'short' }, { reviewRounds: 1 }]) {
    const r = runSmoke('low', { prs: [pr({ body: prBody({ marker }) })] });
    assert.notEqual(r.code, 0, JSON.stringify(marker));
    assert.ok(failLines(r).some((l) => /marker/i.test(l)), r.out);
  }
  const none = runSmoke('low', { prs: [pr({ body: prBody({ marker: null }) })] });
  assert.notEqual(none.code, 0);
});

test('T13.15 a Risk line that does not match --expect fails', () => {
  const r = runSmoke('low', { prs: [pr({ body: prBody({ risk: 'high' }) })] });
  assert.notEqual(r.code, 0);
  assert.ok(failLines(r).some((l) => /risk line/i.test(l)), r.out);
});

test('T13.16 an injected reader runs no gh; the gh reader only issues GET calls', () => {
  const r = runSmoke('low', {});
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.reader.calls.length > 0, 'the injected reader was used');

  const { makeGhReader } = require(BIN);
  const argLists = [];
  const fakeSpawn = (cmd, args) => {
    argLists.push([cmd, ...args]);
    const apiPath = args[args.length - 1];
    const data = fixtureReader({})(apiPath);
    if (data === null) return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    return { status: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  const { run } = require(BIN);
  let out = '';
  const code = run(['--repo', REPO, '--issue', String(ISSUE), '--expect', 'low'], {
    reader: makeGhReader(fakeSpawn),
    out: (s) => { out += s; },
    err: () => {},
  });
  assert.equal(code, 0, out);
  assert.ok(argLists.length > 0);
  for (const a of argLists) {
    assert.equal(a[0], 'gh');
    assert.equal(a[1], 'api');
    const i = a.indexOf('-X') >= 0 ? a.indexOf('-X') : a.indexOf('--method');
    assert.ok(i > 0, `explicit method in ${a.join(' ')}`);
    assert.equal(a[i + 1], 'GET', a.join(' '));
    for (const flag of ['-f', '-F', '--field', '--raw-field', '--input']) assert.ok(!a.includes(flag), `${flag} in ${a.join(' ')}`);
  }
  // A 404 from gh is "not found", not an error.
  const missing = makeGhReader(() => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }));
  assert.equal(missing(`repos/${REPO}/issues/999`), null);
});

function runBin(args, envPath) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, PATH: envPath } });
}

test('T13.17 gh missing or unauthenticated exits 2 with a message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-smoke-'));
  try {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const args = ['--repo', REPO, '--issue', String(ISSUE), '--expect', 'low'];
    const missing = runBin(args, empty);
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /gh/);

    const fake = path.join(dir, 'fake');
    fs.mkdirSync(fake);
    const gh = path.join(fake, 'gh');
    fs.writeFileSync(gh, '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n');
    fs.chmodSync(gh, 0o755);
    const unauth = runBin(args, fake);
    assert.equal(unauth.status, 2, unauth.stdout + unauth.stderr);
    assert.match(unauth.stderr, /auth/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T13.18 usage errors exit 2', () => {
  const { run } = require(BIN);
  const io = { reader: fixtureReader({}), out: () => {}, err: () => {} };
  assert.equal(run(['--issue', '7', '--expect', 'low'], io), 2);
  assert.equal(run(['--repo', REPO, '--issue', '7', '--expect', 'medium'], io), 2);
  assert.equal(run(['--repo', REPO, '--issue', 'x', '--expect', 'low'], io), 2);
  assert.equal(run(['--repo', 'noslash', '--issue', '7', '--expect', 'low'], io), 2);
});

test('T13.19 fixture issue bodies declare their risk', () => {
  assert.match(read('docs/smoke/low.md'), /^Risk: low\b/m);
  assert.match(read('docs/smoke/high.md'), /^Risk: high\b/m);
});

// From a "## Release process" heading to the next "## " heading or the end.
function releaseSection(file) {
  const text = read(file);
  const start = text.search(/^## Release process\s*$/m);
  assert.ok(start >= 0, `${file} has a "## Release process" section`);
  const rest = text.slice(start + 3);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('T13.20 the smoke checklist is in CHANGELOG.md and DESIGN.md', () => {
  for (const f of ['CHANGELOG.md', 'DESIGN.md']) {
    const s = releaseSection(f);
    assert.match(s, /--plugin-dir/, `${f}: --plugin-dir`);
    assert.match(s, /docs\/smoke\/low\.md/, `${f}: low fixture`);
    assert.match(s, /docs\/smoke\/high\.md/, `${f}: high fixture`);
    assert.match(s, /\/devflow:dispatch[^\n]*two lanes/, `${f}: dispatch as two lanes`);
    assert.match(s, /devflow-smoke[^\n]*--expect low/, `${f}: checker for low`);
    assert.match(s, /devflow-smoke[^\n]*--expect high/, `${f}: checker for high`);
    assert.match(s, /only when both (checks )?pass/i, `${f}: merge only when both pass`);
    assert.match(s, /conflicts/i, `${f}: records conflicts`);
    assert.match(s, /"behind" updates/i, `${f}: records behind updates`);
    assert.match(s, /\/devflow:sync` calls/, `${f}: records /devflow:sync calls`);
  }
});

test('T13.21 the release process has the assemble step and is the release task template', () => {
  const s = releaseSection('CHANGELOG.md');
  assert.ok(s.includes('node bin/devflow-changelog assemble --version X.Y.Z --date YYYY-MM-DD'), 'assemble step');
  assert.match(s, /changelog\.fragmentsDir/, 'only when fragmentsDir is set');
  assert.match(s, /release task template/i);
});

test('T13.22 tag right after the merge; reusable workflow changes tell callers to move their pin', () => {
  for (const f of ['CHANGELOG.md', 'DESIGN.md']) {
    const s = releaseSection(f);
    assert.match(s, /tag[^\n]*right after the release PR merges/i, `${f}: tag right after merge`);
    assert.match(s, /upgrade note[^\n]*reusable workflow[^\n]*move their pin/i, `${f}: move their pin`);
  }
});
