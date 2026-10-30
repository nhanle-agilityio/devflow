'use strict';
// Devflow merge gate. Called from .github/workflows/devflow-merge-gate.yml.
// Merges at most one `devflow` + `risk:low` PR per run, and only when everything is green.
// Config: .claude/devflow.json (baseBranch, github, labels, mergeGate). Claude itself never merges.

const fs = require('fs');

const CONFIG_PATH = '.claude/devflow.json';
const CONFLICT_MARKER = '<!-- devflow-gate:conflict -->';
const ALWAYS_PROTECTED = ['main', 'master', 'develop', 'trunk', 'production'];

const DEFAULTS = {
  baseBranch: 'main',
  labels: { devflow: 'devflow', riskLow: 'risk:low', riskHigh: 'risk:high', blocked: 'agent:blocked', stacked: 'stacked' },
  mergeGate: { enabled: false, dryRun: true, requiredChecks: ['devflow/review'], method: 'merge' },
};

function withDefaults(raw) {
  const c = raw || {};
  return {
    ...c,
    baseBranch: c.baseBranch || DEFAULTS.baseBranch,
    labels: { ...DEFAULTS.labels, ...(c.labels || {}) },
    mergeGate: { ...DEFAULTS.mergeGate, ...(c.mergeGate || {}) },
  };
}

// Workspace file first (default branch), then the same file at baseBranch, which is the source of truth.
async function loadConfig({ github, context, core }) {
  const { owner, repo } = context.repo;
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    core.info(`No readable ${CONFIG_PATH} in the workspace: ${e.message}`);
  }
  let config = local;
  const baseBranch = local.baseBranch || DEFAULTS.baseBranch;
  try {
    const res = await github.rest.repos.getContent({ owner, repo, path: CONFIG_PATH, ref: baseBranch });
    config = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
  } catch (e) {
    core.info(`Could not fetch ${CONFIG_PATH} at ${baseBranch}, using the workspace copy: ${e.message}`);
  }
  return withDefaults(config);
}

async function listCandidates({ github, context }, config, only) {
  const { owner, repo } = context.repo;
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  return open
    .filter((p) => (p.labels || []).some((l) => l.name === config.labels.devflow))
    .filter((p) => !only || p.number === only)
    .sort((a, b) => a.number - b.number);
}

function linkedIssues(body) {
  const nums = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(body || ''))) nums.add(Number(m[1]));
  return [...nums];
}

// A check is green when its latest check run succeeded or its latest commit status is success.
async function checksGreen({ github, context }, sha, names) {
  const { owner, repo } = context.repo;
  const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 });
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    owner, repo, ref: sha, per_page: 100,
  });
  for (const name of names) {
    const mine = runs
      .filter((r) => r.name === name)
      .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')) || b.id - a.id);
    const latestRun = mine[0];
    const latestStatus = statuses.find((s) => s.context === name); // newest first
    const runOk = latestRun && latestRun.status === 'completed' && latestRun.conclusion === 'success';
    const statusOk = latestStatus && latestStatus.state === 'success';
    if (runOk || statusOk) continue;
    const state = latestRun
      ? latestRun.status === 'completed' ? latestRun.conclusion : latestRun.status
      : latestStatus ? latestStatus.state : 'missing';
    return { ok: false, reason: `waiting for ${name}: ${state}` };
  }
  return { ok: true };
}

// A thread blocks when it is unresolved, not outdated, and its last comment is not by the PR author
// (the author's reply, e.g. from /devflow:sync, counts as an answer).
async function unresolvedThreads({ github, context }, pr) {
  const { owner, repo } = context.repo;
  const res = await github.graphql(
    `query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         pullRequest(number:$number){
           reviewThreads(first:100){ nodes{ isResolved isOutdated comments(last:1){ nodes{ author{ login } } } } }
         }
       }
     }`,
    { owner, repo, number: pr.number },
  );
  const nodes = res?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const author = pr.user?.login;
  return nodes.filter((n) => {
    if (n.isResolved || n.isOutdated) return false;
    const last = n.comments?.nodes?.[0]?.author?.login;
    return !(author && last === author);
  }).length;
}

async function blockOnConflict({ github, context }, config, pr, dryRun) {
  const { owner, repo } = context.repo;
  if (dryRun) return;
  const blocked = [config.labels.blocked];
  for (const n of [pr.number, ...linkedIssues(pr.body)]) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: n, labels: blocked });
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: pr.number, per_page: 100,
  });
  if (comments.some((c) => (c.body || '').includes(CONFLICT_MARKER))) return;
  await github.rest.issues.createComment({
    owner, repo, issue_number: pr.number,
    body: `${CONFLICT_MARKER}\nThis branch conflicts with \`${pr.base.ref}\`, so the merge gate cannot continue. ` +
      'Run `/devflow:sync` to resolve the conflicts; the gate will pick the PR up again once it is clean.',
  });
}

