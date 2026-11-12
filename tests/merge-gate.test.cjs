'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../skills/init/templates/github/scripts/devflow-merge-gate.cjs');

const BASE = 'main';
const CONFIG = (over = {}) => ({
  baseBranch: BASE,
  mergeGate: { enabled: true, dryRun: false, requiredChecks: ['devflow/review'], method: 'merge', ...over },
});

const thread = ({ resolved = false, outdated = false, by = 'reviewer' } = {}) => ({
  isResolved: resolved,
  isOutdated: outdated,
  comments: { nodes: [{ author: { login: by } }] },
});

function makePr(number, over = {}) {
  return {
    number,
    draft: false,
    body: `Closes #${number + 100}`,
    labels: [{ name: 'devflow' }, { name: 'risk:low' }],
    base: { ref: BASE, repo: { full_name: 'o/r' } },
    head: { ref: `feat/${number}`, sha: `sha${number}`, repo: { full_name: 'o/r' } },
    user: { login: 'author' },
    mergeable: true,
    mergeable_state: 'clean',
    ...over,
  };
}

// In-memory fake of the Octokit surface the gate uses. `calls` records every call as [name, args].
function makeEnv({
  prs = [], runs = {}, statuses = {}, behind = {}, unresolved = {}, comments = [], issues = {}, files = {},
} = {}) {
  const calls = [];
  const rec = (name, fn) => async (args) => {
    calls.push([name, args]);
    return fn ? fn(args) : { data: {} };
  };
  const rest = {
    pulls: {
      list: rec('pulls.list', (a) => ({
        data: prs.filter((p) => (!a.base || p.base.ref === a.base) && (!a.state || a.state === 'open')),
      })),
      get: rec('pulls.get', (a) => ({ data: prs.find((p) => p.number === a.pull_number) })),
      update: rec('pulls.update', (a) => {
        prs.find((p) => p.number === a.pull_number).base.ref = a.base;
        return { data: {} };
      }),
      updateBranch: rec('pulls.updateBranch'),
      merge: rec('pulls.merge'),
      listFiles: rec('pulls.listFiles', (a) => ({ data: files[a.pull_number] || [{ filename: 'src/app.js' }] })),
    },
    repos: {
      compareCommitsWithBasehead: rec('compare', (a) => {
        const n = Number(a.basehead.match(/sha(\d+)/)[1]);
        return { data: { behind_by: behind[n] || 0 } };
      }),
      listCommitStatusesForRef: rec('statuses', (a) => ({
        data: (statuses[a.ref] || []).map((s) => ({ creator: { login: 'github-actions[bot]' }, ...s })),
      })),
      getContent: rec('getContent', () => {
        throw new Error('not found');
      }),
    },
    checks: { listForRef: rec('checks', (a) => ({ data: { check_runs: runs[a.ref] || [] } })) },
    issues: {
      get: rec('issues.get', (a) => {
        return { data: issues[a.issue_number] || { state: 'open', body: '' } };
      }),
      addLabels: rec('addLabels'),
      removeLabel: rec('removeLabel'),
      createComment: rec('createComment', (a) => {
        comments.push({ body: a.body });
        return { data: {} };
      }),
      listComments: rec('listComments', () => ({ data: comments })),
    },
    git: { deleteRef: rec('deleteRef') },
  };
  const github = {
    rest,
    paginate: async (fn, params) => {
      const res = await fn(params);
      return Array.isArray(res.data) ? res.data : res.data.check_runs;
    },
    graphql: async (_q, vars) => {
      calls.push(['graphql', vars]);
      const v = unresolved[vars.number] || 0;
      const nodes = Array.isArray(v)
        ? v
        : Array.from({ length: v }, () => thread({ by: 'reviewer' })).concat([thread({ resolved: true })]);
      return { repository: { pullRequest: { reviewThreads: { nodes } } } };
    },
  };
  const summary = { text: [], rows: null };
  const chain = {
    addHeading: () => chain,
    addRaw: (t) => (summary.text.push(t), chain),
    addTable: (rows) => ((summary.rows = rows), chain),
    write: async () => chain,
  };
  const messages = { failed: null };
  const core = { info() {}, warning() {}, setFailed: (m) => (messages.failed = m), summary: chain };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: {} };
  const names = (n) => calls.filter(([c]) => c === n);
  const decisions = () => (summary.rows || []).slice(1).map(([pr, action, reason]) => ({ pr, action, reason }));
  return { github, core, context, calls, names, summary, messages, decisions, comments };
}

