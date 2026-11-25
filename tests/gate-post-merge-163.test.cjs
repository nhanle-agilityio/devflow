'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const gate = require('../skills/init/templates/github/scripts/devflow-merge-gate.cjs');

const BASE = 'main';
const CONFIG = (over = {}) => ({
  baseBranch: BASE,
  review: { github: true },
  spec: { autoReady: 'all' },
  mergeGate: { enabled: true, dryRun: false, requiredChecks: ['devflow/review'], method: 'merge', ...over },
});

const branch = (ref, full_name = 'o/r') => ({ ref, repo: { full_name } });

function makePr(number, over = {}) {
  return {
    number,
    state: 'open',
    draft: false,
    body: `Closes #${number + 100}`,
    labels: [{ name: 'devflow' }, { name: 'risk:low' }],
    base: branch(BASE),
    head: { ...branch(`feat/${number}`), sha: `sha${number}` },
    user: { login: 'author' },
    mergeable: true,
    mergeable_state: 'clean',
    ...over,
  };
}

function makeIssue(number, body, over = {}) {
  return {
    number, body, state: 'open', labels: [],
    repository_url: 'https://api.github.com/repos/o/r',
    ...over,
  };
}

// Record REST calls as [name, args], as in merge-gate.test.cjs.
function makeEnv({ prs = [], issues = {}, green = [] } = {}) {
  const calls = [];
  const comments = [];
  const rec = (name, fn = () => ({ data: {} })) => async (args) => {
    calls.push([name, args]);
    return fn(args);
  };
  const rest = {
    pulls: {
      list: rec('pulls.list', ({ base, state = 'open' }) => ({
        data: prs.filter((pr) => (state === 'all' || pr.state === state) && (!base || pr.base.ref === base)),
      })),
      get: rec('pulls.get', ({ pull_number }) => ({ data: prs.find((pr) => pr.number === pull_number) })),
      listFiles: rec('pulls.listFiles', () => ({ data: [{ filename: 'src/app.js' }] })),
      update: rec('pulls.update', ({ pull_number, base }) => {
        prs.find((pr) => pr.number === pull_number).base.ref = base;
        return { data: {} };
      }),
      updateBranch: rec('pulls.updateBranch'),
      merge: rec('pulls.merge'),
    },
    repos: {
      compareCommitsWithBasehead: rec('compare', () => ({ data: { behind_by: 0 } })),
      listCommitStatusesForRef: rec('statuses', () => ({ data: [] })),
    },
    checks: {
      listForRef: rec('checks', ({ ref }) => ({
        data: { check_runs: green.includes(ref) ? [
          { name: 'devflow/review', status: 'completed', conclusion: 'success', id: 1, started_at: '2026-01-01' },
        ] : [] },
      })),
    },
    issues: {
      get: rec('issues.get', ({ issue_number }) => ({
        data: issues[issue_number] || makeIssue(issue_number, ''),
      })),
      listForRepo: rec('issues.listForRepo', ({ state = 'open' }) => ({
        data: Object.values(issues).filter((issue) => state === 'all' || issue.state === state),
      })),
      addLabels: rec('addLabels', ({ issue_number, labels }) => {
        issues[issue_number].labels.push(...labels);
        return { data: {} };
      }),
      removeLabel: rec('removeLabel'),
      createComment: rec('createComment', (args) => {
        comments.push(args);
        return { data: {} };
      }),
      listComments: rec('listComments', ({ issue_number }) => ({
        data: comments.filter((comment) => comment.issue_number === issue_number),
      })),
    },
    git: { deleteRef: rec('deleteRef') },
  };
  const subIssues = rec('sub_issues', () => ({ data: [] }));
  const github = {
    rest,
    paginate: async (endpoint, args) => {
      const fn = endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues' ? subIssues : endpoint;
      const { data } = await fn(args);
      return Array.isArray(data) ? data : data.check_runs;
    },
    graphql: async (query, vars) => {
      calls.push(['graphql', vars]);
      return { repository: { pullRequest: { reviewThreads: { nodes: [] } } } };
    },
  };
  const summary = { text: [], rows: [], writes: 0 };
  const chain = {
    addHeading: (value) => (summary.text.push(value), chain),
    addRaw: (value) => (summary.text.push(value), chain),
    addTable: (rows) => (summary.rows.push(...rows), chain),
    addList: (items) => (summary.text.push(...items), chain),
    addSeparator: () => chain,
    addBreak: () => chain,
    write: async () => (++summary.writes, chain),
  };
  const messages = { failed: null, info: [], warnings: [] };
  const core = {
    info: (message) => messages.info.push(message),
    warning: (message) => messages.warnings.push(message),
    setFailed: (message) => { messages.failed = message; },
    summary: chain,
  };
  const context = { repo: { owner: 'o', repo: 'r' }, eventName: 'workflow_run', payload: {} };
  const argsFor = (name) => calls.filter(([call]) => call === name).map(([, args]) => args);
  return { github, core, context, calls, argsFor, messages, summary };
}

