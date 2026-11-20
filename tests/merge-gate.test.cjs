'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../skills/init/templates/github/scripts/devflow-merge-gate.cjs');

const BASE = 'main';
const CONFIG = (over = {}) => ({
  baseBranch: BASE,
  review: { github: true }, // T2.9: existing fixtures run with the GitHub review on, as in 2.9.0
  mergeGate: { enabled: true, dryRun: false, requiredChecks: ['devflow/review'], method: 'merge', ...over },
});

// Internal thread form: `first` / `last` comment descriptors; the graphql stub shapes them to the query asked.
// A comment descriptor: { by, type = 'User', assoc } ; by === null means a deleted author; assoc undefined means missing.
const cnode = (c) => {
  const n = { author: c.by === null ? null : { login: c.by, __typename: c.type || 'User' } };
  if (c.assoc !== undefined) n.authorAssociation = c.assoc;
  return n;
};
// Legacy helper (Decision #32 Q1): the first comment is by the PR author (OWNER), `by` is the last comment's author.
const thread = ({ resolved = false, outdated = false, by = 'reviewer' } = {}) => ({
  isResolved: resolved,
  isOutdated: outdated,
  _first: { by: 'author', type: 'User', assoc: 'OWNER' },
  _last: { by },
});
// T5 helper: first comment descriptor, last comment descriptor (default: same as first), none = no comment nodes.
const tthread = ({ first, last, resolved = false, outdated = false, none = false } = {}) => ({
  isResolved: resolved,
  isOutdated: outdated,
  _first: none ? null : first,
  _last: none ? null : last || first,
});
const shapeThread = (t, query) => {
  const out = { isResolved: t.isResolved, isOutdated: t.isOutdated };
  const firstAlias = query.match(/(\w+)\s*:\s*comments\(\s*first\s*:\s*1\s*\)/);
  const lastAlias = query.match(/(\w+)\s*:\s*comments\(\s*last\s*:\s*1\s*\)/);
  const f = t._first ? [cnode(t._first)] : [];
  const l = t._last ? [cnode(t._last)] : [];
  if (firstAlias) out[firstAlias[1]] = { nodes: f };
  if (lastAlias) out[lastAlias[1]] = { nodes: l };
  if (!firstAlias || !lastAlias) out.comments = { nodes: !t._first ? [] : f.length && l.length && t._first !== t._last ? [f[0], l[0]] : l };
  return out;
};

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
  listedIssues = [], removeLabelError,
  prs = [], runs = {}, statuses = {}, behind = {}, unresolved = {}, comments = [], issues = {}, files = {},
} = {}) {
  const calls = [];
  const queries = [];
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
      listForRepo: rec('issues.listForRepo', ({ owner, repo, state, per_page = 30, page = 1 }) => ({
        data: listedIssues.filter((issue) =>
          issue.repository_url === `https://api.github.com/repos/${owner}/${repo}`
          && (state === 'all' || issue.state === (state || 'open')),
        ).slice((page - 1) * per_page, page * per_page),
      })),
      removeLabel: rec('removeLabel', (args) => {
        const error = removeLabelError?.(args);
        if (error) throw error;
        return { data: {} };
      }),
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
      if (fn === rest.issues.listForRepo) calls.push(['paginate issues.listForRepo', params]);
      const res = await fn(params);
      return Array.isArray(res.data) ? res.data : res.data.check_runs;
    },
    graphql: async (q, vars) => {
      calls.push(['graphql', vars]);
      queries.push(q);
      const v = unresolved[vars.number] || 0;
      const nodes = Array.isArray(v)
        ? v
        : Array.from({ length: v }, () => thread({ by: 'reviewer' })).concat([thread({ resolved: true })]);
      return { repository: { pullRequest: { reviewThreads: { nodes: nodes.map((t) => shapeThread(t, q)) } } } };
    },
  };
  const summary = { text: [], rows: null };
  const chain = {
    addHeading: () => chain,
    addRaw: (t) => (summary.text.push(t), chain),
    addTable: (rows) => ((summary.rows = rows), chain),
    write: async () => chain,
  };
  const messages = { failed: null, warnings: [] };
  const core = { info() {}, warning: (m) => messages.warnings.push(m), setFailed: (m) => (messages.failed = m), summary: chain };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: {} };
  const names = (n) => calls.filter(([c]) => c === n);
  const decisions = () => (summary.rows || []).slice(1).map(([pr, action, reason]) => ({ pr, action, reason }));
  return { github, core, context, calls, queries, names, summary, messages, decisions, comments };
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