const green = (n) => ({
  runs: { [`sha${n}`]: [{ name: 'devflow/review', status: 'completed', conclusion: 'success', id: 1, started_at: '2026-01-01' }] },
});

async function run(env, config) {
  await gate({ github: env.github, context: env.context, core: env.core, config });
  assert.equal(env.messages.failed, null);
}

const MUTATIONS = [
  'pulls.update', 'pulls.updateBranch', 'pulls.merge', 'addLabels', 'removeLabel', 'createComment', 'deleteRef',
];
const mutated = (env) => env.calls.filter(([c]) => MUTATIONS.includes(c));

test('disabled: no API calls', async () => {
  const env = makeEnv({ prs: [makePr(1)] });
  await run(env, CONFIG({ enabled: false }));
  assert.equal(env.calls.length, 0);
});

test('risk:high is skipped', async () => {
  const env = makeEnv({ prs: [makePr(1, { labels: [{ name: 'devflow' }, { name: 'risk:high' }] })] });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.match(env.decisions()[0].reason, /risk:high/);
  assert.equal(mutated(env).length, 0);
});

test('no risk label is skipped', async () => {
  const env = makeEnv({ prs: [makePr(1, { labels: [{ name: 'devflow' }] })] });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /no risk label/);
});

test('blocked label is skipped', async () => {
  const env = makeEnv({ prs: [makePr(1, { labels: [{ name: 'devflow' }, { name: 'risk:low' }, { name: 'agent:blocked' }] })] });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].reason, 'blocked');
});

test('stacked base is skipped', async () => {
  const env = makeEnv({ prs: [makePr(1, { base: { ref: 'feat/0', repo: { full_name: 'o/r' } } })] });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /stacked on feat\/0/);
});

test('conflict: labels PR and issue, comments once', async () => {
  const env = makeEnv({ prs: [makePr(1, { mergeable: false, mergeable_state: 'dirty' })] });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'blocked');
  const labelled = env.names('addLabels').map(([, a]) => a.issue_number).sort();
  assert.deepEqual(labelled, [1, 101]);
  assert.equal(env.names('createComment').length, 1);
  assert.match(env.comments[0].body, /devflow-gate:conflict/);
  assert.match(env.comments[0].body, /devflow:sync/);
  await run(env, CONFIG()); // second run: marker already present
  assert.equal(env.names('createComment').length, 1);
});

test('mergeable null is skipped', async () => {
  const env = makeEnv({ prs: [makePr(1, { mergeable: null })] });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /not computed/);
});

test('behind: updateBranch called, no merge', async () => {
  const env = makeEnv({ prs: [makePr(1)], behind: { 1: 3 }, ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'updated');
  assert.match(env.decisions()[0].reason, /behind main by 3/);
  assert.equal(env.names('pulls.updateBranch').length, 1);
  assert.equal(env.names('pulls.updateBranch')[0][1].expected_head_sha, 'sha1');
  assert.equal(env.names('pulls.merge').length, 0);
});

test('dryRun behind: no updateBranch', async () => {
  const env = makeEnv({ prs: [makePr(1)], behind: { 1: 3 } });
  await run(env, CONFIG({ dryRun: true }));
  assert.equal(env.names('pulls.updateBranch').length, 0);
  assert.equal(env.decisions()[0].action, 'would update');
});

test('pending check is skipped', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    runs: { sha1: [{ name: 'devflow/review', status: 'in_progress', conclusion: null, id: 1, started_at: 'x' }] },
  });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /waiting for devflow\/review: in_progress/);
  assert.equal(env.names('pulls.merge').length, 0);
});

test('latest run wins over an older success', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    runs: {
      sha1: [
        { name: 'devflow/review', status: 'completed', conclusion: 'success', id: 1, started_at: '2026-01-01T00:00:00Z' },
        { name: 'devflow/review', status: 'completed', conclusion: 'failure', id: 2, started_at: '2026-01-02T00:00:00Z' },
      ],
    },
  });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /failure/);
});

