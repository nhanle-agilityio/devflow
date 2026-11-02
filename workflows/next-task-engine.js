export const meta = {
  name: 'next-task-engine',
  description: 'Pick up ready GitHub issues one at a time: implement test-first, run checks, verify, review, and open a PR for each.',
  whenToUse: 'Internal engine of /devflow:next-task; do not run it directly. Started by /devflow:next-task after preflight. Needs args: config (parsed .claude/devflow.json), limit, issues, startBranch, prTemplatePath, isolated, chain, claimId.',
  phases: [
    { title: 'Select', detail: 'list ready issues, dependencies first' },
    { title: 'Implement', detail: 'claim, branch, plan on the issue, test first, then the change' },
    { title: 'Check', detail: 'run the configured checks, fix failures' },
    { title: 'Verify', detail: 'walk acceptance criteria against the dev server' },
    { title: 'Review', detail: 'read-only review of the diff, fix findings' },
    { title: 'Ship', detail: 'push the branch, open the PR, label risk' },
    { title: 'Report', detail: 'one row per issue' },
  ],
}

// ---------------------------------------------------------------------------------------------
// Config. Everything stack-specific comes from args.config; nothing is hardcoded here.
// ---------------------------------------------------------------------------------------------

// Run through /devflow:next-task only: it does the preflight and builds args. Calling this workflow
// directly (e.g. /devflow:next-task-engine) arrives without args, so stop with a clear message.
const missing = ['config'].filter((k) => !args || !args[k])
if (args && typeof args.startBranch !== 'string') missing.push('startBranch')
if (!missing.length && (!args.config.github || !args.config.baseBranch || !Array.isArray(args.config.checks))) {
  missing.push('config.github / config.baseBranch / config.checks')
}
if (missing.length) {
  const message = `Missing args: ${missing.join(', ')}. Run /devflow:next-task [limit | #issue ...] instead of this workflow directly.`
  log(message)
  return [{ issue: 0, status: 'skipped', reason: message }]
}

const cfg = args.config
const gh = cfg.github
const remote = gh.remote || 'origin'
const base = cfg.baseBranch
const baseRef = `${remote}/${base}`
const labels = Object.assign(
  {
    ready: 'agent:ready',
    inProgress: 'agent:in-progress',
    review: 'agent:review',
    blocked: 'agent:blocked',
    e2e: 'needs-e2e',
    devflow: 'devflow',
    riskLow: 'risk:low',
    riskHigh: 'risk:high',
    stacked: 'stacked',
  },
  cfg.labels,
)
const riskCfg = Object.assign({ highPaths: [] }, cfg.risk)
const testingCfg = Object.assign({ e2eFramework: false }, cfg.testing)
const nt = Object.assign({ defaultLimit: 3, maxFixRounds: 2, maxReviewRounds: 2 }, cfg.nextTask)
const verifyCfg = Object.assign({ modes: [], browserTool: 'playwright' }, cfg.verify)
const branchPattern = cfg.branchPattern || '{type}/{issue}-{slug}'
const startBranch = args.startBranch
const isolated = args.isolated === true // own worktree: there is no start branch to return to
const chain = args.chain === true // explicit issues are a lane: in order, each stacked on the previous one
const claimId = String(args.claimId || 'run')
const limit = args.limit || nt.defaultLimit
const explicitIssues = Array.isArray(args.issues) ? args.issues : []
const cfgJson = JSON.stringify(cfg, null, 2)

const MCP_NOTE =
  'Use the GitHub MCP server for every GitHub operation (issues, labels, PRs, comments); load its tools with ToolSearch first ' +
  '(e.g. query "github issue", "github pull request"). Do not use the gh CLI unless the MCP server is unavailable. ' +
  'Issue labels are replaced as a whole by issue_write: read the issue first, then write the full new label list. ' +
  'Adding a label that does not exist yet creates it.'

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const SELECT_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'integer' } },
          parents: {
            type: 'array',
            description: 'Every open dependency this issue is stacked on (empty when all dependencies are closed)',
            items: {
              type: 'object',
              properties: {
                issue: { type: 'integer' },
                prNumber: { type: 'integer', description: 'Open PR of that dependency, 0 when inRun' },
                branch: { type: 'string', description: 'Head branch of that PR, empty when inRun' },
                inRun: { type: 'boolean', description: 'True when the dependency is selected in this run and has no PR yet' },
              },
              required: ['issue', 'prNumber', 'branch', 'inRun'],
            },
          },
        },
        required: ['number', 'title', 'labels', 'body', 'dependsOn', 'parents'],
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: { number: { type: 'integer' }, reason: { type: 'string' } },
        required: ['number', 'reason'],
      },
    },
  },
  required: ['issues', 'skipped'],
}

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    taken: { type: 'boolean', description: 'True when the issue already has an assignee or the in-progress / blocked label' },
    takenBy: { type: 'string' },
    claims: {
      type: 'array',
      description: 'Every devflow-claim comment on the issue after ours was posted',
      items: {
        type: 'object',
        properties: { commentId: { type: 'integer' }, claimId: { type: 'string' }, createdAt: { type: 'string' } },
        required: ['commentId', 'claimId', 'createdAt'],
      },
    },
  },
  required: ['taken', 'claims'],
}

const BRANCH_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, branch: { type: 'string' }, problem: { type: 'string' } },
  required: ['ok', 'branch'],
}