// ---- T5: collaborator threads ----
const REV = (assoc, type = 'User') => ({ by: 'rev', type, assoc });
const AUTH = { by: 'author', type: 'User', assoc: 'OWNER' };
async function gateWith(threads, prOver = {}) {
  const env = makeEnv({ prs: [makePr(1, prOver)], unresolved: { 1: threads }, ...green(1) });
  await run(env, CONFIG());
  return env;
}
const blocks = async (threads, n = 1, prOver) => {
  const env = await gateWith(threads, prOver);
  const d = env.decisions()[0];
  assert.equal(d.action, 'skipped');
  assert.match(d.reason, new RegExp(`^${n} unanswered review threads`));
  assert.equal(env.names('pulls.merge').length, 0);
};
const merges = async (threads, prOver) => {
  const env = await gateWith(threads, prOver);
  assert.equal(env.decisions()[0].action, 'merged');
};

test('test_t5_1_collaborator_thread_blocks_after_author_reply', async () => {
  await blocks([tthread({ first: REV('COLLABORATOR'), last: AUTH })]);
});

test('test_t5_2_owner_and_member_also_block', async () => {
  for (const a of ['OWNER', 'MEMBER']) await blocks([tthread({ first: REV(a), last: AUTH })]);
});

test('test_t5_3_resolved_or_outdated_does_not_block', async () => {
  await merges([tthread({ first: REV('COLLABORATOR'), last: AUTH, resolved: true })]);
  await merges([tthread({ first: REV('COLLABORATOR'), last: AUTH, outdated: true })]);
});

test('test_t5_4_untrusted_association_does_not_block', async () => {
  for (const a of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR']) {
    await merges([tthread({ first: { by: 'stranger', assoc: a } })]);
  }
});

test('test_t5_5_no_author_no_association_or_no_comments_does_not_block', async () => {
  await merges([
    tthread({ first: { by: null, assoc: 'OWNER' }, last: AUTH }),
    tthread({ first: { by: 'rev', type: 'User' }, last: AUTH }),
    tthread({ none: true }),
  ]);
});

test('test_t5_6_bot_pr_author_trusted_human_thread_blocks', async () => {
  await blocks(
    [tthread({ first: REV('OWNER'), last: { by: 'devflow-bot', type: 'Bot', assoc: 'NONE' } })],
    1,
    { user: { login: 'devflow-bot[bot]' } },
  );
});

test('test_t5_7_claude_bot_thread_follows_todays_rule', async () => {
  const claude = { by: 'claude', type: 'Bot', assoc: 'NONE' };
  await blocks([tthread({ first: claude, last: REV('NONE') })]);
  await merges([tthread({ first: claude, last: AUTH })]);
});

test('test_t5_8_bot_login_suffix_is_ignored_when_comparing', async () => {
  await merges(
    [tthread({ first: { by: 'claude', type: 'Bot', assoc: 'NONE' }, last: { by: 'renovate', type: 'Bot' } })],
    { user: { login: 'renovate[bot]' } },
  );
});

test('test_t5_9_author_started_thread_follows_todays_rule', async () => {
  await blocks([tthread({ first: AUTH, last: REV('NONE') })]);
  await merges([tthread({ first: AUTH, last: AUTH })]);
});

test('test_t5_10_count_includes_only_blocking_threads', async () => {
  await blocks(
    [
      tthread({ first: REV('COLLABORATOR'), last: AUTH }),
      tthread({ first: { by: 'stranger', assoc: 'NONE' } }),
      tthread({ first: { by: 'claude', type: 'Bot', assoc: 'NONE' }, last: AUTH }),
      tthread({ first: AUTH, last: REV('NONE') }),
    ],
    2,
  );
});