test('failing commit status is skipped; success status counts as green', async () => {
  const bad = makeEnv({ prs: [makePr(1)], statuses: { sha1: [{ context: 'devflow/review', state: 'failure' }] } });
  await run(bad, CONFIG());
  assert.match(bad.decisions()[0].reason, /waiting for devflow\/review: failure/);
  const ok = makeEnv({ prs: [makePr(1)], statuses: { sha1: [{ context: 'devflow/review', state: 'success' }, { context: 'devflow/review', state: 'failure' }] } });
  await run(ok, CONFIG());
  assert.equal(ok.decisions()[0].action, 'merged');
});

test('unresolved thread is skipped', async () => {
  const env = makeEnv({ prs: [makePr(1)], unresolved: { 1: 2 }, ...green(1) });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /2 unanswered review threads/);
  assert.equal(env.names('pulls.merge').length, 0);
});

test('resolved, outdated and author-answered threads do not block', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    unresolved: { 1: [thread({ resolved: true }), thread({ outdated: true }), thread({ by: 'author' })] },
    ...green(1),
  });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'merged');
});

test('thread whose last comment is by someone else blocks', async () => {
  const env = makeEnv({ prs: [makePr(1)], unresolved: { 1: [thread({ by: 'author' }), thread({ by: 'bob' })] }, ...green(1) });
  await run(env, CONFIG());
  assert.match(env.decisions()[0].reason, /1 unanswered review threads/);
});

test('all green: merge, retarget children, delete head branch', async () => {
  const child = makePr(2, { base: { ref: 'feat/1', repo: { full_name: 'o/r' } }, labels: [{ name: 'devflow' }] });
  const env = makeEnv({ prs: [makePr(1), child], ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'merged');
  const merge = env.names('pulls.merge')[0][1];
  assert.equal(merge.merge_method, 'merge');
  assert.equal(merge.sha, 'sha1');
  const upd = env.names('pulls.update')[0][1];
  assert.deepEqual([upd.pull_number, upd.base], [2, 'main']);
  assert.equal(env.names('deleteRef')[0][1].ref, 'heads/feat/1');
  const order = env.calls.map(([c]) => c);
  assert.ok(order.indexOf('pulls.update') < order.indexOf('deleteRef'));
});

test('real merge: commit trailer and one gate-merged comment', async () => {
  const env = makeEnv({ prs: [makePr(1, { title: 'feat: add x' })], ...green(1) });
  await run(env, CONFIG());
  const merge = env.names('pulls.merge')[0][1];
  assert.equal(merge.commit_title, 'Merge pull request #1 from feat/1 (devflow merge gate)');
  assert.ok(merge.commit_message.startsWith('feat: add x'));
  assert.ok(merge.commit_message.endsWith('Merged-by: devflow merge gate'));
  const posted = env.names('createComment');
  assert.equal(posted.length, 1);
  assert.ok(posted[0][1].body.startsWith(gate.GATE_MERGED_MARKER));
});

test('gate-merged comment is posted before cleanup, even when deleteRef fails', async () => {
  const env = makeEnv({ prs: [makePr(1)], ...green(1) });
  env.github.rest.git.deleteRef = async (a) => {
    env.calls.push(['deleteRef', a]);
    throw new Error('Reference does not exist');
  };
  await run(env, CONFIG({ method: 'rebase' }));
  const posted = env.names('createComment');
  assert.equal(posted.length, 1);
  assert.ok(posted[0][1].body.startsWith(gate.GATE_MERGED_MARKER));
  const order = env.calls.map(([c]) => c);
  assert.ok(order.indexOf('pulls.merge') < order.indexOf('createComment'));
  assert.ok(order.indexOf('createComment') < order.indexOf('deleteRef'));
});

test('rebase merge: no commit title or message', async () => {
  const env = makeEnv({ prs: [makePr(1)], ...green(1) });
  await run(env, CONFIG({ method: 'rebase' }));
  const merge = env.names('pulls.merge')[0][1];
  assert.equal(merge.commit_title, undefined);
  assert.equal(merge.commit_message, undefined);
});

test('dryRun: no gate-merged comment', async () => {
  const env = makeEnv({ prs: [makePr(1)], ...green(1) });
  await run(env, CONFIG({ dryRun: true }));
  assert.equal(env.names('createComment').length, 0);
});

test('fork head branch is not deleted', async () => {
  const pr = makePr(1, { head: { ref: 'feat/1', sha: 'sha1', repo: { full_name: 'fork/r' } } });
  const env = makeEnv({ prs: [pr], ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.names('pulls.merge').length, 1);
  assert.equal(env.names('deleteRef').length, 0);
});

test('dryRun all green: no mutations, "would merge"', async () => {
  const env = makeEnv({ prs: [makePr(1)], ...green(1) });
  await run(env, CONFIG({ dryRun: true }));
  assert.equal(env.decisions()[0].action, 'would merge');
  assert.equal(mutated(env).length, 0);
  assert.ok(env.summary.text.some((t) => /DRY RUN/.test(t)));
});

test('two eligible PRs: only one merged per run', async () => {
  const env = makeEnv({ prs: [makePr(2), makePr(1)], ...green(1), runs: { ...green(1).runs, ...green(2).runs } });
  await run(env, CONFIG());
  assert.equal(env.names('pulls.merge').length, 1);
  assert.equal(env.names('pulls.merge')[0][1].pull_number, 1);
  const d = env.decisions();
  assert.equal(d[0].pr, '#1');
  assert.equal(d[1].action, 'deferred');
  assert.match(d[1].reason, /one merge per run/);
});

test('a per-PR error does not stop the run', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2)], ...green(2) });
  const get = env.github.rest.pulls.get;
  env.github.rest.pulls.get = async (a) => {
    if (a.pull_number === 1) throw new Error('boom');
    return get(a);
  };
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'error');
  assert.equal(env.decisions()[1].action, 'merged');
});