const RELEASE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['ready', 'blocked'] },
    plan: { type: 'string', description: 'The plan in markdown, as posted on the issue' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Open questions the spec and issue do not answer' },
    specRead: { type: 'string', description: 'The spec path that was read, or "none" when the issue links no spec' },
  },
  required: ['status', 'plan', 'questions', 'specRead'],
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' }, description: 'One "<sha> <message>" per commit made in this stage' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    touchesUi: { type: 'boolean', description: 'True when the diff against the base branch changes user-facing UI' },
    blockedReason: { type: 'string' },
    specRead: { type: 'string', description: 'The spec path that was read, or "none" when the issue links no spec' },
  },
  required: ['status', 'summary', 'commits', 'filesChanged', 'assumptions', 'outOfScope', 'touchesUi', 'specRead'],
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    integrationSha: { type: 'string', description: 'git rev-parse HEAD after all parent branches are merged' },
    merged: { type: 'array', items: { type: 'string' }, description: 'The remote/branch names merged, in order' },
    problem: { type: 'string' },
  },
  required: ['ok', 'integrationSha', 'merged'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { check: { type: 'string' }, output: { type: 'string' } },
        required: ['check', 'output'],
      },
    },
  },
  required: ['passed', 'failures'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean' },
    mode: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          pass: { type: 'boolean' },
        },
        required: ['action', 'expected', 'actual', 'pass'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['ran', 'mode', 'steps', 'notes'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['pass', 'changes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['critical', 'warning', 'suggestion'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'line', 'problem', 'fix'],
      },
    },
  },
  required: ['verdict', 'findings'],
}

const SHIP_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, prNumber: { type: 'integer' }, url: { type: 'string' }, problem: { type: 'string' } },
  required: ['ok', 'prNumber', 'url'],
}

const BLOCKED_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, pushed: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok', 'pushed'],
}

const RESTORE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok'],
}

// ---------------------------------------------------------------------------------------------
// Prompt builders. One small function per stage.
// ---------------------------------------------------------------------------------------------

// Integration commit per issue number (multi-stack only), set by the Integrate stage.
const integration = {}

function parentsOf(issue) {
  return Array.isArray(issue.parents) ? issue.parents : []
}

// Where the issue's own changes start: the base branch; the parent PR's branch when stacked on exactly one;
// the integration commit (all parents merged) when stacked on several. Before Integrate ran, a multi-stack starts at the base.
function parentRefFor(issue) {
  const parents = parentsOf(issue)
  if (parents.length === 1) return `${remote}/${parents[0].branch}`
  if (parents.length > 1 && integration[issue.number]) return integration[issue.number]
  return baseRef
}

// A single parent: the PR targets that branch. Several parents (merged into the branch): the PR targets the base branch.
function prBaseFor(issue) {
  const parents = parentsOf(issue)
  return parents.length === 1 ? parents[0].branch : base
}

// "#40 (branch)", "#40 (a) and #41 (b)", "#40 (a), #41 (b) and #42 (c)".
function parentList(issue) {
  const items = parentsOf(issue).map((p) => `#${p.prNumber} (${p.branch})`)
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// The spec path in the issue body: the first "<specDir>/<name>.md" (GitHub blob link or plain path), or ''.
function specPathFor(issue) {
  const dir = String(cfg.specDir || 'docs/specs').replace(/\/+$/, '')
  const re = new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[^\\s)#]*\\.md')
  const m = re.exec(String((issue && issue.body) || ''))
  return m ? m[0] : ''
}

// The claim that wins the race: the earliest createdAt (ISO strings sort), ties by the smallest comment id. null when empty.
function pickClaimWinner(claims) {
  let winner = null
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!winner || c.createdAt < winner.createdAt || (c.createdAt === winner.createdAt && c.commentId < winner.commentId)) winner = c
  }
  return winner
}

function readSpec(impl, path) {
  return String((impl && impl.specRead) || '').indexOf(path) !== -1
}

// True when the issue body has a Test cases table row whose Level cell is "http" or "e2e".
function hasHttpOrE2eRow(body) {
  return String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .some((line) =>
      line
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().toLowerCase())
        .some((cell) => cell === 'http' || cell === 'e2e'),
    )
}

// Glob to anchored RegExp: ** crosses "/", * and ? do not. "**/" also matches zero directories.
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

// Deterministic risk: the issue's label, then escalation by touched paths. Unlabelled counts as high.
function issueRisk(issue) {
  if (issue.labels.indexOf(labels.riskHigh) !== -1) return 'high'
  if (issue.labels.indexOf(labels.riskLow) !== -1) return 'low'
  return 'unknown'
}

function escalationFor(files) {
  for (const glob of riskCfg.highPaths) {
    const re = globToRegExp(glob)
    const hit = files.find((f) => re.test(f))
    if (hit) return `touches ${hit} (risk.highPaths)`
  }
  return ''
}

// The e2e rule differs by project: with an e2e framework the rows need committed tests, otherwise verify covers them.
function e2eRule(forReview) {
  if (testingCfg.e2eFramework) {
    return 'Rows with Level "e2e" need committed tests like every other row (the project has an e2e test framework).'
  }
  return forReview
    ? 'The project has no automated e2e test framework (testing.e2eFramework is false): do NOT flag a missing committed test for a row with Level "e2e"; the Verify stage covers those rows.'
    : 'The project has no automated e2e test framework (testing.e2eFramework is false): do NOT write or commit tests for rows with Level "e2e"; the Verify stage covers them against the running app. All other must rows still need committed tests.'
}

function scopeFor(issue) {
  return (cfg.commitScope || '#{issue}').split('{issue}').join(String(issue.number))
}

function issueBlock(issue) {
  return `Issue #${issue.number}: ${issue.title}\nLabels: ${issue.labels.join(', ') || '(none)'}\n\n${issue.body}`
}