test('test_t5_11_query_asks_for_type_association_first_and_last_comment', async () => {
  const env = await gateWith([tthread({ first: REV('COLLABORATOR'), last: AUTH })]);
  const q = env.queries.join('\n');
  assert.match(q, /__typename/);
  assert.match(q, /authorAssociation/);
  assert.match(q, /comments\(\s*first\s*:\s*1\s*\)/);
  assert.match(q, /comments\(\s*last\s*:\s*1\s*\)/);
});

test('test_t5_13_other_bots_threads_do_not_block', async () => {
  for (const b of ['coderabbitai', 'copilot-pull-request-reviewer']) {
    const bot = { by: b, type: 'Bot', assoc: 'NONE' };
    await merges([tthread({ first: bot, last: bot })]);
    await merges([tthread({ first: bot, last: REV('NONE') })]);
  }
});

test('test_t5_14_human_named_claude_is_not_the_review_bot', async () => {
  await merges([tthread({ first: { by: 'claude', type: 'User', assoc: 'NONE' }, last: AUTH })]);
  await blocks([tthread({ first: { by: 'claude', type: 'User', assoc: 'COLLABORATOR' }, last: AUTH })]);
});

// ---- T2 (wave2-lighter-flow, issue #53): effective required checks ----
const REFUSAL = 'no required checks (devflow/review is ignored while review.github is off); refusing to merge';
const T2CONFIG = (github, over = {}) => ({
  baseBranch: BASE,
  ...(github === undefined ? {} : { review: { github } }),
  mergeGate: { enabled: true, dryRun: false, requiredChecks: ['devflow/review', 'test'], method: 'merge', ...over },
});
const ciRun = (n, conclusion = 'success', status = 'completed') => ({
  runs: { [`sha${n}`]: [{ name: 'test', status, conclusion, id: 5, started_at: '2026-01-01' }] },
});

// T2.1
test('test_t2_1_effective_checks_flag_on', () => {
  const cfg = { review: { github: true }, mergeGate: { requiredChecks: ['devflow/review', 'test'] } };
  assert.deepEqual(gate.effectiveRequiredChecks(cfg), ['devflow/review', 'test']);
});

// T2.2
test('test_t2_2_effective_checks_flag_off_or_absent', () => {
  const checks = ['devflow/review', 'test'];
  const off = { review: { github: false }, mergeGate: { requiredChecks: checks } };
  assert.deepEqual(gate.effectiveRequiredChecks(off), ['test']);
  const absent = gate.withDefaults({ mergeGate: { requiredChecks: checks } });
  assert.deepEqual(gate.effectiveRequiredChecks(absent), ['test']);
});

// T2.3
test('test_t2_3_merges_on_ci_when_review_off', async () => {
  const live = makeEnv({ prs: [makePr(1)], ...ciRun(1) });
  await run(live, T2CONFIG(false));
  assert.equal(live.names('pulls.merge').length, 1);
  assert.equal(live.decisions()[0].action, 'merged');
  const dry = makeEnv({ prs: [makePr(1)], ...ciRun(1) });
  await run(dry, T2CONFIG(false, { dryRun: true }));
  assert.equal(dry.decisions()[0].action, 'would merge');
  assert.equal(dry.names('pulls.merge').length, 0);
});

// T2.4
test('test_t2_4_no_merge_when_ci_not_green', async () => {
  for (const [conclusion, status] of [['failure', 'completed'], [null, 'in_progress']]) {
    const env = makeEnv({ prs: [makePr(1)], ...ciRun(1, conclusion, status) });
    await run(env, T2CONFIG(false));
    assert.equal(env.names('pulls.merge').length, 0);
    assert.notEqual(env.decisions()[0].action, 'merged');
  }
});