test('open dependency of the linked issue is skipped', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    issues: { 101: { state: 'open', body: 'Depends on #50 and depends on #51' }, 50: { state: 'closed' }, 51: { state: 'open' } },
    ...green(1),
  });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.equal(env.decisions()[0].reason, 'waits for dependency #51 (open)');
  assert.equal(env.names('pulls.merge').length, 0);
  assert.equal(env.names('pulls.get').length, 0);
});

test('all dependencies closed: merges', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    issues: { 101: { state: 'open', body: 'Depends on #50, Depends on #51' }, 50: { state: 'closed' }, 51: { state: 'closed' } },
    ...green(1),
  });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'merged');
});

test('no linked issue: dependency rule does not apply', async () => {
  const env = makeEnv({ prs: [makePr(1, { body: 'no link' })], ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'merged');
  assert.equal(env.names('issues.get').length, 0);
});

test('issue reads are cached within a run', async () => {
  const env = makeEnv({
    prs: [makePr(1, { body: 'Closes #7' }), makePr(2, { body: 'Closes #7' })],
    issues: { 7: { state: 'open', body: 'Depends on #50' }, 50: { state: 'open' } },
  });
  await run(env, CONFIG());
  assert.equal(env.names('issues.get').length, 2); // #7 and #50, once each
});

test('candidates are ordered by the linked issue priority, then PR number', async () => {
  const prs = [makePr(1), makePr(2), makePr(3), makePr(4, { body: 'no link', labels: [{ name: 'devflow' }, { name: 'risk:low' }, { name: 'priority:high' }] })];
  const env = makeEnv({
    prs,
    issues: {
      101: { state: 'open', body: '', labels: [{ name: 'priority:low' }] },
      102: { state: 'open', body: '', labels: [] },
      103: { state: 'open', body: '', labels: [{ name: 'priority:critical' }] },
    },
    ...green(1), runs: { ...green(1).runs, ...green(2).runs, ...green(3).runs, ...green(4).runs },
  });
  await run(env, CONFIG());
  assert.deepEqual(env.decisions().map((d) => d.pr), ['#3', '#4', '#2', '#1']);
  assert.equal(env.names('pulls.merge')[0][1].pull_number, 3);
});

test('priority never loosens the rules: a critical risk:high PR is still skipped', async () => {
  const env = makeEnv({
    prs: [makePr(1, { labels: [{ name: 'devflow' }, { name: 'risk:high' }] }), makePr(2)],
    issues: { 101: { state: 'open', body: '', labels: [{ name: 'priority:critical' }] }, 102: { state: 'open', body: '', labels: [] } },
    ...green(1), runs: { ...green(1).runs, ...green(2).runs },
  });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].pr, '#1');
  assert.match(env.decisions()[0].reason, /risk:high/);
  assert.equal(env.names('pulls.merge')[0][1].pull_number, 2);
});