function selectPrompt() {
  const explicit = explicitIssues.length
    ? `Explicit issues requested by the user: ${explicitIssues.map((n) => '#' + n).join(', ')}. Use exactly these (still skip, with a reason, any that is closed or already has an open PR referencing it). Do not apply the label filter to them.${chain ? ` These issues are a lane to run in exactly this order: return them in the order given and do not reorder them. Lane order is handled by the engine, so an earlier issue of the same list is NOT a parent by itself: add it to parents (inRun true, as below) only when this issue has a real \"Depends on\" line for it. Do not skip an issue only because an earlier issue of the same list is still open without a PR.` : ''}`
    : `No explicit issues. Select open issues labelled "${labels.ready}" that are NOT labelled "${labels.inProgress}" or "${labels.blocked}".`
  return `You are selecting GitHub issues for ${gh.owner}/${gh.repo}. ${MCP_NOTE}

devflow config:
${cfgJson}

${explicit}

Rules:
- Skip an issue that already has an open pull request referencing it (search open PRs for "#<number>", check "Closes"/"Fixes" lines and branch names).
- The issue body may contain lines "Depends on #<n>". If every such issue is closed, the issue is eligible as normal: parents = [].
- Every dependency that is still open becomes one entry in "parents". It must be one of:
  - it has an open pull request (find open PRs whose body contains "Closes #<dep>"): {issue: <dep>, prNumber: <that PR's number>, branch: <that PR's head branch>, inRun: false};
  - or it has no open PR but is itself in your selection (it will be worked on earlier in this run): {issue: <dep>, prNumber: 0, branch: "", inRun: true}. The workflow fills in the PR once the parent ships.
- If any open dependency has neither an open PR nor a place in your selection, the issue goes in "skipped" with the reason (name that dependency).
- Always return "parents" for every selected issue (an empty array when there is none).
- Order: ${chain && explicitIssues.length ? 'the order of the explicit issues' : 'parents before children, then oldest first (lowest number)'}.
- Return at most ${limit * 3} eligible issues in "issues" (the workflow applies the limit of ${limit}, because a child whose parent does not ship is not worked on and does not count). Everything beyond that goes in "skipped" with reason "over limit".
- For each selected issue return its full body verbatim, its label names, and the dependency numbers from its "Depends on" lines.
This is read-only: do not change anything on GitHub or in the checkout.`
}

function claimPrompt(issue) {
  return `Claim GitHub issue #${issue.number} in ${gh.owner}/${gh.repo}. ${MCP_NOTE}

devflow config:
${cfgJson}

Steps, in order:
1. Read issue #${issue.number}. If it already has an assignee, or the label "${labels.inProgress}" or "${labels.blocked}", return taken=true, takenBy = the assignee login or the label name, claims = []. Change and post nothing.
2. Otherwise add the authenticated user as assignee, add the label "${labels.inProgress}" and remove "${labels.ready}" (keep all other labels).
3. Post a comment on the issue whose body is exactly these two lines:
<!-- devflow-claim id=${claimId} -->
Claimed by devflow (${claimId}).
4. Read ALL comments of the issue again. Return in "claims" every comment whose body contains "<!-- devflow-claim id=": its comment id, the claim id parsed from that marker, and its created_at timestamp. Return taken=false.`
}

function releasePrompt(issue) {
  return `Release a lost claim on GitHub issue #${issue.number} in ${gh.owner}/${gh.repo}. ${MCP_NOTE}

Another devflow run claimed the issue first. Delete only the comment(s) on the issue whose body contains "<!-- devflow-claim id=${claimId} -->". Do not touch any other comment, the labels or the assignee: they belong to the winner. Return ok=true when none of your claim comments remain.`
}

function branchPrompt(issue) {
  // A multi-stack starts at the base branch; the Integrate stage merges the parents afterwards.
  const parents = parentsOf(issue)
  const parentRef = parentRefFor(issue)
  const fetchBranch = parents.length === 1 ? parents[0].branch : base
  return `Create the branch for GitHub issue #${issue.number} in ${gh.owner}/${gh.repo}. ${MCP_NOTE}

devflow config:
${cfgJson}

Steps, in order:
1. Work out the branch name from branchPattern "${branchPattern}": {issue} = ${issue.number}; {type} = the value of the issue's "type:<type>" label if present, otherwise infer one of feat|fix|chore|docs|refactor|test from the title; {slug} = at most 5 words of the title, kebab-case, ASCII only, without the "[<slug>] T<n>:" prefix.
2. Run \`git status --porcelain\`; it must be empty. If not, return ok=false with the problem.
3. Run \`git fetch ${remote} ${fetchBranch}\` then \`git switch -c <branch> ${parentRef}\` (this also works from a detached HEAD). If the branch name already exists, return ok=false with the problem (do not reuse or delete it).
Return the branch name you created. Do not touch GitHub.

Issue title: ${issue.title}
Issue labels: ${issue.labels.join(', ')}`
}

function planPrompt(issue, branch) {
  const specPath = specPathFor(issue)
  const step1 = specPath
    ? `Before anything else run \`git show ${baseRef}:${specPath}\` and read the whole spec. Then read the issue's acceptance criteria. The spec and issue are the source of truth for expected behaviour, not the current code.`
    : `The issue links no spec, so the issue text is the contract. Read its acceptance criteria.`
  return `Plan the work for GitHub issue #${issue.number} on branch ${branch} (already checked out). You only plan: do not edit code, do not commit, do not push. ${MCP_NOTE}

devflow config:
${cfgJson}

${issueBlock(issue)}

Instructions:
1. ${step1}
2. Read the project's CLAUDE.md and the code the change touches.
3. Write the plan in markdown with sections: Files to change; Tests (one entry per "Test cases" row id, or per test-plan item; ${e2eRule(false)}); Risks; Order of commits (failing test first, then the implementation); Open questions (only if there are any).
4. Post the plan on issue #${issue.number} as a comment whose first line is \`<!-- devflow-plan -->\`. If the issue already has a comment starting with that marker, edit it instead of adding another.
5. If something the spec and the issue do not answer would change behaviour or a contract, return status "blocked" with those questions (still post the plan, with an "Open questions" section). Otherwise return status "ready" and questions = [].
Return status, the plan text exactly as posted, questions, and specRead (${specPath ? `the spec path ${specPath}, exactly as you read it` : '"none"'}).`
}

