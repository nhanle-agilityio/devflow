export const meta = {
  name: 'next-task-engine',
  description: 'Pick up ready GitHub issues one at a time: implement test-first, run checks, verify, review, and open a PR for each.',
  whenToUse: 'Internal engine of /devflow:next-task; do not run it directly. Started by /devflow:next-task after preflight. Needs args: config (parsed .claude/devflow.json), limit, issues, startBranch, prTemplatePath.',
  phases: [
    { title: 'Select', detail: 'list ready issues, dependencies first' },
    { title: 'Implement', detail: 'claim, branch, test first, then the change' },
    { title: 'Check', detail: 'run the configured checks, fix failures' },
    { title: 'Verify', detail: 'walk acceptance criteria against the dev server' },
    { title: 'Review', detail: 'read-only review of the diff, fix findings' },
    { title: 'Ship', detail: 'push the branch and open the PR' },
    { title: 'Report', detail: 'one row per issue' },
  ],
}

// ---------------------------------------------------------------------------------------------
// Config. Everything stack-specific comes from args.config; nothing is hardcoded here.
// ---------------------------------------------------------------------------------------------

// Run through /devflow:next-task only: it does the preflight and builds args. Calling this workflow
// directly (e.g. /devflow:next-task-engine) arrives without args, so stop with a clear message.
const missing = ['config', 'startBranch'].filter((k) => !args || !args[k])
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
  { ready: 'agent:ready', inProgress: 'agent:in-progress', review: 'agent:review', blocked: 'agent:blocked', e2e: 'needs-e2e' },
  cfg.labels,
)
const nt = Object.assign({ defaultLimit: 3, maxFixRounds: 2, maxReviewRounds: 2 }, cfg.nextTask)
const verifyCfg = Object.assign({ modes: [], browserTool: 'playwright' }, cfg.verify)
const branchPattern = cfg.branchPattern || '{type}/{issue}-{slug}'
const startBranch = args.startBranch
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
        },
        required: ['number', 'title', 'labels', 'body', 'dependsOn'],
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
  properties: { ok: { type: 'boolean' }, branch: { type: 'string' }, problem: { type: 'string' } },
  required: ['ok', 'branch'],
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
  },
  required: ['status', 'summary', 'commits', 'filesChanged', 'assumptions', 'outOfScope', 'touchesUi'],
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

function scopeFor(issue) {
  return (cfg.commitScope || '#{issue}').split('{issue}').join(String(issue.number))
}

function issueBlock(issue) {
  return `Issue #${issue.number}: ${issue.title}\nLabels: ${issue.labels.join(', ') || '(none)'}\n\n${issue.body}`
}

function selectPrompt() {
  const explicit = explicitIssues.length
    ? `Explicit issues requested by the user: ${explicitIssues.map((n) => '#' + n).join(', ')}. Use exactly these (still skip, with a reason, any that is closed or already has an open PR referencing it). Do not apply the label filter to them.`
    : `No explicit issues. Select open issues labelled "${labels.ready}" that are NOT labelled "${labels.inProgress}" or "${labels.blocked}".`
  return `You are selecting GitHub issues for ${gh.owner}/${gh.repo}. ${MCP_NOTE}

devflow config:
${cfgJson}

${explicit}

Rules:
- Skip an issue that already has an open pull request referencing it (search open PRs for "#<number>", check "Closes"/"Fixes" lines and branch names).
- The issue body may contain lines "Depends on #<n>". An issue is eligible only when every such issue is closed. Report the others in "skipped" with the reason (name the open dependency). A dependency that is itself in your selection but still open counts as open.
- Order: dependencies first, then oldest first (lowest number).
- Return at most ${limit} issues in "issues". Everything else that was eligible but over the limit goes in "skipped" with reason "over limit".
- For each selected issue return its full body verbatim, its label names, and the dependency numbers from its "Depends on" lines.
This is read-only: do not change anything on GitHub or in the checkout.`
}