// T2.5
test('test_t2_5_stale_review_status_ignored_when_off', async () => {
  const env = makeEnv({
    prs: [makePr(1)],
    ...ciRun(1),
    statuses: { sha1: [{ context: 'devflow/review', state: 'failure' }] },
  });
  await run(env, T2CONFIG(false));
  assert.equal(env.decisions()[0].action, 'merged');
  assert.equal(env.names('pulls.merge').length, 1);
});

// T2.6 and T2.7 shared assertion
async function assertRefuses(config) {
  for (const dryRun of [false, true]) {
    const env = makeEnv({
      prs: [makePr(1, { mergeable: false, mergeable_state: 'dirty' }), makePr(2)],
      behind: { 2: 3 },
      ...ciRun(2),
    });
    await run(env, { ...config, mergeGate: { ...config.mergeGate, dryRun } });
    assert.equal(mutated(env).length, 0, `no mutating call (dryRun=${dryRun})`);
    const d = env.decisions();
    assert.equal(d.length, 2, 'a row per candidate');
    for (const row of d) {
      assert.equal(row.action, 'skipped');
      assert.equal(row.reason, REFUSAL);
    }
    assert.ok(env.summary.rows, 'summary written');
  }
}

// T2.6
test('test_t2_6_refuses_when_only_review_check_and_off', async () => {
  await assertRefuses(T2CONFIG(false, { requiredChecks: ['devflow/review'] }));
  const noList = T2CONFIG(false);
  delete noList.mergeGate.requiredChecks;
  await assertRefuses(noList);
});

// T2.7
test('test_t2_7_refuses_empty_required_checks_either_flag', async () => {
  await assertRefuses(T2CONFIG(true, { requiredChecks: [] }));
  await assertRefuses(T2CONFIG(false, { requiredChecks: [] }));
});

// T2.8
test('test_t2_8_review_status_requires_bot_creator_when_on', async () => {
  const mk = (login) => ({
    prs: [makePr(1)],
    statuses: { sha1: [{ creator: { login }, context: 'devflow/review', state: 'success' }] },
  });
  const cfg = T2CONFIG(true, { requiredChecks: ['devflow/review'] });
  const user = makeEnv(mk('alice'));
  await run(user, cfg);
  assert.equal(user.names('pulls.merge').length, 0);
  const bot = makeEnv(mk('github-actions[bot]'));
  await run(bot, cfg);
  assert.equal(bot.names('pulls.merge').length, 1);
});

// T2.9: the shared CONFIG fixture now sets review.github: true; every test above this block runs against it.
test('test_t2_9_flag_on_matches_290', async () => {
  assert.equal(CONFIG().review.github, true);
  const env = makeEnv({ prs: [makePr(1)], ...green(1) });
  await run(env, CONFIG());
  assert.equal(env.decisions()[0].action, 'merged');
  const none = makeEnv({ prs: [makePr(1)] });
  await run(none, CONFIG());
  assert.notEqual(none.decisions()[0].action, 'merged');
});

// ---- #110 T5: decisions:review PRs wait for a human unless nextTask.trustDecisions is true ----
const DECISIONS_REASON = 'decisions:review: waits for a human';
const heldPr = (n, label = 'decisions:review') =>
  makePr(n, { labels: [{ name: 'devflow' }, { name: 'risk:low' }, { name: label }] });
const T5_CFG = (extra = {}) => ({ ...CONFIG(), ...extra });

for (const [title, nextTask] of [
  ['trustDecisions false', { trustDecisions: false }],
  ['trustDecisions unset', {}],
  ['no nextTask block', undefined],
]) {
  test(`T5.1 decisions:review PR is skipped (${title})`, async () => {
    const env = makeEnv({ prs: [heldPr(1)], ...green(1) });
    await run(env, T5_CFG(nextTask === undefined ? {} : { nextTask }));
    assert.equal(env.decisions()[0].action, 'skipped');
    assert.equal(env.decisions()[0].reason, DECISIONS_REASON);
    assert.equal(env.names('pulls.merge').length, 0);
  });
}

test('T5.2 decisions:review PR with trustDecisions true is merged', async () => {
  const env = makeEnv({ prs: [heldPr(1)], ...green(1) });
  await run(env, T5_CFG({ nextTask: { trustDecisions: true } }));
  assert.equal(env.decisions()[0].action, 'merged');
  assert.equal(env.names('pulls.merge').length, 1);
});