function integratePrompt(issue, branch) {
  const parents = parentsOf(issue)
  const list = parents.map((p, i) => `${i + 1}. ${remote}/${p.branch} (PR #${p.prNumber}, issue #${p.issue})`).join('\n')
  const checks = cfg.checks.map((c, i) => `${i + 1}. [${c.name}] ${c.run}`).join('\n')
  return `Integrate the branches of the open dependencies of issue #${issue.number} into branch ${branch} (already checked out, created from ${baseRef}). ${MCP_NOTE}

devflow config:
${cfgJson}

${issueBlock(issue)}

Parent branches, in order:
${list}

Steps:
1. \`git fetch ${remote}\` (at least each parent branch above).
2. For each parent in the order above run \`git merge --no-edit ${remote}/<branch>\`. Keep the default merge commit message. Never rebase, never force, never rewrite commits.
3. If a merge conflicts, resolve it using the linked issues and the spec so that the behaviour of BOTH parents survives; stage files by name and complete the merge with the default message. Do not change anything that is not needed to resolve the conflict.
4. After all merges, run every configured check; fix only what the integration itself broke:
${checks}
5. Return integrationSha = the output of \`git rev-parse HEAD\` after all merges, and merged = the ${remote}/<branch> names merged, in order.
If you cannot resolve a conflict or the checks cannot be made to pass without a decision, run \`git merge --abort\` if a merge is in progress, leave nothing half-done, and return ok=false with the conflicting files and the question in problem. Do not push and do not touch GitHub labels.`
}

function implementPrompt(issue, branch, planText) {
  const parents = parentsOf(issue)
  const parentRef = parentRefFor(issue)
  const origin =
    parents.length === 1
      ? `created from ${parentRef}, the branch of PR #${parents[0].prNumber} this issue is stacked on`
      : parents.length > 1
        ? `created from ${baseRef} with the branches of ${parentList(issue)} merged in, integration commit ${parentRef}`
        : `created from ${parentRef}`
  const specPath = specPathFor(issue)
  const step1 = specPath
    ? `Before anything else run \`git show ${baseRef}:${specPath}\` and read the whole spec. Then read the issue's acceptance criteria. The spec and issue are the source of truth for expected behaviour, not the current code.`
    : `The issue links no spec, so the issue text is the contract. Read its acceptance criteria. The issue is the source of truth for expected behaviour, not the current code.`
  return `Implement GitHub issue #${issue.number} on branch ${branch} (already checked out, ${origin}). ${MCP_NOTE}

devflow config:
${cfgJson}

${issueBlock(issue)}

Plan (already posted on the issue). Follow this plan; if you must deviate, say why in "assumptions":
${planText}

Instructions:
1. ${step1}
2. Follow the project's CLAUDE.md for architecture, conventions and its "Never" list.
3. For behaviour changes and bug fixes: first write and commit a failing test (\`test(${scopeFor(issue)}): ...\`), run it and confirm it fails for the right reason, then commit the implementation (\`feat|fix|chore|refactor(${scopeFor(issue)}): ...\`, pick the type that fits). For work without behaviour change (docs, config) one commit is fine. Use Conventional Commits in English.
   If the issue has a "Test cases" table (rows of the spec's test matrix), write a test for every row with priority "must" and make each traceable to its row id (in the test name, e.g. test_t1_2_..., or a short comment such as "# T1.2"). "should" rows are optional. If the issue has only a test plan, follow it.
   ${e2eRule(false)}
4. Stage files by name only; never stage everything at once. Make small commits. Add no Co-Authored-By or AI attribution unless CLAUDE.md says otherwise.
5. Stay inside the issue's scope. Anything else you notice goes into "outOfScope", unchanged in the code.
6. If a requirement is ambiguous in a way that changes behaviour or a contract and the spec does not answer it, do NOT guess: return status "blocked" with blockedReason stating the question. For minor ambiguity, decide, and record the decision in "assumptions".
7. Do not push, open a PR, or touch GitHub labels.
Return: status, a short summary, the commits you made ("<sha> <message>"), files changed, assumptions, outOfScope, touchesUi (true when the diff against ${parentRef} changes user-facing UI), and specRead (${specPath ? `the spec path ${specPath}, exactly as you read it` : '"none"'}).`
}

function checkPrompt() {
  const list = cfg.checks.map((c, i) => `${i + 1}. [${c.name}] ${c.run}`).join('\n')
  return `Run the project's checks in the repository root, in this order. Run every one even if an earlier one fails.

${list}

Report passed=true only if all of them exit 0. For each failing check return its name and the relevant trimmed output (the failing assertions / errors, at most about 60 lines; no passing noise). Do not edit any file and do not commit.`
}

function fixPrompt(issue, branch, why, details) {
  return `Fix problems on branch ${branch} for issue #${issue.number}. Reason: ${why}.

devflow config:
${cfgJson}

${issueBlock(issue)}

Problems to fix:
${details}

Instructions:
- Follow the project's CLAUDE.md. Fix the cause, not the symptom; never weaken or delete a test, and never edit acceptance criteria, to make something pass.
- Stay inside the issue's scope. Record unrelated problems in "outOfScope" without changing them.
- Commit with Conventional Commits in English, scope "${scopeFor(issue)}", staging files by name. Never rewrite existing commits. Do not push.
- If you cannot fix it without a decision the spec does not make, return status "blocked" with blockedReason.
Return the same structure as the implement stage; "commits" lists only the commits you made now. In "specRead" put the spec path if you read the spec (for example with \`git show ${baseRef}:<path>\`), otherwise "none".`
}

function verifyPrompt(issue, branch, impl) {
  const dev = verifyCfg.devServer
  const modes = verifyCfg.modes.join(', ')
  const browser =
    verifyCfg.browserTool === 'chrome'
      ? 'Claude in Chrome tools (load them with ToolSearch: query "claude-in-chrome")'
      : 'the Playwright MCP tools (load them with ToolSearch: query "playwright")'
  return `Verify issue #${issue.number} on branch ${branch} against the running application.

devflow config:
${cfgJson}

${issueBlock(issue)}

Implementation summary: ${impl.summary}

Allowed modes: ${modes}.
${dev ? `Dev server: run \`${dev.run}\` in the background, then poll ${dev.url} until it answers (give up after ${dev.readyTimeoutSec || 60} seconds).` : 'No dev server is configured: set ran=false and explain in notes.'}