test('priorityRank and orderCandidates are exported and use labels.priority', async () => {
  assert.equal(gate.priorityRank(['p1'], ['p0', 'p1']), 1);
  assert.equal(gate.priorityRank([], ['priority:critical', 'priority:normal']), 1);
  const out = gate.orderCandidates([{ number: 2, rank: 1 }, { number: 1, rank: 1 }, { number: 3, rank: 0 }]);
  assert.deepEqual(out.map((p) => p.number), [3, 1, 2]);
  assert.deepEqual(gate.withDefaults({}).labels.priority, ['priority:critical', 'priority:high', 'priority:normal', 'priority:low']);
});

// Path-based risk: the label is a claim, the file list is the evidence.
test('risk:low PR touching a workflow is not merged and is relabelled high', async () => {
  const env = makeEnv({ prs: [makePr(1)], files: { 1: [{ filename: '.github/workflows/ci.yml' }] }, ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.match(env.decisions()[0].reason, /touches \.github\/workflows\/ci\.yml \(\.github\/\*\*\): waits for a human/);
  assert.equal(env.names('pulls.merge').length, 0);
  const added = env.names('addLabels')[0][1];
  assert.deepEqual([added.issue_number, added.labels], [1, ['risk:high']]);
  assert.equal(env.names('removeLabel')[0][1].name, 'risk:low');
});

test('a failing relabel does not throw past the gate', async () => {
  const env = makeEnv({ prs: [makePr(1)], files: { 1: [{ filename: '.claude/settings.json' }] }, ...green(1) });
  env.github.rest.issues.addLabels = async () => {
    throw new Error('forbidden');
  };
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.equal(env.names('pulls.merge').length, 0);
});

test('a configured risk.highPaths glob keeps the PR from merging', async () => {
  const env = makeEnv({ prs: [makePr(1)], files: { 1: [{ filename: 'src/auth/login.js' }] }, ...green(1) });
  await run(env, { ...CONFIG(), risk: { highPaths: ['src/auth/**'] } });
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.match(env.decisions()[0].reason, /touches src\/auth\/login\.js \(src\/auth\/\*\*\)/);
  assert.equal(env.names('pulls.merge').length, 0);
});

test('a rename whose previous name matches is not merged', async () => {
  const files = { 1: [{ filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' }] };
  const env = makeEnv({ prs: [makePr(1)], files, ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.match(env.decisions()[0].reason, /touches \.github\/workflows\/ci\.yml/);
  assert.equal(env.names('pulls.merge').length, 0);
});

test('ordinary files still merge, with highPaths configured or not', async () => {
  const env = makeEnv({ prs: [makePr(1)], files: { 1: [{ filename: 'src/app.js' }, { filename: 'README.md' }] }, ...green(1) });
  await run(env, { ...CONFIG(), risk: { highPaths: ['src/auth/**'] } });
  assert.equal(env.decisions()[0].action, 'merged');
  assert.equal(env.names('removeLabel').length, 0);
  const plain = makeEnv({ prs: [makePr(1)], ...green(1) });
  await run(plain, CONFIG());
  assert.equal(plain.decisions()[0].action, 'merged');
});

test('dry run: a high-path PR is reported but nothing is relabelled', async () => {
  const env = makeEnv({ prs: [makePr(1)], files: { 1: [{ filename: '.github/workflows/ci.yml' }] }, ...green(1) });
  await run(env, CONFIG({ dryRun: true }));
  assert.equal(env.decisions()[0].action, 'would skip');
  assert.match(env.decisions()[0].reason, /touches \.github\/workflows\/ci\.yml/);
  assert.equal(mutated(env).length, 0);
});

test('a high-path PR is not auto-updated when behind', async () => {
  const env = makeEnv({ prs: [makePr(1)], behind: { 1: 2 }, files: { 1: [{ filename: '.github/x.yml' }] }, ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.names('pulls.updateBranch').length, 0);
});

test('devflow/review status counts only from github-actions[bot]', async () => {
  const user = { creator: { login: 'mallory' }, context: 'devflow/review', state: 'success' };
  const bad = makeEnv({ prs: [makePr(1)], statuses: { sha1: [user] } });
  await run(bad, CONFIG());
  assert.equal(bad.decisions()[0].action, 'skipped');
  assert.match(bad.decisions()[0].reason, /waiting for devflow\/review/);
  const bot = { creator: { login: 'github-actions[bot]' }, context: 'devflow/review', state: 'success' };
  const ok = makeEnv({ prs: [makePr(1)], statuses: { sha1: [user, bot] } });
  await run(ok, CONFIG());
  assert.equal(ok.decisions()[0].action, 'merged');
  // The newest status from the bot decides, not a newer one from a user.
  const stale = makeEnv({ prs: [makePr(1)], statuses: { sha1: [user, { ...bot, state: 'failure' }, bot] } });
  await run(stale, CONFIG());
  assert.match(stale.decisions()[0].reason, /waiting for devflow\/review: failure/);
});

test('other status contexts are not restricted to the bot', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    statuses: { sha1: [{ creator: { login: 'ci-user' }, context: 'ci/build', state: 'success' }] },
    ...green(1),
  });
  await run(env, CONFIG({ requiredChecks: ['ci/build'] }));
  assert.equal(env.decisions()[0].action, 'merged');
});

test('globToRegExp matches the engine implementation', async () => {
  const { helpers } = require('../bin/devflow-scan');
  const engine = await helpers();
  const globs = [
    '.github/**', '.claude/**', '**/pyproject.toml', 'src/**/*.js', 'src/*.js', '*.md', 'a?c', 'docs/**/',
    '**/.eslintrc*', 'a.b+c', 'src/(x)/**', '**', 'dir/**/file',
  ];
  const paths = [
    '.github/workflows/ci.yml', '.github', '.claude/settings.json', 'pyproject.toml', 'pkg/pyproject.toml',
    'src/a.js', 'src/x/y/a.js', 'src/x/a.ts', 'README.md', 'docs/README.md', 'abc', 'a/c', 'a.b+c', 'aXb+c',
    'src/(x)/f', 'sub/.eslintrc.json', 'dir/file', 'dir/x/y/file', 'dir/xfile', 'docs/',
  ];
  for (const g of globs) {
    for (const p of paths) {
      assert.equal(gate.globToRegExp(g).test(p), engine.globToRegExp(g).test(p), `${g} vs ${p}`);
    }
  }
});

// ---- T4: the merge gate updates only the head of the queue ----
const WAIT = 'deferred: waits for its turn';
const dec = (env, n) => env.decisions().find((d) => Number(String(d.pr).replace(/\D/g, '')) === n);
const updatedFor = (env) => env.names('pulls.updateBranch').map(([, a]) => a.pull_number);
const runOf = (name, status, conclusion = null) => ({ name, status, conclusion, id: 1, started_at: '2026-01-01' });
const stat = (context, state) => ({ context, state });
const REVIEW = 'devflow/review';

// T4.1
test('test_t4_1_three_behind_prs_only_the_first_is_updated', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2), makePr(3)], behind: { 1: 2, 2: 2, 3: 2 } });
  await run(env, CONFIG());
  assert.deepEqual(updatedFor(env), [1]);
  assert.equal(dec(env, 1).action, 'updated');
  for (const n of [2, 3]) {
    assert.equal(dec(env, n).action, 'deferred');
    assert.equal(dec(env, n).reason, WAIT);
  }
});