test('T5.3 trustDecisions true but checks not green: usual check reason', async () => {
  const env = makeEnv({
    prs: [heldPr(1)],
    runs: { sha1: [{ name: 'devflow/review', status: 'in_progress', conclusion: null, id: 1, started_at: '2026-01-01' }] },
  });
  await run(env, T5_CFG({ nextTask: { trustDecisions: true } }));
  assert.notEqual(env.decisions()[0].action, 'merged');
  assert.equal(env.names('pulls.merge').length, 0);
  assert.match(env.decisions()[0].reason, /waiting for/);
  assert.doesNotMatch(env.decisions()[0].reason, /decisions:review/);
});

test('T5.4 custom labels.decisionsReview name', async () => {
  const cfg = T5_CFG({ labels: { decisionsReview: 'needs-human' } });
  const env = makeEnv({ prs: [heldPr(1, 'needs-human')], ...green(1) });
  await run(env, cfg);
  assert.equal(env.decisions()[0].action, 'skipped');
  assert.match(env.decisions()[0].reason, /waits for a human/);
  assert.equal(env.names('pulls.merge').length, 0);

  const env2 = makeEnv({ prs: [heldPr(2)], ...green(2) });
  await run(env2, cfg);
  assert.equal(env2.decisions()[0].action, 'merged');
});

test('T5.5 PR without the label is evaluated as in 3.0.0', async () => {
  for (const extra of [{}, { nextTask: { trustDecisions: false } }, { nextTask: { trustDecisions: true } }]) {
    const env = makeEnv({ prs: [makePr(1)], ...green(1) });
    await run(env, T5_CFG(extra));
    assert.equal(env.decisions()[0].action, 'merged');
    assert.equal(env.names('pulls.merge').length, 1);
  }
});

// Line-based read of the workflow_call block: { inputs: {name: {key: value}}, secrets: {...} }.
function readWorkflowCall(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}workflow_call:\s*$/.test(l));
  assert.ok(start >= 0, 'workflow_call block present');
  const out = { inputs: {}, secrets: {} };
  let section = null;
  let item = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break; // next top-level key or event
    let m = line.match(/^ {4}(inputs|secrets):\s*$/);
    if (m) { section = m[1]; item = null; continue; }
    if (!section) continue;
    m = line.match(/^ {6}([\w-]+):\s*$/);
    if (m) { item = m[1]; out[section][item] = {}; continue; }
    m = line.match(/^ {8}([\w-]+):\s*(.*)$/);
    if (m && item && m[1] !== 'description') out[section][item][m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

test('T5.6 reusable workflow inputs and secrets are unchanged from 3.0.0', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '.github', 'workflows', 'devflow-merge-gate.yml');
  const got = readWorkflowCall(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(got, {
    inputs: { 'devflow-ref': { required: 'true', type: 'string' } },
    secrets: { DEVFLOW_GATE_TOKEN: { required: 'true' }, DEVFLOW_READ_TOKEN: { required: 'false' } },
  });
});

const STATE_LABELS = ['agent:in-progress', 'agent:review', 'agent:blocked'];

function stateIssue(number, names = STATE_LABELS, overrides = {}) {
  return {
    number,
    state: 'closed',
    body: '',
    repository_url: 'https://api.github.com/repos/o/r',
    labels: names.map((name) => ({ name })),
    ...overrides,
  };
}

async function runStateLabelMerge(names, labels) {
  const env = makeEnv({
    prs: [makePr(1, { body: 'Closes #5 and fixes #6' })],
    issues: {
      5: stateIssue(5, names, { state: 'open' }),
      6: stateIssue(6, names, { state: 'open' }),
    },
    ...green(1),
  });
  await run(env, { ...CONFIG(), labels });
  assert.equal(env.decisions()[0].action, 'merged');
  const mergeIndex = env.calls.findIndex(([name]) => name === 'pulls.merge');
  assert.ok(mergeIndex >= 0);
  assert.ok(env.calls.slice(0, mergeIndex).every(([name]) => name !== 'removeLabel'),
    'linked issue labels must be removed after the merge');
  return env;
}