const FORBIDDEN = ['pulls.merge', 'pulls.updateBranch', 'deleteRef'];
const MUTATIONS = [...FORBIDDEN, 'pulls.update', 'addLabels', 'removeLabel', 'createComment'];
const mutated = (env) => env.calls.filter(([name]) => MUTATIONS.includes(name));

function closedEnv({ merged = {}, prs = [], green = [] } = {}) {
  const issues = {
    10: makeIssue(10, '', { labels: [{ name: 'epic:approved' }] }),
    11: makeIssue(11, 'Epic: #10', { state: 'closed' }),
    12: makeIssue(12, 'Epic: #10\n\nDepends on #11\n\n## Open questions\n\nNone'),
  };
  const env = makeEnv({ prs, issues, green });
  env.context.eventName = 'pull_request';
  env.context.payload = {
    action: 'closed',
    pull_request: makePr(20, {
      state: 'closed', merged: true, body: 'Closes #11', head: branch('feat/11-x'), ...merged,
    }),
  };
  return env;
}

async function run(env, config = CONFIG()) {
  await gate({ github: env.github, context: env.context, core: env.core, config });
  assert.equal(env.messages.failed, null, 'the gate must complete without setFailed');
}

function assertReadiedChild(env, message) {
  const readied = env.argsFor('addLabels').filter(({ labels }) => labels.includes('agent:ready'));
  assert.deepEqual(readied.map(({ issue_number }) => issue_number), [12], message);
}

function assertNoCandidatePass(env) {
  const evaluations = ['pulls.get', 'pulls.listFiles', 'compare', 'checks', 'statuses', 'graphql'];
  assert.deepEqual(env.calls.filter(([name]) => [...FORBIDDEN, ...evaluations].includes(name)), [],
    'post-merge must never evaluate or merge candidates, update branches, or delete refs');
  assert.ok(!env.argsFor('issues.get').some(({ issue_number }) => issue_number === 199),
    'post-merge must never rank the unrelated candidate by its linked issue');
}

test('A4.1 post-merge readies the dependent child and posts its marker once', async () => {
  const env = closedEnv({ prs: [makePr(99)], green: ['sha99'] });
  await run(env);
  assertReadiedChild(env, 'merged payload PR closes #11 and should ready child #12');
  await run(env);
  const markers = env.argsFor('createComment').filter(({ issue_number, body }) =>
    issue_number === 12 && body.includes('<!-- devflow-auto-ready -->'));
  assert.equal(markers.length, 1, 'child #12 should receive one auto-ready marker across repeated deliveries');
  assertNoCandidatePass(env);
});

test('A4.2 post-merge retargets open devflow children and summarizes its actions', async () => {
  const env = closedEnv({
    merged: { base: branch('integration') },
    prs: [
      makePr(21, { base: branch('feat/11-x') }),
      makePr(22, { base: branch('feat/11-x') }),
      makePr(23, { base: branch('feat/11-x'), labels: [{ name: 'risk:low' }] }),
      makePr(24, { base: branch('feat/11-x'), state: 'closed' }),
      makePr(25, { base: branch('feat/other') }),
    ],
  });
  await run(env);
  const updates = env.argsFor('pulls.update').map(({ pull_number, base }) => [pull_number, base]);
  assert.deepEqual(updates.sort(([a], [b]) => a - b), [[21, 'integration'], [22, 'integration']],
    'retarget only open devflow PRs stacked on the merged head, to the payload base');
  assertNoCandidatePass(env);
  assert.ok(env.summary.writes > 0, 'the post-merge summary is written');
  const summary = JSON.stringify([env.summary.text, env.summary.rows]);
  assert.match(summary, /post-merge/i);
  for (const number of [12, 21, 22]) assert.match(summary, new RegExp(`\\b${number}\\b`));
});

test('A4.3 closing an unmerged PR makes no writes', async () => {
  const env = closedEnv({ merged: { merged: false }, prs: [makePr(99)], green: ['sha99'] });
  await run(env);
  assert.deepEqual(mutated(env).map(([name]) => name), [], 'closed unmerged events must not write');
});

test('A4.4 closing a merged fork PR makes no writes', async () => {
  const env = closedEnv({ merged: { head: branch('feat/11-x', 'fork/r') }, prs: [makePr(99)], green: ['sha99'] });
  await run(env);
  assert.deepEqual(mutated(env).map(([name]) => name), [], 'merged fork events must not write');
});

test('A4.5 unlabelled or protected merged heads still ready issues without retargeting', async () => {
  const failures = [];
  for (const [name, merged] of [
    ['unlabelled head', { labels: [], head: branch('feat/11-x') }],
    ['protected head', { head: branch('release/1.0') }],
  ]) {
    const env = closedEnv({ merged, prs: [makePr(21, { base: branch(merged.head.ref) })] });
    await run(env);
    assert.deepEqual(env.argsFor('pulls.update'), [], `${name} must not retarget stacked PRs`);
    assertNoCandidatePass(env);
    if (!env.argsFor('addLabels').some(({ issue_number, labels }) =>
      issue_number === 12 && labels.includes('agent:ready'))) failures.push(name);
  }
  assert.deepEqual(failures, [], 'both skipped retarget cases must still ready child #12');
});