Steps:
1. Start the dev server in the background and wait until the URL answers.
2. Walk EVERY acceptance criterion of the issue, and every "Test cases" row with level "http" or "e2e" if the issue has that table. mode "http": call the API with curl and compare status and body to the criterion. mode "browser": use ${browser} to navigate, act as the user, and read the page (accessibility tree or text) to check the visible result; take screenshots only for your own check. Use whichever allowed mode fits each criterion and report the mode(s) used.
3. Record each step as action / expected / actual / pass.
4. ALWAYS stop the dev server you started, also when a step fails, and make sure no process is left listening on its port.
5. Do not edit or commit any file, and do not push.
If you cannot run verification at all (server never started, tool unavailable), return ran=false with the reason in notes; a failure of the code under test is ran=true with pass=false steps.`
}

function reviewPrompt(issue, branch, state, round) {
  const parentRef = parentRefFor(issue)
  const parents = parentsOf(issue)
  const specPath = specPathFor(issue)
  const stackNote =
    parents.length === 1
      ? ` This PR is stacked on PR #${parents[0].prNumber}; the parent's changes are excluded from this diff, review only what is new.`
      : parents.length > 1
        ? ` The branches of ${parentList(issue)} were merged into this branch at ${parentRef}; their changes are excluded from this diff, review only what is new.`
        : ''
  const specNote = specPath
    ? `Read the spec with \`git show ${baseRef}:${specPath}\` and the project's CLAUDE.md.`
    : `The issue links no spec; read the project's CLAUDE.md.`
  return `Review the change for issue #${issue.number} on branch ${branch}. You are read-only: do not edit, commit, push, or change GitHub. Review round ${round + 1}.

devflow config:
${cfgJson}

${issueBlock(issue)}

Run \`git diff ${parentRef}...HEAD\` and \`git log ${parentRef}..HEAD --oneline\`.${stackNote} ${specNote}
Review, in this order:
1. Correctness against the issue's acceptance criteria and the spec (bugs, missed edge cases, wrong contracts).
2. Tests: does each behaviour change have a test that would fail without it? Were tests weakened? If the issue has a "Test cases" table, every row with priority "must" needs a test traceable to its row id; a missing one is a warning that names the row. ${e2eRule(true)}
3. Scope creep: changes not needed for the acceptance criteria.
4. CLAUDE.md conventions and its "Never" list.
Severity: critical = wrong behaviour / data loss / security / rule violation; warning = likely bug, missing test, scope creep; suggestion = optional improvement. Only report real problems with a file and line. verdict "pass" means no critical or warning findings.

Implementation summary: ${state.summary}
Assumptions recorded so far: ${JSON.stringify(state.assumptions)}`
}

function shipPrompt(issue, branch, state, risk) {
  const prBase = prBaseFor(issue)
  const parents = parentsOf(issue)
  const stacked = parents.length > 0
  const stackLine =
    parents.length === 1
      ? `Stacked on #${parents[0].prNumber} (${parents[0].branch}); it retargets to ${base} when that PR merges.`
      : parents.length > 1
        ? `Stacked on ${parentList(issue)}; merged into this branch at ${(integration[issue.number] || '').slice(0, 7)}. The merge gate waits until every dependency is closed.`
        : ''
  const prRisk = risk.level === 'low' ? labels.riskLow : labels.riskHigh
  const riskLine = `Risk: ${risk.level === 'unknown' ? 'high (the issue has no risk label; treated as high)' : risk.level}${risk.escalation ? ' - escalated from the issue label: ' + risk.escalation : risk.reason ? ' - ' + risk.reason : ''}`
  const prLabels = [labels.devflow, prRisk].concat(stacked ? [labels.stacked] : [])
  const template = args.prTemplatePath
    ? `Read the PR body template at ${args.prTemplatePath} and fill every section from the data below (keep its headings).`
    : 'Write the PR body with sections: What, How, Tests, Checks, Verification, Review notes, Assumptions, Out of scope.'
  return `Ship issue #${issue.number}: push branch ${branch} and open the pull request. ${MCP_NOTE}

devflow config:
${cfgJson}

${template}

Data:
- Issue: #${issue.number} ${issue.title}
- Summary: ${state.summary}
- Follow-up fixes (checks, verification, review): ${JSON.stringify(state.fixes)}
- Commits: ${JSON.stringify(state.commits)}
- Files changed: ${JSON.stringify(state.filesChanged)}
- Check result: all configured checks passed (${cfg.checks.map((c) => c.name).join(', ')})
- Verification: ${state.verification ? JSON.stringify(state.verification) : 'Not run (not required for this issue)'}
- Review notes (suggestions that were NOT applied): ${JSON.stringify(state.suggestions)}
- Assumptions: ${JSON.stringify(state.assumptions)}
- Out of scope: ${JSON.stringify(state.outOfScope)}
- ${riskLine}
${stacked ? `- Stacked on ${parentList(issue)}.\n` : ''}
Steps:
1. \`git push -u ${remote} ${branch}\`. Never push to ${base} or any protected branch; never force-push.
2. Open a PR with head ${branch} and base ${prBase} in ${gh.owner}/${gh.repo}. Title: Conventional Commits style summary with scope "${scopeFor(issue)}", English, under 72 characters. Body as described, with a "Risk" section holding exactly this line: "${riskLine}"${stacked ? `, and the line "${stackLine}"` : ''}, ending with the line "Closes #${issue.number}". The body must not contain any at-sign mention of a bot or user, and no AI attribution.
3. Label the new PR (a PR is an issue: use issue_write with the PR number; read its labels first, keep existing ones): ${prLabels.map((l) => '"' + l + '"').join(', ')}.
4. On issue #${issue.number} add the label "${labels.review}" and remove "${labels.inProgress}" (keep other labels).${risk.escalation ? ` Also add "${labels.riskHigh}" to the issue and remove "${labels.riskLow}" (the change was escalated to high).` : ''}
5. ${isolated ? 'Stay on the branch (this checkout is a dedicated worktree; do not switch branches).' : `\`git switch ${startBranch}\`.`}
Return the PR number and URL. If any step fails, return ok=false with the problem.`
}

function blockedPrompt(issue, branch, stage, reason) {
  return `Issue #${issue.number} is blocked at stage "${stage}". Clean up. ${MCP_NOTE}