function assertLabelRemovals(env, issues, message) {
  const expected = issues.flatMap(({ number, labels }) =>
    labels.map(({ name }) => ({ owner: 'o', repo: 'r', issue_number: number, name })));
  const key = ({ issue_number, name }) => `${issue_number}:${name}`;
  const byIssueAndLabel = (a, b) => key(a).localeCompare(key(b));
  assert.deepEqual(env.names('removeLabel').map(([, args]) => args).sort(byIssueAndLabel),
    expected.sort(byIssueAndLabel), message);
}

test('T20.1 gate merge removes state labels from both linked issues', async () => {
  const env = await runStateLabelMerge(STATE_LABELS);
  assertLabelRemovals(env, [stateIssue(5), stateIssue(6)], 'merged PR must clean state labels on issues #5 and #6');
});

test('T20.2 gate merge keeps the bug label', async () => {
  const env = await runStateLabelMerge([...STATE_LABELS, 'bug']);
  assertLabelRemovals(env, [stateIssue(5), stateIssue(6)], 'gate must remove state labels while keeping bug');
});

test('T20.3 gate merge uses custom state label names', async () => {
  const labels = { inProgress: 'doing', review: 'in-review', blocked: 'waiting' };
  const custom = Object.values(labels);
  const env = await runStateLabelMerge([...STATE_LABELS, ...custom], labels);
  assertLabelRemovals(env, [stateIssue(5, custom), stateIssue(6, custom)],
    'gate must remove configured state labels while keeping the default names');
});

test('T20.4 sweep cleans a closed issue after a human merge', async () => {
  const closed = stateIssue(5, ['agent:in-progress', 'agent:review'], { state_reason: 'completed' });
  const pr = stateIssue(6, STATE_LABELS, { pull_request: { merged_at: '2026-01-01T10:00:00Z' } });
  const env = makeEnv({ listedIssues: [closed, pr] });
  await run(env, CONFIG());
  assertLabelRemovals(env, [closed], 'sweep must clean the human-merged issue and skip the pull request');
});

test('T20.5 sweep cleans blocked from an issue closed as not planned', async () => {
  const closed = stateIssue(5, ['agent:blocked'], { state_reason: 'not_planned' });
  const env = makeEnv({ listedIssues: [closed] });
  await run(env, CONFIG());
  assertLabelRemovals(env, [closed], 'sweep must remove blocked from the issue closed as not planned');
});

test('T20.6 sweep leaves an open issue untouched', async () => {
  const closed = stateIssue(5);
  const open = stateIssue(6, STATE_LABELS, { state: 'open' });
  const env = makeEnv({ listedIssues: [closed, open] });
  await run(env, CONFIG());
  assertLabelRemovals(env, [closed], 'sweep must clean the closed issue and leave the open issue untouched');
});

test('T20.7 sweep requests one page of 100 recently updated closed issues', async () => {
  const listedIssues = Array.from({ length: 150 }, (_, i) => stateIssue(i + 1, ['agent:review'], {
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 150 - i)).toISOString(),
  }));
  const env = makeEnv({ listedIssues });
  await run(env, CONFIG());
  assert.deepEqual(env.names('issues.listForRepo'), [['issues.listForRepo', {
    owner: 'o', repo: 'r', state: 'closed', sort: 'updated', direction: 'desc', per_page: 100,
  }]], 'sweep must make one closed-issue request for the 100 most recently updated issues');
  assert.equal(env.names('paginate issues.listForRepo').length, 0, 'sweep must not paginate');
  assertLabelRemovals(env, listedIssues.slice(0, 100), 'sweep must clean only the first 100 issues');
});