function claimPrompt(issue) {
  return `Claim GitHub issue #${issue.number} in ${gh.owner}/${gh.repo} and create its branch. ${MCP_NOTE}

devflow config:
${cfgJson}

Steps, in order:
1. Add the label "${labels.inProgress}" to issue #${issue.number} and remove "${labels.ready}" (keep all other labels).
2. Work out the branch name from branchPattern "${branchPattern}": {issue} = ${issue.number}; {type} = the value of the issue's "type:<type>" label if present, otherwise infer one of feat|fix|chore|docs|refactor|test from the title; {slug} = at most 5 words of the title, kebab-case, ASCII only, without the "[<slug>] T<n>:" prefix.
3. Run \`git status --porcelain\`; it must be empty. If not, return ok=false with the problem.
4. Run \`git fetch ${remote} ${base}\` then \`git switch -c <branch> ${baseRef}\`. If the branch name already exists, return ok=false with the problem (do not reuse or delete it).
Return the branch name you created.

Issue title: ${issue.title}
Issue labels: ${issue.labels.join(', ')}`
}

function implementPrompt(issue, branch) {
  return `Implement GitHub issue #${issue.number} on branch ${branch} (already checked out, created from ${baseRef}). ${MCP_NOTE}

devflow config:
${cfgJson}

${issueBlock(issue)}

Instructions:
1. Read the issue's acceptance criteria and the spec it links (read the spec file from the repo or from ${baseRef}). The spec and issue are the source of truth for expected behaviour, not the current code.
2. Follow the project's CLAUDE.md for architecture, conventions and its "Never" list.
3. For behaviour changes and bug fixes: first write and commit a failing test (\`test(${scopeFor(issue)}): ...\`), run it and confirm it fails for the right reason, then commit the implementation (\`feat|fix|chore|refactor(${scopeFor(issue)}): ...\`, pick the type that fits). For work without behaviour change (docs, config) one commit is fine. Use Conventional Commits in English.
4. Stage files by name only; never stage everything at once. Make small commits. Add no Co-Authored-By or AI attribution unless CLAUDE.md says otherwise.
5. Stay inside the issue's scope. Anything else you notice goes into "outOfScope", unchanged in the code.
6. If a requirement is ambiguous in a way that changes behaviour or a contract and the spec does not answer it, do NOT guess: return status "blocked" with blockedReason stating the question. For minor ambiguity, decide, and record the decision in "assumptions".
7. Do not push, open a PR, or touch GitHub labels.
Return: status, a short summary, the commits you made ("<sha> <message>"), files changed, assumptions, outOfScope, and touchesUi (true when the diff against ${baseRef} changes user-facing UI).`
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
Return the same structure as the implement stage; "commits" lists only the commits you made now.`
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
2. Walk EVERY acceptance criterion of the issue. mode "http": call the API with curl and compare status and body to the criterion. mode "browser": use ${browser} to navigate, act as the user, and read the page (accessibility tree or text) to check the visible result; take screenshots only for your own check. Use whichever allowed mode fits each criterion and report the mode(s) used.
3. Record each step as action / expected / actual / pass.
4. ALWAYS stop the dev server you started, also when a step fails, and make sure no process is left listening on its port.
5. Do not edit or commit any file, and do not push.
If you cannot run verification at all (server never started, tool unavailable), return ran=false with the reason in notes; a failure of the code under test is ran=true with pass=false steps.`
}

function reviewPrompt(issue, branch, state, round) {
  return `Review the change for issue #${issue.number} on branch ${branch}. You are read-only: do not edit, commit, push, or change GitHub. Review round ${round + 1}.

devflow config:
${cfgJson}

${issueBlock(issue)}

Run \`git diff ${baseRef}...HEAD\` and \`git log ${baseRef}..HEAD --oneline\`. Read the spec the issue links and the project's CLAUDE.md.
Review, in this order:
1. Correctness against the issue's acceptance criteria and the spec (bugs, missed edge cases, wrong contracts).
2. Tests: does each behaviour change have a test that would fail without it? Were tests weakened?
3. Scope creep: changes not needed for the acceptance criteria.
4. CLAUDE.md conventions and its "Never" list.
Severity: critical = wrong behaviour / data loss / security / rule violation; warning = likely bug, missing test, scope creep; suggestion = optional improvement. Only report real problems with a file and line. verdict "pass" means no critical or warning findings.

Implementation summary: ${state.summary}
Assumptions recorded so far: ${JSON.stringify(state.assumptions)}`
}