// T4.2
test('test_t4_2_priority_order_picks_the_slot_holder', async () => {
  const env = makeEnv({
    prs: [makePr(1), makePr(5)],
    behind: { 1: 2, 5: 2 },
    issues: {
      101: { state: 'open', body: '', labels: [] },
      105: { state: 'open', body: '', labels: [{ name: 'priority:critical' }] },
    },
  });
  await run(env, CONFIG());
  assert.deepEqual(updatedFor(env), [5]);
  assert.equal(dec(env, 5).action, 'updated');
  assert.equal(dec(env, 1).action, 'deferred');
});

// T4.3
test('test_t4_3_a_skipped_behind_draft_does_not_take_the_slot', async () => {
  const env = makeEnv({ prs: [makePr(1, { draft: true }), makePr(2)], behind: { 1: 2, 2: 2 } });
  await run(env, CONFIG());
  assert.equal(dec(env, 1).action, 'skipped');
  assert.match(dec(env, 1).reason, /draft/);
  assert.equal(dec(env, 2).action, 'updated');
  assert.deepEqual(updatedFor(env), [2]);
});

// T4.4
const T44 = {
  'risk:high': { pr: { labels: [{ name: 'devflow' }, { name: 'risk:high' }] } },
  blocked: { pr: { labels: [{ name: 'devflow' }, { name: 'risk:low' }, { name: 'agent:blocked' }] } },
  stacked: { pr: { base: { ref: 'feat/0', repo: { full_name: 'o/r' } } } },
  'open dependency': {
    env: { issues: { 101: { state: 'open', body: 'Depends on #50' }, 50: { state: 'open' } } },
  },
  'highPaths file': { env: { files: { 1: [{ filename: '.github/x.yml' }] } } },
  conflict: { pr: { mergeable: false, mergeable_state: 'dirty' } },
};
for (const [rule, c] of Object.entries(T44)) {
  test(`test_t4_4_${rule.replace(/\W+/g, '_')}_first_pr_leaves_the_slot_free`, async () => {
    const env = makeEnv({ prs: [makePr(1, c.pr), makePr(2)], behind: { 1: 2, 2: 2 }, ...(c.env || {}) });
    await run(env, CONFIG());
    assert.notEqual(dec(env, 1).action, 'updated');
    assert.equal(dec(env, 2).action, 'updated');
    assert.deepEqual(updatedFor(env), [2]);
  });
}