test('T20.8 sweep is confined to the gate repository', async () => {
  const local = stateIssue(5);
  const foreign = stateIssue(6, STATE_LABELS, { repository_url: 'https://api.github.com/repos/o/other' });
  const env = makeEnv({ listedIssues: [local, foreign] });
  await run(env, CONFIG());
  assert.ok(env.names('issues.listForRepo').every(([, { owner, repo }]) => owner === 'o' && repo === 'r'),
    'sweep must never list another repository');
  assertLabelRemovals(env, [local], 'sweep must clean the local issue without touching the foreign issue');
});

test('T20.9 sweep runs when no PR is evaluated', async () => {
  const closed = stateIssue(5, ['agent:review']);
  const env = makeEnv({ listedIssues: [closed] });
  await run(env, CONFIG());
  assert.equal(env.decisions().length, 0);
  assertLabelRemovals(env, [closed], 'enabled gate must sweep even with no PR to evaluate');
});

test('T20.10 removeLabel 403 warns and cleanup continues', async () => {
  const issues = [stateIssue(5, ['agent:review']), stateIssue(6, ['agent:blocked'])];
  const env = makeEnv({
    listedIssues: issues,
    removeLabelError: ({ issue_number }) => issue_number === 5
      ? Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 })
      : undefined,
  });
  await run(env, CONFIG());
  assert.ok(env.messages.warnings.length > 0, 'a removeLabel 403 must produce a core.warning');
  assertLabelRemovals(env, issues, 'a removeLabel 403 must not stop cleanup on another issue');
});

test('T20.12 workflow inputs and secrets match the fixed interface', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '.github', 'workflows', 'devflow-merge-gate.yml');
  assert.deepEqual(readWorkflowCall(fs.readFileSync(file, 'utf8')), {
    inputs: { 'devflow-ref': { required: 'true', type: 'string' } },
    secrets: { DEVFLOW_GATE_TOKEN: { required: 'true' }, DEVFLOW_READ_TOKEN: { required: 'false' } },
  }, 'merge-gate workflow_call inputs and secrets must keep their current interface');
});

const AUTO_READY_REPO = 'https://api.github.com/repos/o/r';

function autoReadyEnv({ body = '', risk = 'risk:low', extraLabels = [], approved = true, rejectLabel = false } = {}) {
  const makeIssue = (number, over = {}) => ({
    number, state: 'open', labels: ['risk:low'], body: '', repository_url: AUTO_READY_REPO, ...over,
  });
  const issues = {
    90: makeIssue(90, { labels: approved ? [{ name: 'epic:approved' }] : [] }),
    101: makeIssue(101, { body: '## Context\n\nEpic: #90' }),
    102: makeIssue(102, { body: '## Open questions\n\n<!-- guidance -->\nNone' }),
    103: makeIssue(103, { body: `Epic: #90\n\n## Dependencies\nDepends on #101\n${body}`, labels: [risk, ...extraLabels] }),
    104: makeIssue(104, { body: 'Epic: #90' }),
    105: makeIssue(105, { body: 'Epic: #900' }),
  };
  const env = makeEnv({ prs: [makePr(1)], issues, listedIssues: Object.values(issues), ...green(1) });
  const { github } = env;

  const merge = github.rest.pulls.merge;
  github.rest.pulls.merge = async (args) => {
    const result = await merge(args);
    issues[101].state = 'closed';
    return result;
  };
  const addLabels = github.rest.issues.addLabels;
  github.rest.issues.addLabels = async (args) => {
    const result = await addLabels(args);
    if (rejectLabel && args.issue_number === 103) throw Object.assign(new Error('Forbidden (403)'), { status: 403 });
    issues[args.issue_number].labels.push(...args.labels);
    return result;
  };
  const paginate = github.paginate;
  github.paginate = async (endpoint, params) => {
    if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues') {
      assert.equal(params.issue_number, 90);
      return [
        issues[102],
        issues[103],
        makeIssue(105, { repository_url: 'https://api.github.com/repos/another/repo' }),
      ];
    }
    if (endpoint === github.rest.issues.listComments) {
      return env.names('createComment').filter(([, args]) => args.issue_number === params.issue_number).map(([, args]) => ({ body: args.body }));
    }
    return paginate(endpoint, params);
  };
  env.logs = [];
  env.core.info = (message) => env.logs.push(message);
  env.readied = () => env.names('addLabels').filter(([, args]) => args.labels.includes('agent:ready')).map(([, args]) => args.issue_number);
  return env;
}

