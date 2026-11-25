'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bin = path.join(__dirname, '..', 'bin/devflow-run');
const template = path.join(__dirname, '..', 'skills/next-task/templates/pr.md');
const branch = 'feat/1-x';

function invoke(args, options = {}) {
  const { error, status, stderr, stdout } = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...options,
  });
  if (error) throw error;
  assert.ok(stdout, stderr || 'Expected JSON on stdout');
  return { status, output: JSON.parse(stdout) };
}

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ship-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(cwd);
  function git(...args) {
    const { status, stdout, stderr } = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(status, 0, stderr);
    return stdout.trim();
  }
  git('init', '-b', 'main');
  git('init', '--bare', origin);
  git('config', 'user.name', 'Devflow Test');
  git('config', 'user.email', 'devflow@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude/devflow.json'), JSON.stringify({
    baseBranch: 'main',
    protectedBranches: ['release/*'],
  }));
  git('add', '--', '.claude/devflow.json');
  git('commit', '-m', 'initial config');
  git('remote', 'add', 'origin', origin);
  return {
    git,
    remoteRefs: () => git('--git-dir', origin, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'),
    push: (name, ...args) => invoke(['push', '--branch', name, ...args], { cwd }),
  };
}

function assertPushed(result, name) {
  assert.equal(result.status, 0, `push should succeed: ${result.output.error}`);
  assert.deepEqual(result.output, { ok: true, branch: name, remote: 'origin', pushed: true });
}