function shipPrompt(issue, branch, state) {
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

Steps:
1. \`git push -u ${remote} ${branch}\`. Never push to ${base} or any protected branch; never force-push.
2. Open a PR with head ${branch} and base ${base} in ${gh.owner}/${gh.repo}. Title: Conventional Commits style summary with scope "${scopeFor(issue)}", English, under 72 characters. Body as described, ending with the line "Closes #${issue.number}". The body must not contain any at-sign mention of a bot or user, and no AI attribution.
3. On issue #${issue.number} add the label "${labels.review}" and remove "${labels.inProgress}" (keep other labels).
4. \`git switch ${startBranch}\`.
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
2. ${branch ? `If \`git log ${baseRef}..${branch} --oneline\` shows commits, push the branch so work is not lost: \`git push -u ${remote} ${branch}\` (never force, never push to ${base}).` : 'No branch to push.'}
3. Comment on issue #${issue.number}: the stage ("${stage}"), the reason, and the concrete question or decision a human must provide to unblock it${branch ? `, and the branch name ${branch}` : ''}. No at-sign mentions of bots.
4. On the issue add the label "${labels.blocked}" and remove "${labels.inProgress}" (keep other labels).
5. \`git switch ${startBranch}\` (if the working tree is dirty, use \`git stash push -u -m devflow-blocked-${issue.number}\` first and say so in note).
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
  return { ok: true }
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

  // Claim
  phase('Implement')
  const claim = await agent(claimPrompt(issue), {
    label: `claim #${issue.number}`,
    phase: 'Implement',
    schema: CLAIM_SCHEMA,
    model: 'haiku',
  })
  if (!claim || !claim.ok || !claim.branch) {
    return block('Claim', (claim && claim.problem) || 'The claim agent failed or could not create the branch.')
  }
  branch = claim.branch

  // Implement
  const impl = await agent(implementPrompt(issue, branch), {
    label: `implement #${issue.number}`,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
    model: 'sonnet',
  })
  if (!impl) return block('Implement', 'The implement agent died.')
  merge(state, impl)
  if (impl.status === 'blocked') return block('Implement', impl.blockedReason || 'The implement agent reported blocked without a reason.')

  // Check
  const checked = await checkLoop(issue, branch, state)
  if (!checked.ok) return block('Check', checked.reason)

  // Verify
  const needsVerify =
    verifyCfg.modes.length > 0 && (issue.labels.indexOf(labels.e2e) !== -1 || state.touchesUi)
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

  // Ship
  phase('Ship')
  const ship = await agent(shipPrompt(issue, branch, state), {
    label: `ship #${issue.number}`,
    phase: 'Ship',
    schema: SHIP_SCHEMA,
    model: 'sonnet', // writes the PR body reviewers read; worth more than haiku
  })
  if (!ship || !ship.ok) return block('Ship', (ship && ship.problem) || 'The ship agent died.')
  return { issue: issue.number, status: 'pr', url: ship.url, prNumber: ship.prNumber }
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
let queue = selected.issues
if (queue.length > limit) {
  for (const extra of queue.slice(limit)) {
    log(`Skipped #${extra.number}: over limit (${limit})`)
    report.push({ issue: extra.number, status: 'skipped', reason: `over limit (${limit})` })
  }
  queue = queue.slice(0, limit)
}
log(queue.length ? `Working on ${queue.map((i) => '#' + i.number).join(', ')} sequentially.` : 'No eligible issues.')

for (const issue of queue) {
  let result
  try {
    result = await runIssue(issue)
  } catch (e) {
    result = { issue: issue.number, status: 'blocked', reason: `Workflow error: ${e && e.message ? e.message : e}` }
  }
  report.push(result)
  // Every issue starts from a clean checkout of the original branch.
  await agent(restorePrompt(), { label: `restore ${startBranch}`, phase: 'Report', schema: RESTORE_SCHEMA, model: 'haiku' })
}

phase('Report')
log(report.map((r) => `#${r.issue}: ${r.status}${r.url ? ' ' + r.url : ''}${r.reason ? ' (' + r.reason + ')' : ''}`).join('\n'))
return report