// T4.5
test('test_t4_5_mergeable_null_does_not_take_the_slot', async () => {
  const env = makeEnv({ prs: [makePr(1, { mergeable: null }), makePr(2)], behind: { 2: 2 } });
  await run(env, CONFIG());
  assert.equal(dec(env, 1).action, 'skipped');
  assert.match(dec(env, 1).reason, /mergeability not computed yet/);
  assert.equal(dec(env, 2).action, 'updated');
});

// T4.6
const T46 = {
  'pending status': { statuses: { sha1: [stat(REVIEW, 'pending')] } },
  'queued run': { runs: { sha1: [runOf(REVIEW, 'queued')] } },
  'in_progress run': { runs: { sha1: [runOf(REVIEW, 'in_progress')] } },
};
for (const [name, c] of Object.entries(T46)) {
  test(`test_t4_6_in_flight_${name.replace(/\W+/g, '_')}_holds_the_slot`, async () => {
    const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 }, ...c });
    await run(env, CONFIG());
    assert.equal(dec(env, 1).action, 'skipped');
    assert.match(dec(env, 1).reason, /waiting for devflow\/review/);
    assert.equal(dec(env, 2).action, 'deferred');
    assert.equal(dec(env, 2).reason, WAIT);
    assert.equal(env.names('pulls.updateBranch').length, 0);
  });
}

// T4.7
test('test_t4_7_up_to_date_with_failed_check_does_not_hold_the_slot', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 }, statuses: { sha1: [stat(REVIEW, 'failure')] } });
  await run(env, CONFIG());
  assert.equal(dec(env, 1).action, 'skipped');
  assert.match(dec(env, 1).reason, /waiting for devflow\/review/);
  assert.equal(dec(env, 2).action, 'updated');
});

// T4.8
for (const status of [502, 422, 403]) {
  test(`test_t4_8_update_branch_error_${status}_frees_the_slot`, async () => {
    const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 1: 2, 2: 2 } });
    const orig = env.github.rest.pulls.updateBranch;
    env.github.rest.pulls.updateBranch = async (args) => {
      if (args.pull_number === 1) {
        env.calls.push(['pulls.updateBranch', args]);
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }
      return orig(args);
    };
    await run(env, CONFIG());
    assert.equal(dec(env, 1).action, 'error');
    assert.equal(dec(env, 2).action, 'updated');
    assert.deepEqual(updatedFor(env), [1, 2]);
  });
}