test('M5.1 pushes the current feature branch and sets its upstream without forcing', (t) => {
  const { git, push, remoteRefs } = repo(t);
  git('switch', '-c', branch);
  assertPushed(push(branch), branch);
  const localHead = git('rev-parse', 'HEAD');
  assert.equal(remoteRefs(), `${localHead} refs/heads/${branch}`);
  assert.equal(git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/' + branch);

  git('commit', '--allow-empty', '-m', 'advance origin');
  git('push', 'origin', branch);
  const aheadRefs = remoteRefs();
  git('reset', '--hard', localHead);
  const refused = push(branch, '--remote', 'origin');
  assert.equal(refused.status, 1, 'Expected a non-fast-forward push to fail');
  assert.equal(refused.output.ok, false);
  assert.equal(remoteRefs(), aheadRefs);
});

test('M5.2 refuses the base branch, a protected glob match, and a non-current branch', (t) => {
  const { git, push, remoteRefs } = repo(t);
  git('branch', 'release/1');
  git('branch', 'feat/2-other');
  git('branch', branch);

  for (const [current, requested] of [
    ['main', 'main'],
    ['release/1', 'release/1'],
    [branch, 'feat/2-other'],
  ]) {
    git('switch', current);
    const result = push(requested, '--remote', 'origin');
    assert.equal(result.status, 1, `Expected push of ${requested} from ${current} to fail`);
    assert.equal(result.output.ok, false);
    assert.equal(remoteRefs(), '', `Expected origin to remain empty after refusing ${requested}`);
  }
  // A valid push in the same repo proves the earlier rejections were selective.
  assertPushed(push(branch, '--remote', 'origin'), branch);
});

const input = {
  issue: { number: 7, title: 'Render the ship body' },
  type: 'feat',
  scope: '#7',
  summary: 'Render the PR body in the CLI.',
  how: 'Fill the repo template from stage data.',
  riskLine: 'Risk: low - PR metadata only',
  stackLine: 'Stacked on #6 (feat/6-parent); it retargets to main when that PR merges.',
  isFix: true,
  rootCause: {
    cause: 'The agent omitted required lines.',
    introducedBy: 'PR #4',
    whyMissed: 'No test covered the PR footer.',
  },
  tests: ['M5.3 preserves the PR template headings'],
  checks: [{ name: 'unit tests', result: 'pass' }],
  verification: 'HTTP verification passed.',
  manualChecks: [{ row: 'AC7', result: 'pass', evidence: 'Observed the footer in the PR preview' }],
  reviewNotes: ['Low: defer copy edits'],
  decisions: ['Which format? -> Markdown (existing template)'],
  assumptions: ['GitHub renders Markdown.'],
  outOfScope: ['Update the issue template.'],
  reviewTrace: [
    'Review: pass after 2 round(s) - local devflow reviewer in this run (GitHub review: off)',
    'Path: short (Plan and Verify skipped)',
    'Verify: skipped (short path)',
  ],
  runMarker: '<!-- devflow-run {"path":"short","reviewRounds":2,"claimedAt":"2026-01-01T00:00:00Z"} -->',
  closes: [7],
};

function render(overrides = {}, args = ['--template', template]) {
  const { status, output } = invoke(['pr-body', ...args], { input: JSON.stringify({ ...input, ...overrides }) });
  assert.equal(status, 0, `pr-body should succeed: ${output.error}`);
  assert.equal(output.ok, true);
  assert.equal(typeof output.title, 'string');
  assert.equal(typeof output.body, 'string');
  return output;
}

function headings(markdown) {
  return markdown.match(/^## .+$/gm);
}

function section(body, heading) {
  const sections = body.split(/^## /m);
  const match = sections.find((part) => part.startsWith(heading + '\n'));
  assert.ok(match, `Expected a ${heading} section`);
  return match.slice(heading.length + 1).trim();
}

function assertTail(body, closes = input.closes) {
  const tail = [...input.reviewTrace, input.runMarker, ...closes.map((n) => `Closes #${n}`)];
  // Blank Markdown separator lines are allowed, but the content of each line is exact.
  const lines = body.split('\n');
  const review = lines.indexOf('## Review');
  assert.notEqual(review, -1, 'Expected a Review section');
  assert.deepEqual(lines.slice(review + 1).filter((line) => line !== ''), tail);
  assert.ok(body.includes(input.reviewTrace.join('\n')), 'Expected three consecutive review trace lines');
}

test('M5.3 fills the repo template in heading order and appends the exact review footer', () => {
  const { body } = render();
  assert.deepEqual(headings(body), [...headings(fs.readFileSync(template, 'utf8')), '## Review']);
  assert.deepEqual(body.match(/<!--[\s\S]*?-->/g), [input.runMarker]);
  assert.equal(body.split('<!--').length, 2);
  assert.equal(section(body, 'What'), input.summary);
  assert.equal(section(body, 'How'), input.how);
  assert.ok(section(body, 'Risk').split('\n').includes(input.riskLine));
  assert.ok(body.split('\n').includes(input.stackLine));
  for (const evidence of [input.tests[0], input.manualChecks[0].row, input.manualChecks[0].evidence]) {
    assert.ok(section(body, 'Tests').includes(evidence));
  }
  for (const value of Object.values(input.checks[0])) assert.ok(section(body, 'Checks').includes(value));
  assert.ok(section(body, 'Verification').includes(input.verification));
  for (const [heading, value] of [
    ['Review notes', input.reviewNotes[0]],
    ['Decisions taken', input.decisions[0]],
    ['Assumptions', input.assumptions[0]],
    ['Out of scope', input.outOfScope[0]],
  ]) {
    assert.ok(section(body, heading).includes(value), `Expected input in ${heading}`);
  }
  assertTail(body);
});

test('M5.4 omits fix sections and the stack line when inapplicable and fills fix sections when requested', () => {
  const fixSections = [
    ['Root cause', input.rootCause.cause],
    ['Introduced by', input.rootCause.introducedBy],
    ['Why it was missed', input.rootCause.whyMissed],
  ];
  const feature = render({ isFix: false, stackLine: '' }).body;
  assert.doesNotMatch(feature, /Stacked on/i);
  const fix = render().body;
  for (const [heading, value] of fixSections) {
    assert.ok(!headings(feature).includes('## ' + heading));
    assert.equal(section(fix, heading), value);
  }
});

test('M5.5 renders None for empty review notes, decisions, and out of scope lists', () => {
  const { body } = render({ reviewNotes: [], decisions: [], outOfScope: [] });
  for (const heading of ['Review notes', 'Decisions taken', 'Out of scope']) {
    assert.equal(section(body, heading), 'None');
  }
});

test('M5.6 strips the task prefix and caps the conventional title at 72 characters', () => {
  const issueTitle = 'A very long title ' + 'with additional context '.repeat(4).trimEnd();
  const { title } = render({ issue: { number: 7, title: '[wave4] T3: ' + issueTitle } });
  assert.equal(title, ('feat(#7): ' + issueTitle).slice(0, 72));
});

test('M5.7 renders the default headings and review footer without a template', () => {
  const expected = ['What', 'How', 'Risk', 'Tests', 'Checks', 'Verification', 'Review notes',
    'Decisions taken', 'Assumptions', 'Out of scope', 'Review'];
  const closes = [7, 19, 20];
  const { body } = render({ isFix: false, stackLine: '', closes }, []);
  assert.deepEqual(headings(body), expected.map((heading) => '## ' + heading));
  assertTail(body, closes);
});