test('A4.6 post-merge dry run logs its projected work without writes', async () => {
  const env = closedEnv({ prs: [makePr(21, { base: branch('feat/11-x') })] });
  await run(env, CONFIG({ dryRun: true }));
  assert.deepEqual(mutated(env), []);
  assert.match(env.messages.info.join('\n'), /^(?=.*\b12\b)(?=.*\bwould\b)(?=.*\bready\b).*$/im,
    'dry run should log that it would ready child #12');
  assert.match(env.messages.info.join('\n'), /^(?=.*\b21\b)(?=.*\bwould\b)(?=.*\bretarget\b).*$/im,
    'dry run should log that it would retarget PR #21');
  assertNoCandidatePass(env);
});

test('A4.7 disabled post-merge gate makes no API calls', async () => {
  const env = closedEnv({ prs: [makePr(99)], green: ['sha99'] });
  await run(env, CONFIG({ enabled: false }));
  assert.deepEqual(env.calls, []);
});

test('A4.8 workflow_run still merges an eligible low-risk PR', async () => {
  const env = makeEnv({ prs: [makePr(1)], green: ['sha1'] });
  await run(env);
  assert.deepEqual(env.argsFor('pulls.merge').map(({ pull_number }) => pull_number), [1]);
});

// Read the mapping entries needed by these assertions without adding a YAML dependency.
function yamlMapping(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  const indent = Math.min(...lines.map((line) => line.search(/\S/)));
  const entries = new Map();
  let key;
  for (const line of lines) {
    if (line.search(/\S/) === indent) {
      const entry = /^(\w[\w-]*):(?:\s*(.*))?$/.exec(line.trim());
      key = entry?.[1];
      if (key) entries.set(key, entry[2]?.replace(/\s+#.*$/, '') || '');
    } else if (key) {
      entries.set(key, `${entries.get(key)}\n${line}`);
    }
  }
  return entries;
}

test('A4.9 workflows authorize same-repository merge events and isolate their concurrency', () => {
  const read = (file) => yamlMapping(readFileSync(join(__dirname, '..', file), 'utf8'));
  const workflow = 'devflow-merge-gate.yml';
  const templates = [
    'skills/init/templates/github/callers/' + workflow,
    'skills/init/templates/github/workflows/' + workflow,
  ];
  const reusable = '.github/workflows/' + workflow;
  const pinned = '.github/workflows/devflow-merge-gate-caller.yml';
  const failures = [];
  for (const file of [...templates, reusable, pinned]) {
    const root = read(file);
    const triggers = yamlMapping(root.get('on') || '');
    if (triggers.has('pull_request_target')) failures.push(`${file} must omit pull_request_target`);
    if (file === pinned) {
      if (triggers.has('pull_request')) failures.push(`${file} must omit the pull_request trigger`);
      continue;
    }
    const job = yamlMapping(yamlMapping(root.get('jobs') || '').get('gate') || '');
    const condition = job.get('if') || '';
    if (!/github\.event_name\s*!=\s*['"]pull_request['"]/.test(condition)) {
      failures.push(`${file} gate if must permit other events`);
    }
    if (!/github\.event\.pull_request\.merged\s*==\s*true\b/.test(condition)) {
      failures.push(`${file} gate if must require a merged PR`);
    }
    if (!/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository\b/.test(condition)) {
      failures.push(`${file} gate if must require a same-repository head`);
    }
    if (templates.includes(file)) {
      const types = yamlMapping(triggers.get('pull_request') || '').get('types') || '';
      if (!/^\s*(?:\[\s*closed\s*\]|-\s+closed)\s*$/.test(types)) {
        failures.push(`${file} must trigger on pull_request closed`);
      }
    }
    const group = yamlMapping(job.get('concurrency') || root.get('concurrency') || '').get('group') || '';
    // A reusable workflow may inherit concurrency isolation from its caller.
    if ((file !== reusable || group) && !/\$\{\{[^}]*\bgithub\.event\.pull_request\.number\b[^}]*\}\}/s.test(group)) {
      failures.push(`${file} concurrency group must vary by pull request number`);
    }
  }
  assert.deepEqual(failures, []);
});

test('A4.10 normal pass skips stacked low-risk PRs until their parent merges', async () => {
  const env = makeEnv({ prs: [makePr(1, { base: branch('feat/parent') })], green: ['sha1'] });
  await run(env);
  const [, [pr, action, reason] = []] = env.summary.rows;
  assert.equal(pr, '#1');
  assert.equal(action, 'skipped');
  assert.match(reason, /^stacked on/);
  assert.deepEqual(env.argsFor('pulls.merge'), []);
});