// T4.9
test('test_t4_9_update_and_merge_in_one_run', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 1: 2 }, ...green(2) });
  await run(env, CONFIG());
  assert.equal(dec(env, 1).action, 'updated');
  assert.deepEqual(env.names('pulls.merge').map(([, a]) => a.pull_number), [2]);
  assert.equal(dec(env, 2).action, 'merged');
});

// T4.10
test('test_t4_10_no_update_after_a_merge', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 }, ...green(1) });
  await run(env, CONFIG());
  assert.equal(dec(env, 1).action, 'merged');
  assert.equal(dec(env, 2).action, 'deferred');
  assert.equal(dec(env, 2).reason, 'deferred: one merge per run');
  assert.equal(env.names('pulls.updateBranch').length, 0);
});

// T4.11
test('test_t4_11_dry_run_would_update_plus_deferred_no_calls', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 1: 2, 2: 2 } });
  await run(env, CONFIG({ dryRun: true }));
  assert.equal(dec(env, 1).action, 'would update');
  assert.equal(dec(env, 2).action, 'deferred');
  assert.equal(dec(env, 2).reason, WAIT);
  assert.equal(env.names('pulls.updateBranch').length, 0);
});

// T4.13
test('test_t4_13_a_missing_check_does_not_hold_the_slot', async () => {
  const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 } });
  await run(env, CONFIG());
  assert.equal(dec(env, 1).action, 'skipped');
  assert.equal(dec(env, 1).reason, 'waiting for devflow/review: missing');
  assert.equal(dec(env, 2).action, 'updated');
  assert.deepEqual(updatedFor(env), [2]);
});

// T4.14
const TWO = ['devflow/review', 'test'];
const T414 = {
  'status pending, run failure': {
    statuses: { sha1: [stat(REVIEW, 'pending')] }, runs: { sha1: [runOf('test', 'completed', 'failure')] },
  },
  'swapped: status failure, run in_progress': {
    statuses: { sha1: [stat(REVIEW, 'failure')] }, runs: { sha1: [runOf('test', 'in_progress')] },
  },
  'test cancelled': {
    statuses: { sha1: [stat(REVIEW, 'pending')] }, runs: { sha1: [runOf('test', 'completed', 'cancelled')] },
  },
  'test status error': {
    statuses: { sha1: [stat(REVIEW, 'pending'), stat('test', 'error')] },
  },
};
for (const [name, c] of Object.entries(T414)) {
  test(`test_t4_14_failed_next_to_running_${name.replace(/\W+/g, '_')}_does_not_hold_the_slot`, async () => {
    const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 }, ...c });
    await run(env, CONFIG({ requiredChecks: TWO }));
    assert.equal(dec(env, 1).action, 'skipped');
    assert.equal(dec(env, 2).action, 'updated');
  });
}

// T4.15
for (const status of ['waiting', 'requested']) {
  test(`test_t4_15_${status}_run_does_not_hold_the_slot`, async () => {
    const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 }, runs: { sha1: [runOf(REVIEW, status)] } });
    await run(env, CONFIG());
    assert.equal(dec(env, 1).action, 'skipped');
    assert.match(dec(env, 1).reason, /waiting for devflow\/review/);
    assert.equal(dec(env, 2).action, 'updated');
  });
}

// T4.16
for (const [label, names] of [['review first', TWO], ['review last', [...TWO].reverse()]]) {
  test(`test_t4_16_running_next_to_missing_holds_the_slot_${label.replace(/\W+/g, '_')}`, async () => {
    const env = makeEnv({ prs: [makePr(1), makePr(2)], behind: { 2: 2 }, statuses: { sha1: [stat(REVIEW, 'pending')] } });
    await run(env, CONFIG({ requiredChecks: names }));
    assert.equal(dec(env, 1).action, 'skipped');
    assert.equal(dec(env, 2).action, 'deferred');
    assert.equal(dec(env, 2).reason, WAIT);
    assert.equal(env.names('pulls.updateBranch').length, 0);
  });
}