async function mergeAndRetarget({ github, context, core }, config, pr, dryRun) {
  const { owner, repo } = context.repo;
  const { baseBranch, mergeGate } = config;
  if (dryRun) return 'would merge';
  await github.rest.pulls.merge({
    owner, repo, pull_number: pr.number, merge_method: mergeGate.method || 'merge', sha: pr.head.sha,
  });
  // Children stacked on this branch must move to the base before the branch disappears.
  const children = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', base: pr.head.ref, per_page: 100,
  });
  for (const child of children.filter((c) => c.base.ref === pr.head.ref)) {
    await github.rest.pulls.update({ owner, repo, pull_number: child.number, base: baseBranch });
    core.info(`Retargeted #${child.number} to ${baseBranch}`);
  }
  const sameRepo = pr.head.repo && pr.base.repo && pr.head.repo.full_name === pr.base.repo.full_name;
  const protectedName =
    pr.head.ref === baseBranch || ALWAYS_PROTECTED.includes(pr.head.ref) || pr.head.ref.startsWith('release/');
  if (sameRepo && !protectedName) {
    await github.rest.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` });
  }
  return 'merged';
}

// Returns {action, reason}. Rules run in order; the first failing one decides.
async function evaluate(ctx, config, listed, state) {
  const { github, context } = ctx;
  const { owner, repo } = context.repo;
  const { labels, mergeGate, baseBranch } = config;
  const dryRun = mergeGate.dryRun !== false;
  const names = new Set((listed.labels || []).map((l) => l.name));

  if (listed.draft) return { action: 'skipped', reason: 'draft' };
  if (names.has(labels.riskHigh)) return { action: 'skipped', reason: `${labels.riskHigh}: waits for a human` };
  if (!names.has(labels.riskLow)) return { action: 'skipped', reason: 'no risk label: waits for a human' };
  if (names.has(labels.blocked)) return { action: 'skipped', reason: 'blocked' };
  if (listed.base.ref !== baseBranch) {
    return { action: 'skipped', reason: `stacked on ${listed.base.ref}: waits for its parent` };
  }
  if (state.merged) return { action: 'deferred', reason: 'deferred: one merge per run' };

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: listed.number });
  if (pr.mergeable === null || pr.mergeable === undefined) {
    return { action: 'skipped', reason: 'mergeability not computed yet' };
  }
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    await blockOnConflict(ctx, config, pr, dryRun);
    return {
      action: dryRun ? 'would block' : 'blocked',
      reason: `conflicts with ${pr.base.ref}: run /devflow:sync`,
    };
  }

  const cmp = await github.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${pr.base.ref}...${pr.head.sha}`,
  });
  const behind = cmp.data.behind_by || 0;
  if (behind > 0) {
    if (!dryRun) {
      await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha });
    }
    return {
      action: dryRun ? 'would update' : 'updated',
      reason: `behind ${pr.base.ref} by ${behind}; CI will re-run`,
    };
  }

  const checks = await checksGreen(ctx, pr.head.sha, mergeGate.requiredChecks);
  if (!checks.ok) return { action: 'skipped', reason: checks.reason };

  const open = await unresolvedThreads(ctx, pr);
  if (open > 0) return { action: 'skipped', reason: `${open} unanswered review threads` };

  const action = await mergeAndRetarget(ctx, config, pr, dryRun);
  state.merged = true;
  return { action, reason: 'all checks green, no unresolved threads' };
}

async function writeSummary(core, rows, dryRun) {
  const s = core.summary.addHeading('Devflow merge gate', 2);
  if (dryRun) s.addRaw('**DRY RUN**: nothing was changed. Set `mergeGate.dryRun` to false to enable merging.\n\n', true);
  if (rows.length === 0) {
    s.addRaw('No open PRs with the devflow label.', true);
  } else {
    s.addTable([
      [{ data: 'PR', header: true }, { data: 'Action', header: true }, { data: 'Reason', header: true }],
      ...rows.map((r) => [`#${r.pr}`, r.action, r.reason]),
    ]);
  }
  await s.write();
}

module.exports = async function gate({ github, context, core, config }) {
  const ctx = { github, context, core };
  try {
    const cfg = config ? withDefaults(config) : await loadConfig(ctx);
    if (!cfg.mergeGate.enabled) {
      core.info('Merge gate disabled (mergeGate.enabled is not true).');
      core.summary.addHeading('Devflow merge gate', 2).addRaw('Merge gate disabled.', true);
      await core.summary.write();
      return;
    }
    const dryRun = cfg.mergeGate.dryRun !== false;
    const only = Number(context.payload?.inputs?.pr) || null;
    const candidates = await listCandidates(ctx, cfg, only);
    const rows = [];
    const state = { merged: false };
    for (const listed of candidates) {
      try {
        const d = await evaluate(ctx, cfg, listed, state);
        rows.push({ pr: listed.number, ...d });
      } catch (e) {
        core.warning(`#${listed.number}: ${e.message}`);
        rows.push({ pr: listed.number, action: 'error', reason: e.message });
      }
    }
    await writeSummary(core, rows, dryRun);
  } catch (e) {
    core.setFailed(`Merge gate failed: ${e.message}`);
  }
};

module.exports.withDefaults = withDefaults;
