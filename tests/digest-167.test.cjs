'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const cli = join(root, 'bin', 'devflow-digest');
const read = (file) => readFileSync(join(root, file), 'utf8');
const day = { epic: 162, date: '2026-11-26' };
const heading = '## Daily digest 2026-11-26 (epic #162)';
const sections = [
  'PRs waiting for you', 'Decisions to review', 'Bugs filed',
  'Waiting or blocked', 'Done today', 'Cost',
];
const warning = 'nextTask.maxAgentCalls is 0 (unlimited per issue).';
const render = (fields) => require(cli).renderDigest({ ...day, ...fields });

function section(markdown, title) {
  const blocks = markdown.split(/^###\s+/m).slice(1);
  const block = blocks.find((text) => text.split('\n', 1)[0].trim() === title);
  assert.ok(block, `Expected a section named ${title}`);
  return block.slice(block.indexOf('\n') + 1).trim();
}

function pr(number, title, risk, decisionsReview, openedAt) {
  return { number, title, risk, decisionsReview, openedAt, url: `https://example.com/pull/${number}` };
}

test('A6.1 a full digest starts with the epic and date, followed by the six sections in order', () => {
  const markdown = render({
    waitingPrs: [pr(1, 'Cache retry', 'high', false, '2026-11-25T10:00:00Z')],
    decisions: [{ issue: 5, question: 'Retry?', option: 'Once', needsReview: true }],
    bugs: [{ number: 9, title: 'Timeout', url: 'https://example.com/issues/9', forIssue: 5 }],
    waiting: [{ issue: 6, reason: 'waits for #5 (no PR yet)' }],
    doneToday: { mergedPrs: [{ number: 2, title: 'Fix parser', mergedBy: 'gate' }], closedIssues: [3] },
    cost: [{ pr: 1, agentCalls: 12 }, { pr: 2, agentCalls: null }],
    warnings: [warning],
  });
  const lines = markdown.trim().split(/\r?\n/);
  assert.equal(lines[0], heading);
  assert.deepEqual(lines.filter((line) => /^#{2,3}\s/.test(line)), [heading, ...sections.map((s) => '### ' + s)]);
});

test('A6.2 high-risk PRs sort oldest first, ahead of decisions to review and ordinary PRs', () => {
  const waitingPrs = [
    pr(40, 'Update docs', 'low', false, '2026-11-20T08:00:00Z'),
    pr(30, 'API limit', 'high', false, '2026-11-25T18:00:00Z'),
    pr(20, 'Parser change', 'low', true, '2026-11-21T08:00:00Z'),
    pr(10, 'Cache retry', 'high', true, '2026-11-25T09:00:00Z'),
  ];
  const body = section(render({ waitingPrs }), 'PRs waiting for you');
  let previous = -1;
  for (const title of ['Cache retry', 'API limit', 'Parser change', 'Update docs']) {
    const index = body.indexOf(title);
    assert.ok(index > previous, `Expected ${title} next in the waiting PRs:\n${body}`);
    previous = index;
  }
});

test('A6.3 omitting every optional list yields None in each section', () => {
  const markdown = render({});
  for (const title of sections) assert.match(section(markdown, title), /^(?:[-*] )?None$/, title);
});

test('A6.4 Cost sums known agent calls and counts PRs with null or missing counts', () => {
  for (const unknown of [{ pr: 3, agentCalls: null }, { pr: 3 }]) {
    const cost = [{ pr: 1, agentCalls: 12 }, { pr: 2, agentCalls: 30 }, unknown];
    const body = section(render({ cost }), 'Cost');
    assert.match(body, /\b42 agent calls\b/);
    assert.match(body, /\b1 PR(?:\(s\))? unknown\b/);
  }
});

test('A6.5 Ship records the issue agent-call count and existing trace fields in the PR payload marker', async () => {
  // Reuse the stub engine fixture without registering engine.test.cjs's own tests.
  const fixture = read('tests/engine.test.cjs').split(/^test\(/m)[0];
  const { run, BASE } = new Function('require', '__dirname', fixture + '\nreturn { run, BASE };')(require, __dirname);
  const { rep, calls } = await run({ ...BASE, issues: [7] }, { labels: ['risk:low'], body: 'Risk: low' });
  assert.equal(rep[0].status, 'pr', rep[0].reason);
  const ship = calls.findIndex((call) => call.l === 'ship #7');
  const claim = calls.findIndex((call) => call.l === 'claim #7');
  assert.ok(claim >= 0 && ship > claim, 'Expected Claim followed by Ship for issue #7');

  const field = /"runMarker"\s*:\s*("(?:\\.|[^"\\])*")/.exec(calls[ship].prompt);
  assert.ok(field, 'Expected runMarker in the PR body payload');
  const marker = /^<!-- devflow-run (\{.*\}) -->$/.exec(JSON.parse(field[1]));
  assert.ok(marker, 'Expected a devflow-run comment with JSON');
  const trace = JSON.parse(marker[1]);
  assert.equal(trace.path, 'short');
  assert.equal(trace.reviewRounds, 1);
  assert.equal(trace.claimedAt, '2026-01-01T00:00:05Z');
  assert.equal(typeof trace.agentCalls, 'number', 'Expected numeric agentCalls in the PR marker');
  assert.equal(trace.agentCalls, ship - claim, 'Count issue calls from Claim up to the construction of the Ship prompt');
});

test('A6.6 report --daily prints the digest without posting or creating an artifact', () => {
  const skill = read('skills/report/SKILL.md');
  assert.ok(skill.includes('--daily'), 'Expected a --daily mode in the report skill');
  const daily = skill.split(/(?=^#{1,6} )/m).filter((part) => /--daily\b|bin\/devflow-digest/.test(part)).join('\n');
  assert.match(daily, /bin\/devflow-digest\b/);
  assert.match(daily, /\b(?:print|output|stdout|display|return|show)\b/i, 'Daily mode prints the Markdown');
  assert.match(daily, /posts? nothing|no (?:GitHub )?(?:posts?|comments?|writes?)\b|(?:never|do not|does not|without)\s+post/i,
    'Daily mode posts nothing');
  assert.match(daily, /no artifacts?\b|(?:never|do not|does not|skip|without)\b[^.\n]*\bartifacts?\b/i,
    'Daily mode creates no artifact');
});

test('A6.7 autopilot posts a dated epic digest once per local day and at finish, editing an existing comment', () => {
  const skill = read('skills/autopilot/SKILL.md');
  const reportStart = /^(?:\*\*\(e\)|#{1,6}[^\n]*)\s+Report\b/im.exec(skill);
  assert.ok(reportStart, 'Expected the autopilot Report step');
  const report = skill.slice(reportStart.index).split(/^#{1,6} (?:\d+\. )?(?:Loop|Finish)\b/im)[0];
  assert.match(report, /<!-- devflow-digest\s+(?:<?YYYY-MM-DD>?|\d{4}-\d{2}-\d{2})\s*-->/i,
    'Expected a digest comment marker containing the date');
  assert.match(report, /\blocal\b/i, 'Use the local calendar day');
  assert.match(report, /lastDigestDate[^.\n]*(?:today|local date)|(?:today|local date)[^\n]*lastDigestDate/i,
    'Check lastDigestDate against today before posting');
  assert.match(report, /\b(?:if|unless|when|skip|only|once)\b[^\n]*(?:lastDigestDate|per local day)/i,
    'Gate the daily post on the saved date');
  assert.match(report, /\b(?:post|add|create)\b[^.\n]*\bepic\b|\bepic\b[^.\n]*\b(?:post|add|create)\b/i,
    'Post the digest on the epic');
  assert.match(report, /\b(?:edit|update|replace)\b[^.\n]*(?:existing|matching|same.day|that comment|\bit\b)|(?:exists|found|matches|same.day)[^.\n]*\b(?:edit|update|replace)\b/i,
    'Edit the existing comment for this date');
  assert.match(report, /(?:set|update|save|record|store|advance|write)\s+(?:the (?:plan's )?)?`?(?:plan\.)?lastDigestDate|lastDigestDate`?\s*=(?!=)/i,
    'Save the new lastDigestDate');
  const finish = skill.split(/(?=^#{1,6} )/m).find((part) => /^#{1,6} (?:\d+\. )?Finish\b/i.test(part)) || '';
  const finalDigest = /(?:final|finish|completion|at the end|done)[^.\n]*\bdigest\b|\bdigest\b[^.\n]*(?:finish|completion|at the end|done)/i;
  assert.ok(/\bdigest\b/i.test(finish) || finalDigest.test(report), 'Post the digest at the end of the run');
});

test('A6.8 the executable handles help and invalid JSON, and prints warnings before the first section', () => {
  function run(args, input = '') {
    const result = spawnSync(cli, args, { input, encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
  }
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\S/);
  assert.equal(run([], '{broken').status, 1);

  const { status, stdout, stderr } = run([], JSON.stringify({ ...day, warnings: [warning] }));
  assert.equal(status, 0, stderr);
  const firstSection = /^###\s/m.exec(stdout);
  assert.ok(firstSection, 'Expected a Markdown section on stdout');
  const preamble = stdout.slice(0, firstSection.index).trim();
  assert.equal(preamble.split(/\r?\n/, 1)[0], heading);
  assert.ok(preamble.includes(warning), 'Expected the input warning between the digest heading and the first section');
});