function autoReadyConfig(autoReady, dryRun = false) {
  return { ...CONFIG({ dryRun }), ...(autoReady === undefined ? {} : { spec: { autoReady } }) };
}

test('R1.1 an approved epic readies native and body-linked children after their dependencies close', async () => {
  const env = autoReadyEnv();
  await run(env, autoReadyConfig('low'));
  assert.equal(env.decisions()[0].action, 'merged');
  assert.deepEqual(env.readied().sort(), [102, 103, 104]);
  const comments = env.names('createComment').filter(([, args]) => args.issue_number === 103);
  assert.equal(comments.length, 1);
  assert.equal(comments[0][1].body, '<!-- devflow-auto-ready -->\nReady: epic #90 approved, all dependencies merged');
  assert.ok(env.calls.findIndex(([name]) => name === 'pulls.merge') < env.calls.indexOf(comments[0]));
});

test('R1.2 off and missing autoReady preserve manual readiness', async () => {
  for (const mode of ['off', undefined]) {
    const env = autoReadyEnv();
    await run(env, autoReadyConfig(mode));
    assert.equal(env.decisions()[0].action, 'merged');
    assert.deepEqual(env.readied(), []);
    assert.deepEqual(env.messages.warnings, []);
  }
});

test('R1.3 an open dependency holds the child', async () => {
  const env = autoReadyEnv({ body: 'Depends on #77' });
  await run(env, autoReadyConfig('low'));
  assert.deepEqual(env.readied().sort(), [102, 104]);
});

test('R1.4 open questions and the manual-ready marker each hold the child', async () => {
  for (const body of ['## Open questions\n\n- Which API?\n\n## Notes\nNone', 'Ready: manual']) {
    const env = autoReadyEnv({ body });
    await run(env, autoReadyConfig('low'));
    assert.deepEqual(env.readied().sort(), [102, 104]);
  }
});

test('R1.5 low skips high and unlabelled children while all allows both', async () => {
  for (const risk of ['risk:high', 'unrelated']) {
    for (const mode of ['low', 'all']) {
      const env = autoReadyEnv({ risk });
      await run(env, autoReadyConfig(mode));
      assert.equal(env.readied().includes(103), mode === 'all');
      assert.ok(env.readied().includes(102));
    }
  }
});

test('R1.6 missing approval prevents readying any children', async () => {
  const env = autoReadyEnv({ approved: false });
  await run(env, autoReadyConfig('all'));
  assert.equal(env.decisions()[0].action, 'merged');
  assert.deepEqual(env.readied(), []);
});

test('R1.7 children with workflow or triage labels stay untouched', async () => {
  for (const label of ['agent:ready', 'agent:in-progress', 'agent:review', 'agent:blocked', 'needs-triage']) {
    const env = autoReadyEnv({ extraLabels: [label] });
    await run(env, autoReadyConfig('all'));
    assert.deepEqual(env.readied().sort(), [102, 104]);
    assert.ok(!env.names('createComment').some(([, args]) => args.issue_number === 103));
  }
});

test('R1.8 a 403 warning leaves the successful merge and other children unaffected', async () => {
  const env = autoReadyEnv({ rejectLabel: true });
  await run(env, autoReadyConfig('low'));
  assert.equal(env.decisions()[0].action, 'merged');
  assert.ok(env.messages.warnings.some((m) => /#103.*403/.test(m)));
  assert.ok(env.readied().includes(104));
  assert.ok(!env.names('createComment').some(([, args]) => args.issue_number === 103));
});

test('R1.9 dry run logs the projected ready actions without writes', async () => {
  const env = autoReadyEnv();
  await run(env, autoReadyConfig('low', true));
  assert.equal(env.decisions()[0].action, 'would merge');
  assert.deepEqual(mutated(env), []);
  assert.ok(env.logs.some((m) => /#103: would .*ready.*#90/.test(m)));
});