devflow config:
${cfgJson}

Reason / question: ${reason}
Branch: ${branch || '(none created)'}

Steps, in order:
1. Do not make any more code changes or commits. If uncommitted changes exist, leave them; do not discard anything.
2. ${branch ? `If \`git log ${parentRefFor(issue)}..${branch} --oneline\` shows commits, push the branch so work is not lost: \`git push -u ${remote} ${branch}\` (never force, never push to ${base}).` : 'No branch to push.'}
3. Comment on issue #${issue.number}: the stage ("${stage}"), the reason, and the concrete question or decision a human must provide to unblock it${branch ? `, and the branch name ${branch}` : ''}. No at-sign mentions of bots.
4. On the issue add the label "${labels.blocked}" and remove "${labels.inProgress}" (keep other labels).
5. ${isolated ? 'Stay on the branch; this checkout is a dedicated worktree, so do not switch branches or stash.' : `\`git switch ${startBranch}\` (if the working tree is dirty, use \`git stash push -u -m devflow-blocked-${issue.number}\` first and say so in note).`}
Return whether the branch was pushed.`
}

function restorePrompt() {
  return `Make sure the checkout is back on branch ${startBranch}: run \`git branch --show-current\`; if it differs, run \`git switch ${startBranch}\` (if that fails because of local changes, run \`git stash push -u -m devflow-restore\` first and mention it in note). Report ok=true when the current branch is ${startBranch}. Change nothing else.`
}

// ---------------------------------------------------------------------------------------------
// Stage runners
// ---------------------------------------------------------------------------------------------

// Run all checks; on failure ask for a fix and re-check, up to maxFixRounds fix attempts.
// Returns {ok, reason}. Mutates state with the fix results.
async function checkLoop(issue, branch, state) {
  for (let round = 0; round <= nt.maxFixRounds; round++) {
    phase('Check')
    const check = await agent(checkPrompt(), {
      label: `check #${issue.number}${round ? ` (after fix ${round})` : ''}`,
      phase: 'Check',
      schema: CHECK_SCHEMA,
      model: 'haiku',
    })
    if (!check) return { ok: false, reason: 'The check agent died before reporting.' }
    if (check.passed) return { ok: true }
    const details = check.failures.map((f) => `[${f.check}]\n${f.output}`).join('\n\n')
    if (round === nt.maxFixRounds) {
      return { ok: false, reason: `Checks still failing after ${nt.maxFixRounds} fix round(s):\n${details}` }
    }
    const fix = await runFix(issue, branch, state, `configured checks failed (fix round ${round + 1} of ${nt.maxFixRounds})`, details)
    if (!fix.ok) return fix
  }
  return { ok: false, reason: 'Unreachable check loop exit.' }
}

async function runFix(issue, branch, state, why, details) {
  phase('Implement')
  const fix = await agent(fixPrompt(issue, branch, why, details), {
    label: `fix #${issue.number}`,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
    model: 'sonnet',
  })
  if (!fix) return { ok: false, reason: `The fix agent died (${why}).` }
  if (fix.status === 'blocked') return { ok: false, reason: fix.blockedReason || `The fix agent reported blocked (${why}).` }
  merge(state, fix)
  return { ok: true, result: fix }
}

// The implement summary stays the PR's "what"; fix summaries are kept separately.
function merge(state, result) {
  if (!state.summary) state.summary = result.summary
  else if (result.summary) state.fixes.push(result.summary)
  state.commits = state.commits.concat(result.commits)
  state.filesChanged = Array.from(new Set(state.filesChanged.concat(result.filesChanged)))
  state.assumptions = state.assumptions.concat(result.assumptions)
  state.outOfScope = state.outOfScope.concat(result.outOfScope)
  state.touchesUi = state.touchesUi || result.touchesUi
}

function failedSteps(v) {
  return v.steps.filter((s) => !s.pass)
}

async function runIssue(issue) {
  const state = {
    summary: '',
    fixes: [],
    commits: [],
    filesChanged: [],
    assumptions: [],
    outOfScope: [],
    suggestions: [],
    touchesUi: false,
    verification: null,
  }
  let branch = ''

  async function block(stage, reason) {
    log(`#${issue.number} blocked at ${stage}: ${reason.split('\n')[0]}`)
    await agent(blockedPrompt(issue, branch, stage, reason), {
      label: `blocked #${issue.number}`,
      phase: stage,
      schema: BLOCKED_SCHEMA,
      model: 'haiku',
    })
    return { issue: issue.number, status: 'blocked', reason: `${stage}: ${reason.split('\n')[0]}` }
  }

  // Claim: a lock on the issue, decided here from the claim comments the agent read back.
  phase('Implement')
  const claim = await agent(claimPrompt(issue), {
    label: `claim #${issue.number}`,
    phase: 'Implement',
    schema: CLAIM_SCHEMA,
    model: 'haiku',
  })
  if (!claim) return block('Claim', 'The claim agent failed.')
  if (claim.taken) {
    const by = claim.takenBy || 'assignee or label'
    log(`Skipped #${issue.number}: already claimed (${by}).`)
    return { issue: issue.number, status: 'skipped', reason: `already claimed (${by})` }
  }
  const claims = Array.isArray(claim.claims) ? claim.claims : []
  if (!claims.some((c) => c.claimId === claimId)) {
    return block('Claim', `Our claim comment (${claimId}) was not found on the issue after posting it.`)
  }
  const winner = pickClaimWinner(claims)
  if (winner.claimId !== claimId) {
    await agent(releasePrompt(issue), {
      label: `release #${issue.number}`,
      phase: 'Implement',
      schema: RELEASE_SCHEMA,
      model: 'haiku',
    })
    log(`Skipped #${issue.number}: claimed by ${winner.claimId}.`)
    return { issue: issue.number, status: 'skipped', reason: `claimed by ${winner.claimId}` }
  }

  // Branch
  const made = await agent(branchPrompt(issue), {
    label: `branch #${issue.number}`,
    phase: 'Implement',
    schema: BRANCH_SCHEMA,
    model: 'haiku',
  })
  if (!made || !made.ok || !made.branch) {
    return block('Branch', (made && made.problem) || 'The branch agent failed or could not create the branch.')
  }
  branch = made.branch

  // Integrate: several open parents are merged into the branch before any work starts.
  if (parentsOf(issue).length > 1) {
    const integ = await agent(integratePrompt(issue, branch), {
      label: `integrate #${issue.number}`,
      phase: 'Implement',
      schema: INTEGRATE_SCHEMA,
      model: 'sonnet',
    })
    if (!integ || !integ.ok || !integ.integrationSha) {
      return block('Integrate', (integ && integ.problem) || 'The integrate agent failed or did not report an integration commit.')
    }
    integration[issue.number] = integ.integrationSha
    log(`#${issue.number}: merged ${integ.merged.join(', ')} at ${integ.integrationSha.slice(0, 7)}.`)
  }

  // Plan: posted on the issue; nobody approves it. Open questions block the issue before any code is written.
  const specPathForPlan = specPathFor(issue)
  const plan = await agent(planPrompt(issue, branch), {
    label: `plan #${issue.number}`,
    phase: 'Implement',
    schema: PLAN_SCHEMA,
    model: 'sonnet',
  })
  if (!plan) return block('Plan', 'The plan agent died.')
  if (plan.status === 'blocked') {
    return block('Plan', (plan.questions || []).join('; ') || 'The plan agent reported blocked without questions.')
  }
  if (specPathForPlan && !readSpec(plan, specPathForPlan)) return block('Plan', `Plan did not read the spec ${specPathForPlan}`)

  // Implement
  const impl = await agent(implementPrompt(issue, branch, plan.plan), {
    label: `implement #${issue.number}`,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
    model: 'sonnet',
  })
  if (!impl) return block('Implement', 'The implement agent died.')
  merge(state, impl)
  if (impl.status === 'blocked') return block('Implement', impl.blockedReason || 'The implement agent reported blocked without a reason.')

  // The spec must have been read: one corrective fix, then block.
  const specPath = specPathFor(issue)
  if (specPath && !readSpec(impl, specPath)) {
    log(`#${issue.number}: Implement did not report reading ${specPath}; running one corrective fix.`)
    const fix = await runFix(
      issue,
      branch,
      state,
      'the implementation was written without reading the spec',
      `Read ${specPath} with \`git show ${baseRef}:${specPath}\`, compare every requirement with the change on this branch, and fix any difference. Return specRead = ${specPath}.`,
    )
    if (!fix.ok) return block('Implement', fix.reason)
    if (!readSpec(fix.result, specPath)) return block('Implement', `Implement did not read the spec ${specPath}`)
  }

  // Check
  const checked = await checkLoop(issue, branch, state)
  if (!checked.ok) return block('Check', checked.reason)

  // Verify
  const needsVerify =
    verifyCfg.modes.length > 0 &&
    (issue.labels.indexOf(labels.e2e) !== -1 || state.touchesUi || hasHttpOrE2eRow(issue.body))
  if (needsVerify) {
    for (let round = 0; round <= 1; round++) {
      phase('Verify')
      const v = await agent(verifyPrompt(issue, branch, state), {
        label: `verify #${issue.number}${round ? ' (again)' : ''}`,
        phase: 'Verify',
        schema: VERIFY_SCHEMA,
        model: 'sonnet',
      })
      if (!v) return block('Verify', 'The verify agent died.')
      state.verification = v
      if (!v.ran) {
        log(`#${issue.number}: verification could not run (${v.notes}); continuing without it.`)
        break
      }
      const bad = failedSteps(v)
      if (bad.length === 0) break
      const details = bad.map((s) => `- ${s.action}: expected ${s.expected}; actual ${s.actual}`).join('\n')
      if (round === 1) return block('Verify', `Verification still failing after one fix round:\n${details}`)
      const fix = await runFix(issue, branch, state, 'verification against the running app failed', details)
      if (!fix.ok) return block('Verify', fix.reason)
      const again = await checkLoop(issue, branch, state)
      if (!again.ok) return block('Check', again.reason)
    }
  }

  // Review
  for (let round = 0; round <= nt.maxReviewRounds; round++) {
    phase('Review')
    const review = await agent(reviewPrompt(issue, branch, state, round), {
      label: `review #${issue.number} (round ${round + 1})`,
      phase: 'Review',
      schema: REVIEW_SCHEMA,
      model: 'opus',
    })
    if (!review) return block('Review', 'The review agent died.')
    const blocking = review.findings.filter((f) => f.severity !== 'suggestion')
    state.suggestions = review.findings.filter((f) => f.severity === 'suggestion')
    if (review.verdict === 'pass' || blocking.length === 0) break
    const details = blocking
      .map((f) => `- [${f.severity}] ${f.file}:${f.line}: ${f.problem}\n  Suggested fix: ${f.fix}`)
      .join('\n')
    if (round === nt.maxReviewRounds) {
      return block('Review', `Review still has critical/warning findings after ${nt.maxReviewRounds} fix round(s):\n${details}`)
    }
    const fix = await runFix(issue, branch, state, `review found problems (round ${round + 1} of ${nt.maxReviewRounds})`, details)
    if (!fix.ok) return block('Review', fix.reason)
    const again = await checkLoop(issue, branch, state)
    if (!again.ok) return block('Check', again.reason)
  }

  // Risk: label first, then deterministic escalation by touched paths.
  const reasonMatch = /^\s*Risk:\s*(?:low|high)\s*[-:\u2013\u2014]\s*(.+)$/im.exec(issue.body || '')
  const risk = { level: issueRisk(issue), reason: reasonMatch ? reasonMatch[1].trim() : '', escalation: '' }
  if (risk.level === 'unknown') log(`#${issue.number}: no risk label; treated as high (human merge).`)
  const escalation = escalationFor(state.filesChanged)
  if (escalation && risk.level !== 'high') {
    risk.level = 'high'
    risk.escalation = escalation
    log(`#${issue.number}: risk escalated to high: ${escalation}`)
  }
  if (parentsOf(issue).length) log(`#${issue.number}: stacked on ${parentList(issue)}; PR base is ${prBaseFor(issue)}.`)

  // Ship
  phase('Ship')
  const ship = await agent(shipPrompt(issue, branch, state, risk), {
    label: `ship #${issue.number}`,
    phase: 'Ship',
    schema: SHIP_SCHEMA,
    model: 'sonnet', // writes the PR body reviewers read; worth more than haiku
  })
  if (!ship || !ship.ok) return block('Ship', (ship && ship.problem) || 'The ship agent died.')
  return {
    issue: issue.number,
    status: 'pr',
    url: ship.url,
    prNumber: ship.prNumber,
    risk: risk.level === 'unknown' ? 'high' : risk.level,
    stackedOn: parentsOf(issue).map((p) => p.prNumber),
    branch,
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const report = []

phase('Select')
const selected = await agent(selectPrompt(), { label: 'select issues', phase: 'Select', schema: SELECT_SCHEMA, model: 'haiku' })

if (!selected) {
  log('Selection agent failed; nothing was started.')
  phase('Report')
  return [{ issue: 0, status: 'skipped', reason: 'Select: the selection agent failed.' }]
}

for (const s of selected.skipped) {
  log(`Skipped #${s.number}: ${s.reason}`)
  report.push({ issue: s.number, status: 'skipped', reason: s.reason })
}
const queue = selected.issues
log(queue.length ? `Candidates: ${queue.map((i) => '#' + i.number).join(', ')}; working on at most ${limit}, sequentially${chain ? ' as a lane (each stacked on the previous one)' : ''}.` : 'No eligible issues.')

// Parents that shipped in this run: issue number -> {prNumber, branch}. Children stack on them.
const shipped = {}
const status = {}
let worked = 0
let previous = null // chain: the last issue worked on, {number, status}
let lastShipped = null // chain: the last issue of the lane that shipped; the next one stacks on it

for (const issue of queue) {
  if (worked >= limit) {
    log(`Skipped #${issue.number}: over limit (${limit})`)
    report.push({ issue: issue.number, status: 'skipped', reason: `over limit (${limit})` })
    continue
  }
  // Chain: an issue that did not ship does not stop the lane. The next one stacks on the last issue that
  // shipped, or starts from the base; only a real "Depends on" the failed issue skips it (resolved below).
  if (chain && previous && previous.status !== 'pr') {
    log(`#${issue.number}: lane continues although #${previous.number} did not ship (${previous.status}); ${lastShipped ? `stacking on #${lastShipped}` : `starting from ${base}`}.`)
  }
  // Resolve parents selected in this run from the PRs they shipped.
  const resolved = []
  let unshipped = null
  for (const p of parentsOf(issue)) {
    if (!p.inRun) {
      resolved.push(p)
      continue
    }
    const parent = shipped[p.issue]
    if (!parent) {
      unshipped = p
      break
    }
    resolved.push({ issue: p.issue, prNumber: parent.prNumber, branch: parent.branch, inRun: false })
    log(`#${issue.number}: parent #${p.issue} shipped as PR #${parent.prNumber} (${parent.branch}).`)
  }
  // Chain: stack on the last issue of the lane that shipped.
  if (chain && lastShipped && !resolved.some((p) => p.issue === lastShipped)) {
    const prev = shipped[lastShipped]
    resolved.push({ issue: lastShipped, prNumber: prev.prNumber, branch: prev.branch, inRun: false })
    log(`#${issue.number}: lane, stacked on #${lastShipped} (PR #${prev.prNumber}).`)
  }
  if (unshipped) {
    const why = `parent #${unshipped.issue} did not ship (${status[unshipped.issue] || 'not worked on'})`
    log(`Skipped #${issue.number}: ${why}`)
    report.push({ issue: issue.number, status: 'skipped', reason: why })
    continue
  }
  issue.parents = resolved
  worked++
  let result
  try {
    result = await runIssue(issue)
  } catch (e) {
    result = { issue: issue.number, status: 'blocked', reason: `Workflow error: ${e && e.message ? e.message : e}` }
  }
  status[issue.number] = result.status
  previous = { number: issue.number, status: result.status }
  if (result.status === 'pr') {
    shipped[issue.number] = { prNumber: result.prNumber, branch: result.branch }
    lastShipped = issue.number
  }
  report.push(result)
  // Every issue starts from a clean checkout of the original branch (an isolated run has no start branch).
  if (!isolated) await agent(restorePrompt(), { label: `restore ${startBranch}`, phase: 'Report', schema: RESTORE_SCHEMA, model: 'haiku' })
}

phase('Report')
log(report.map((r) => `#${r.issue}: ${r.status}${r.url ? ' ' + r.url : ''}${r.risk ? ' risk:' + r.risk : ''}${r.stackedOn && r.stackedOn.length ? ' stacked on ' + r.stackedOn.map((n) => '#' + n).join(', ') : ''}${r.reason ? ' (' + r.reason + ')' : ''}`).join('\n'))
return report
