export const meta = {
  name: 'next-task-engine',
  description: 'Pick up ready GitHub issues one at a time: implement test-first, run checks, verify, review, and open a PR for each.',
  whenToUse: 'Internal engine of /devflow:next-task; do not run it directly. Started by /devflow:next-task after preflight. Needs args: config (parsed .claude/devflow.json), limit, issues, startBranch, prTemplatePath, isolated, chain, claimId, ghCli.',
  phases: [
    { title: 'Select', detail: 'list ready issues, dependencies first' },
    { title: 'Implement', detail: 'claim, branch, plan on the issue, QA tests and the change in parallel, test commit first' },
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

// Test hook: the pure helpers below are function declarations (hoisted), so tests get them without a run.
// They take every input as a parameter and never touch the run state.
if (args && args.exports === true) return { parseDiff, scanWeakenedChecks, checkConfigGlobs, globToRegExp, priorityRank, orderIssues, isFixIssue }

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
    triage: 'needs-triage',
    priority: ['priority:critical', 'priority:high', 'priority:normal', 'priority:low'],
  },
  cfg.labels,
)
const priorityList = Array.isArray(labels.priority) ? labels.priority : []
const riskCfg = Object.assign({ highPaths: [] }, cfg.risk)
const testingCfg = Object.assign({ e2eFramework: false }, cfg.testing)
const nt = Object.assign({ defaultLimit: 3, maxFixRounds: 2, maxReviewRounds: 2, parallelQa: true, reviewerAgent: 'devflow:reviewer' }, cfg.nextTask)
const verifyCfg = Object.assign({ modes: [], browserTool: 'playwright', lock: true }, cfg.verify)
const branchPattern = cfg.branchPattern || '{type}/{issue}-{slug}'
const startBranch = args.startBranch
const isolated = args.isolated === true // own worktree: there is no start branch to return to
const chain = args.chain === true // explicit issues are a lane: in order, each stacked on the previous one
const claimId = String(args.claimId || 'run')
const ghCli = args.ghCli !== false // false: the gh CLI is not installed, so the GitHub MCP server is the only way to GitHub
const limit = args.limit || nt.defaultLimit
const explicitIssues = Array.isArray(args.issues) ? args.issues : []
const cfgJson = JSON.stringify(cfg, null, 2)

// The marker a stage reports when GitHub cannot be reached; the run stops instead of blocking issue after issue.
const MCP_DOWN = 'GitHub MCP unavailable'
const mcpDown = (text) => String(text || '').indexOf(MCP_DOWN) !== -1

const MCP_NOTE =
  'Use the GitHub MCP server for every GitHub operation (issues, labels, PRs, comments); load its tools with ToolSearch first ' +
  '(e.g. query "github issue", "github pull request"). Do not use the gh CLI unless the MCP server is unavailable. ' +
  'Issue labels are replaced as a whole by issue_write: read the issue first, then write the full new label list. ' +
  'Adding a label that does not exist yet creates it.' +
  (ghCli
    ? ''
    : ' The gh CLI is not installed. If the GitHub MCP server is unavailable (its tools are missing or every call fails), do not look for other ways: stop and report the problem starting with exactly "' +
      MCP_DOWN +
      '".')

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
          resumeBranch: {
            type: 'string',
            description: `Head branch of the issue's own open ${labels.devflow} PR (the one holding "Closes #<n>"); omit when there is none`,
          },
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
    taken: { type: 'boolean', description: 'True when the issue has an assignee other than the authenticated user, or the in-progress / blocked / review label' },
    assignedByRun: { type: 'boolean', description: 'True when this call added the authenticated user as assignee (false when already assigned)' },
    takenBy: { type: 'string' },
    problem: { type: 'string' },
    claims: {
      type: 'array',
      description: 'Every devflow-claim comment on the issue after ours was posted',
      items: {
        type: 'object',
        properties: { commentId: { type: 'integer' }, claimId: { type: 'string' }, createdAt: { type: 'string' }, author: { type: 'string', description: 'Login of the comment author' } },
        required: ['commentId', 'claimId', 'createdAt', 'author'],
      },
    },
  },
  required: ['taken', 'assignedByRun', 'claims'],
}

const BRANCH_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    branch: { type: 'string' },
    parentMerged: { type: 'boolean', description: 'true when the parent PR was already merged and the branch starts from the base' },
    resumed: { type: 'boolean', description: 'true when the branch already had commits of this issue and the run continues on it' },
    commits: { type: 'array', items: { type: 'string' }, description: 'When resumed: the commits already on the branch, "<sha> <message>"' },
    problem: { type: 'string' },
  },
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
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Open questions the spec and issue do not answer, each starting with "[BA] " or "[QA] "',
    },
    qaFiles: { type: 'array', items: { type: 'string' }, description: 'Test files that hold the tests for the Test cases rows (owned by the QA agent)' },
    devFiles: { type: 'array', items: { type: 'string' }, description: 'Files the implementation changes (owned by the dev agent)' },
    specRead: { type: 'string', description: 'The spec path that was read, or "none" when the issue links no spec' },
  },
  required: ['status', 'plan', 'questions', 'qaFiles', 'devFiles', 'specRead'],
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
    rootCause: {
      type: 'object',
      description: 'Fix issues only: why the bug happened',
      properties: {
        cause: { type: 'string', description: 'The root cause in one or two sentences' },
        introducedBy: { type: 'string', description: 'The PR, commit or acceptance criterion that introduced it ("unknown" if not found)' },
        whyMissed: { type: 'string', description: 'Why tests, review or acceptance did not catch it' },
      },
      required: ['cause', 'introducedBy', 'whyMissed'],
    },
    outOfScopeDone: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fix rounds: items of the earlier out-of-scope list that this fix implemented, copied exactly',
    },
    touchesUi: { type: 'boolean', description: 'True when the diff against the base branch changes user-facing UI' },
    blockedReason: { type: 'string' },
    specRead: { type: 'string', description: 'The spec path that was read, or "none" when the issue links no spec' },
    manualChecks: {
      type: 'array',
      description: 'Test cases rows that cannot be automated (manual or review checklist), checked by hand',
      items: {
        type: 'object',
        properties: { rowId: { type: 'string' }, result: { enum: ['pass', 'fail', 'not-run'] }, evidence: { type: 'string' } },
        required: ['rowId', 'result', 'evidence'],
      },
    },
  },
  required: ['status', 'summary', 'commits', 'filesChanged', 'assumptions', 'outOfScope', 'touchesUi', 'specRead'],
}

const QA_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'blocked'] },
    tests: {
      type: 'array',
      description: 'One entry per test written',
      items: {
        type: 'object',
        properties: { rowId: { type: 'string' }, test: { type: 'string' } },
        required: ['rowId', 'test'],
      },
    },
    filesChanged: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' }, description: 'Questions that block a test, each starting with "[QA] "' },
    specRead: { type: 'string', description: 'The spec path that was read, or "none" when the issue links no spec' },
  },
  required: ['status', 'tests', 'filesChanged', 'questions', 'specRead'],
}

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' }, description: 'One "<sha> <message>" per commit, in order' },
    failedFirst: { type: 'boolean', description: 'True when the QA tests failed with the implementation stashed' },
    failureNote: { type: 'string', description: 'How the QA tests failed (or why they did not), a few lines' },
    problem: { type: 'string' },
  },
  required: ['ok', 'commits', 'failedFirst'],
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

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    scanned: { type: 'boolean', description: 'The "scanned" field of the script output' },
    hits: {
      type: 'array',
      description: 'The "hits" of the script output, copied exactly',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' }, kind: { type: 'string' }, text: { type: 'string' } },
        required: ['file', 'line', 'kind', 'text'],
      },
    },
    error: { type: 'string', description: 'The "error" field when scanned is false, or the reason the script did not run' },
  },
  required: ['scanned', 'hits'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['pass', 'changes'] },
    acceptedWeakenings: {
      type: 'array',
      description: 'Scan hits (weakened checks) that are justified by the issue itself; each stays in the PR and makes it risk:high',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' }, reason: { type: 'string' } },
        required: ['file', 'line', 'reason'],
      },
    },
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
  properties: {
    ok: { type: 'boolean' },
    prNumber: { type: 'integer' },
    url: { type: 'string' },
    reused: { type: 'boolean', description: 'true when an open PR for the branch already existed and was reused instead of opening a new one' },
    unstacked: { type: 'boolean', description: 'true when the parent PR was already merged and the PR targets the base' },
    followUps: {
      type: 'array',
      description: 'Issues created (or found open) for the out-of-scope items',
      items: {
        type: 'object',
        properties: { number: { type: 'integer' }, title: { type: 'string' }, existing: { type: 'boolean' } },
        required: ['number', 'title'],
      },
    },
    problem: { type: 'string' },
  },
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

// Set once when the configured reviewer agent type cannot be started; later reviews use the default agent.
let reviewerMissing = ''

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

// How tests point at their Test cases row. The issue's own pattern wins over the default.
const TEST_NAMING =
  'If the issue, the spec or the plan states a naming pattern for these tests (for example test_t1_<n>_<description>), name every test exactly by that pattern: no extra prefix, suffix or feature word. Otherwise name it test_t<task>_<n>_<description> (row T1.2 -> test_t1_2_...) or, where names cannot carry the id, add a short comment such as "# T1.2".'

// Test cases rows no test can cover (a manual or review checklist) are still checked, by hand, and reported row by row.
const MANUAL_RULE =
  'For every "Test cases" row that cannot be an automated test (a manual or review checklist, for example a Makefile target or a README line), check it by hand now (in a scratch directory when it writes files, removed afterwards) and report it in manualChecks: rowId, result pass|fail|not-run, and the evidence (command and the relevant output). A "must" row may be not-run only when it truly cannot run here; say why in evidence.'

// Answers from /devflow:answer live in the issue's "## Decisions" section and win over the spec.
const DECISIONS_NOTE =
  'If the issue body has a "## Decisions" section, those decisions were made by a human after the spec was written: where they differ from the spec, the decisions win.'

// Files in both lists. Paths are compared as written, without a leading "./".
function overlap(a, b) {
  const norm = (f) => String(f).trim().replace(/^\.\//, '')
  const set = new Set((a || []).map(norm))
  return Array.from(new Set((b || []).map(norm).filter((f) => set.has(f))))
}

function outside(files, allowed) {
  const norm = (f) => String(f).trim().replace(/^\.\//, '')
  const set = new Set((allowed || []).map(norm))
  return (files || []).map(norm).filter((f) => !set.has(f))
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

// ---------------------------------------------------------------------------------------------
// Weakened checks (pure). A deterministic scan of the diff for changes that make checks pass by
// weakening them instead of fixing the cause. Hits go to Review as critical findings; the ones the
// reviewer accepts as justified stay in the PR and raise its risk to high at Ship.
// ---------------------------------------------------------------------------------------------

// Unified diff (any context size) -> [{file, deleted, added: [{line, text}], removed: [{line, text}]}].
// "--- " / "+++ " are file headers only between "diff --git" and the file's first "@@"; inside a hunk they are
// removed / added content (a removed SQL comment "-- x" is the line "--- x").
function parseDiff(text) {
  const files = []
  let cur = null
  let oldLine = 0
  let newLine = 0
  let inHeader = false
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line)
      cur = { file: m ? m[1] : '', deleted: false, added: [], removed: [] }
      files.push(cur)
      inHeader = true
      continue
    }
    if (!cur) continue
    if (inHeader && line.startsWith('deleted file mode')) {
      cur.deleted = true
      continue
    }
    if (inHeader && line.startsWith('+++ ')) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line)
      if (m) cur.file = m[1]
      continue
    }
    if (inHeader && line.startsWith('--- ')) {
      const m = /^--- a\/(.+)$/.exec(line)
      if (m && !cur.file) cur.file = m[1]
      continue
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      inHeader = false
      oldLine = Number(h[1])
      newLine = Number(h[2])
      continue
    }
    if (inHeader) continue
    if (line.startsWith('+')) cur.added.push({ line: newLine++, text: line.slice(1) })
    else if (line.startsWith('-')) cur.removed.push({ line: oldLine++, text: line.slice(1) })
    else if (line.startsWith(' ')) {
      oldLine++
      newLine++
    }
  }
  return files
}

// Files that configure the project's checks: linters, type checkers, test runners, CI, devflow itself,
// and any script path named in a check command. Globs, matched with globToRegExp.
function checkConfigGlobs(checks) {
  const globs = [
    '.claude/devflow.json',
    '**/pyproject.toml',
    '**/setup.cfg',
    '**/tox.ini',
    '**/.flake8',
    '**/ruff.toml',
    '**/.ruff.toml',
    '**/mypy.ini',
    '**/.mypy.ini',
    '**/pytest.ini',
    '**/.coveragerc',
    '**/.eslintrc*',
    '**/eslint.config.*',
    '**/.prettierrc*',
    '**/tsconfig*.json',
    '**/jest.config.*',
    '**/vitest.config.*',
    '**/playwright.config.*',
    '**/.golangci.y*ml',
    '.pre-commit-config.yaml',
    '.github/workflows/*',
    '.github/scripts/**',
    '.github/actions/**',
  ]
  for (const c of Array.isArray(checks) ? checks : []) {
    const words = String((c && c.run) || '').split(/\s+/).filter(Boolean)
    // Simple commands of the check: split at && || ; |
    const starts = String((c && c.run) || '')
      .split(/&&|\|\||;|\|/)
      .map((part) => part.trim().split(/\s+/)[0] || '')
    if (starts.some((w) => w === 'make')) globs.push('Makefile', '**/Makefile')
    for (const w of words) {
      // A script path in the command (scripts/lint.sh, ./bin/check): a word with a slash and no flag or URL.
      if (/^(\.\/)?[\w.-]+(\/[\w.-]+)+$/.test(w) && !/^(\.\/)?(\.venv|venv|node_modules)\//.test(w)) {
        globs.push(w.replace(/^\.\//, ''))
      }
    }
  }
  return Array.from(new Set(globs))
}

// hits: [{file, line, kind, text}]. diffText is `git diff` output; configGlobs from checkConfigGlobs.
// ignoreGlobs (optional, scan.ignore): files matching one are skipped entirely, except .claude/devflow.json.
function scanWeakenedChecks(diffText, configGlobs, ignoreGlobs) {
  const isTestFile = (f) =>
    /(^|\/)(tests?|__tests__|spec|specs)\//.test(f) ||
    /(^|\/)(test_[^/]*\.py|[^/]*_test\.(py|go|rs)|[^/]*\.(test|spec)\.[cm]?[jt]sx?|[^/]*Tests?\.(java|kt)|[^/]*_spec\.rb)$/.test(f) ||
    /(^|\/)src\/test\//.test(f)
  const isProse = (f) => /\.(md|mdx|txt|rst|adoc)$/i.test(f) || /(^|\/)docs\//.test(f)
  const ADDED = [
    { kind: 'noqa', re: /#\s*noqa\b/i },
    { kind: 'type: ignore', re: /#\s*type:\s*ignore\b/ },
    { kind: 'pyright/pylint disable', re: /#\s*(pyright:\s*ignore|pylint:\s*disable)\b/ },
    { kind: 'skipped test', re: /@?pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.(skip|xfail)\(/ },
    { kind: 'skipped or focused test', re: /\b(it|test|describe|context|suite)\.(skip|only|todo)\b|\b(xit|xdescribe|xtest|fit|fdescribe)\(/ },
    { kind: 'eslint-disable', re: /eslint-disable/ },
    { kind: 'ts-ignore', re: /@ts-(ignore|nocheck|expect-error)\b/ },
    { kind: 'empty except', re: /^\s*except\b[^:]*:\s*(pass|\.\.\.)\s*(#.*)?$/ },
    { kind: 'collection ignored', re: /\bcollect_ignore(_glob)?\b|\bpytest_ignore_collect\b/ },
    { kind: 'nolint', re: /\/\/\s*nolint\b/ },
    { kind: 'rubocop:disable', re: /#\s*rubocop:disable\b/ },
    { kind: 'skipped test', re: /@(Disabled|Ignore)\b|#\[ignore\b/ },
    { kind: 'empty catch', re: /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/ },
  ]
  const GO_SKIP = /\b\w+\.Skip(f|Now)?\(/
  const HOLLOW = /^\s*assert\s+(True|1)\s*(,.*)?(#.*)?$|expect\(true\)\.(toBe\(true\)|toBeTruthy\(\))|\bassert(\.ok)?\(true\)/
  const PKG_SCRIPT_KEY = /^(pre|post)?(test|lint|check|typecheck|type-check|tsc|format|build|ci|e2e|verify)([:._-][\w:.-]*)?$/
  const PKG_DEP_VALUE = /^([\^~<>=v]*\d|\*$|latest$|next$|workspace:|npm:|file:|link:|git[+:]|git$|github:|gitlab:|bitbucket:|https?:)/
  const PKG_TOOL_OPEN = /^\s*"(jest|eslintConfig|prettier|mocha|vitest|ava|nyc|c8|lint-staged|husky|scripts)"\s*:\s*\{/
  const isPkgCheckLine = (text) => {
    if (PKG_TOOL_OPEN.test(text)) return true
    const m = /^\s*"([^"]+)"\s*:\s*(.*?),?\s*$/.exec(text)
    return !!m && PKG_SCRIPT_KEY.test(m[1]) && !PKG_DEP_VALUE.test(m[2].replace(/^"|"$/g, ''))
  }
  const TEST_DEF = /^\s*(async\s+)?def\s+test\w*\s*\(|^\s*(it|test)\s*\(|^\s*func\s+Test\w+\s*\(/
  const ASSERT = /\bassert\b|\bself\.assert\w+\(|\bexpect\s*\(|\bassert\w*\s*\(|\bt\.(Error|Fatal)f?\(/
  const configRes = (Array.isArray(configGlobs) ? configGlobs : []).map(globToRegExp)
  const ignoreRes = (Array.isArray(ignoreGlobs) ? ignoreGlobs : []).filter((g) => typeof g === 'string').map(globToRegExp)
  const hits = []
  for (const f of parseDiff(diffText)) {
    if (!f.file) continue
    if (f.file !== '.claude/devflow.json' && ignoreRes.some((re) => re.test(f.file))) continue
    if (f.deleted && isTestFile(f.file)) {
      hits.push({ file: f.file, line: 0, kind: 'deleted test file', text: '' })
      continue
    }
    if (configRes.some((re) => re.test(f.file)) && (f.added.length || f.removed.length || f.deleted)) {
      const first = f.added[0] || f.removed[0] || { line: 0, text: '' }
      hits.push({ file: f.file, line: first.line, kind: 'check configuration changed', text: first.text.trim() })
    }
    if (/(^|\/)package\.json$/.test(f.file) && !configRes.some((re) => re.test(f.file))) {
      const first = f.added.find((l) => isPkgCheckLine(l.text)) || f.removed.find((l) => isPkgCheckLine(l.text))
      if (first) hits.push({ file: f.file, line: first.line, kind: 'check configuration changed', text: first.text.trim() })
    }
    for (let i = 0; i < f.added.length && !isProse(f.file); i++) {
      const a = f.added[i]
      for (const p of ADDED) {
        if (p.re.test(a.text)) hits.push({ file: f.file, line: a.line, kind: p.kind, text: a.text.trim() })
      }
      if (/_test\.go$/.test(f.file) && GO_SKIP.test(a.text)) hits.push({ file: f.file, line: a.line, kind: 'skipped test', text: a.text.trim() })
      if (isTestFile(f.file) && HOLLOW.test(a.text)) hits.push({ file: f.file, line: a.line, kind: 'hollow assertion', text: a.text.trim() })
      // "except ...:" with "pass" on the next added line
      const next = f.added[i + 1]
      if (/^\s*except\b[^:]*:\s*(#.*)?$/.test(a.text) && next && next.line === a.line + 1 && /^\s*(pass|\.\.\.)\s*(#.*)?$/.test(next.text)) {
        hits.push({ file: f.file, line: a.line, kind: 'empty except', text: `${a.text.trim()} ${next.text.trim()}` })
      }
    }
    if (isTestFile(f.file)) {
      const count = (lines, re) => lines.filter((l) => re.test(l.text)).length
      const lostTests = count(f.removed, TEST_DEF) - count(f.added, TEST_DEF)
      if (lostTests > 0) {
        const first = f.removed.find((l) => TEST_DEF.test(l.text))
        hits.push({ file: f.file, line: first.line, kind: `removed ${lostTests} test(s)`, text: first.text.trim() })
      }
      const lostAsserts = count(f.removed, ASSERT) - count(f.added, ASSERT)
      if (lostAsserts > 0) {
        const first = f.removed.find((l) => ASSERT.test(l.text))
        hits.push({ file: f.file, line: first.line, kind: `removed ${lostAsserts} assertion(s)`, text: first.text.trim() })
      }
    }
  }
  return hits
}

// ---------------------------------------------------------------------------------------------
// Priority and fix issues (pure)
// ---------------------------------------------------------------------------------------------

// Index of the first label of `list` the issue has. No priority label counts as the "normal" entry (the first
// whose name ends in "normal"), or after every listed priority when the list has none.
function priorityRank(names, list) {
  const order = Array.isArray(list) ? list : []
  const has = new Set(names || [])
  const hit = order.findIndex((l) => has.has(l))
  if (hit !== -1) return hit
  const normal = order.findIndex((l) => /normal$/i.test(l))
  return normal !== -1 ? normal : order.length
}

// Dependencies first (inside the set), then priority, then issue number. A child pulls its open parents
// forward: a parent's effective rank is the best rank among itself and everything that depends on it.
// A cycle does not drop issues: the best remaining one is placed and the walk goes on.
function orderIssues(issues, list) {
  const items = Array.isArray(issues) ? issues : []
  const byNum = new Map(items.map((i) => [i.number, i]))
  const depsOf = (i) => {
    const out = new Set()
    for (const d of Array.isArray(i.dependsOn) ? i.dependsOn : []) out.add(Number(d))
    for (const p of Array.isArray(i.parents) ? i.parents : []) out.add(Number(p.issue))
    out.delete(i.number)
    return Array.from(out).filter((d) => byNum.has(d))
  }
  const deps = new Map(items.map((i) => [i.number, depsOf(i)]))
  const children = new Map(items.map((i) => [i.number, []]))
  for (const [n, ds] of deps) for (const d of ds) children.get(d).push(n)
  // Effective rank: the best rank among the issue and every issue that depends on it, transitively (cycle-safe).
  const eff = new Map()
  for (const i of items) {
    let best = priorityRank(i.labels, list)
    const seen = new Set([i.number])
    const todo = children.get(i.number).slice()
    while (todo.length) {
      const c = todo.pop()
      if (seen.has(c)) continue
      seen.add(c)
      best = Math.min(best, priorityRank(byNum.get(c).labels, list))
      todo.push(...children.get(c))
    }
    eff.set(i.number, best)
  }
  const better = (a, b) => eff.get(a) - eff.get(b) || a - b
  const placed = new Set()
  const out = []
  while (out.length < items.length) {
    const left = items.map((i) => i.number).filter((n) => !placed.has(n))
    const ready = left.filter((n) => deps.get(n).every((d) => placed.has(d)))
    const next = (ready.length ? ready : left).sort(better)[0]
    placed.add(next)
    out.push(byNum.get(next))
  }
  return out
}

// A bug fix: a fix or bug type label, a gap label from /devflow:accept, a gap title, or a bug-template body.
function isFixIssue(issue, config) {
  const names = (issue && issue.labels) || []
  const gapLabels = (config && config.accept && Array.isArray(config.accept.labels) ? config.accept.labels : ['type:gap'])
  if (names.some((l) => ['type:fix', 'type:bug', 'bug', 'fix'].indexOf(l) !== -1 || gapLabels.indexOf(l) !== -1)) return true
  const title = String((issue && issue.title) || '')
  if (/\bGap:/.test(title) || /^fix(\(|:|\b)/i.test(title)) return true
  return /^##\s+Introduced by\b/m.test(String((issue && issue.body) || ''))
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
    ? `Explicit issues requested by the user: ${explicitIssues.map((n) => '#' + n).join(', ')}. Use exactly these (still skip, with a reason, any that is closed, or that has an open PR referencing it except as allowed by the open-PR rule below). Do not apply the label filter to them.${chain ? ` These issues are a lane to run in exactly this order: return them in the order given and do not reorder them. Lane order is handled by the engine, so an earlier issue of the same list is NOT a parent by itself: add it to parents (inRun true, as below) only when this issue has a real \"Depends on\" line for it. Do not skip an issue only because an earlier issue of the same list is still open without a PR.` : ''}`
    : `No explicit issues. Select open issues labelled "${labels.ready}" that are NOT labelled "${labels.inProgress}", "${labels.blocked}" or "${labels.triage}".`
  return `You are selecting GitHub issues for ${gh.owner}/${gh.repo}. ${MCP_NOTE}

devflow config:
${cfgJson}

${explicit}

Rules:
- Skip an issue that already has an open pull request referencing it (search open PRs for "#<number>", check "Closes"/"Fixes" lines and branch names). Exception: do not skip the issue when its only open PR has the label "${labels.devflow}" and a "Closes #<number>" line for it, and the issue is not labelled "${labels.review}"; return that PR's head branch as "resumeBranch" for the issue. Any other open PR referencing the issue still skips it. An issue labelled "${labels.review}" is skipped even when its only open PR is its own ${labels.devflow} PR.
- The issue body may contain lines "Depends on #<n>". If every such issue is closed, the issue is eligible as normal: parents = [].
- Every dependency that is still open becomes one entry in "parents". It must be one of:
  - it has an open pull request (find open PRs whose body contains "Closes #<dep>"): {issue: <dep>, prNumber: <that PR's number>, branch: <that PR's head branch>, inRun: false};
  - or it has no open PR but is itself in your selection (it will be worked on earlier in this run): {issue: <dep>, prNumber: 0, branch: "", inRun: true}. The workflow fills in the PR once the parent ships.
- If any open dependency has neither an open PR nor a place in your selection, the issue goes in "skipped" with the reason (name that dependency).
- Always return "parents" for every selected issue (an empty array when there is none).
- Never select an issue labelled "${labels.triage}" (a human has not triaged it yet); if one is requested explicitly, put it in "skipped" with reason "${labels.triage}: a human sets it ready first".
- Order: ${chain && explicitIssues.length ? 'the order of the explicit issues' : `parents before children, then by priority label in this order: ${priorityList.join(', ')} (an issue without one counts as ${priorityList.find((l) => /normal$/i.test(l)) || 'the lowest'}), then oldest first (lowest number). The workflow re-sorts the list the same way.`}
- Return at most ${limit * 3} eligible issues in "issues" (the workflow applies the limit of ${limit}, because a child whose parent does not ship is not worked on and does not count). When there are more, keep the highest priority ones and the in-selection parents they depend on. Everything beyond that goes in "skipped" with reason "over limit".
- For each selected issue return its full body verbatim, its label names, and the dependency numbers from its "Depends on" lines.
This is read-only: do not change anything on GitHub or in the checkout.`
}

function claimPrompt(issue) {
  return `Claim GitHub issue #${issue.number} in ${gh.owner}/${gh.repo}. ${MCP_NOTE}

devflow config:
${cfgJson}

Steps, in order:
1. Read issue #${issue.number}. The issue is taken only when it has an assignee other than the authenticated user, or the label "${labels.inProgress}", "${labels.blocked}" or "${labels.review}". An issue assigned only to the authenticated user with none of these labels is not taken: claim it. An issue assigned to the authenticated user and another user is taken. If it is taken, return taken=true, takenBy = the other assignee login or the label name, claims = []. Change and post nothing.
2. Otherwise add the authenticated user as assignee only when not already assigned, and return assignedByRun=true when you added them, assignedByRun=false when they were already assigned. Add the label "${labels.inProgress}" and remove "${labels.ready}" (keep all other labels).
3. Post a comment on the issue whose body is exactly these two lines:
<!-- devflow-claim id=${claimId} -->
Claimed by devflow (${claimId}).
4. Read ALL comments of the issue again. Return in "claims" every comment whose body contains "<!-- devflow-claim id=": its comment id, the claim id parsed from that marker, its created_at timestamp and its author login. Return taken=false.`
}

function releasePrompt(issue, removeAssignee) {
  return `Release a lost claim on GitHub issue #${issue.number} in ${gh.owner}/${gh.repo}. ${MCP_NOTE}

Another devflow run claimed the issue first. Delete only the comment(s) on the issue whose body contains "<!-- devflow-claim id=${claimId} -->". Do not touch any other comment or the labels: they belong to the winner. ${removeAssignee ? 'Also remove the authenticated user from the assignees of the issue (this run added them; the winner is a different user). Do not remove any other assignee.' : 'Do not touch the assignee: it belongs to the winner.'} Return ok=true when none of your claim comments remain.`
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
1. ${issue.resumeBranch ? `Resume exactly the branch "${issue.resumeBranch}" (the head branch of this issue's open PR); do not derive a new branch name. When it exists only on ${remote}, fetch it first (\`git fetch ${remote} ${issue.resumeBranch}\`) and continue on it as in step 3.` : `Work out the branch name from branchPattern "${branchPattern}": {issue} = ${issue.number}; {type} = the value of the issue's "type:<type>" label if present, otherwise infer one of feat|fix|chore|docs|refactor|test from the title; {slug} = at most 5 words of the title, kebab-case, ASCII only, without the "[<slug>] T<n>:" prefix.`}
2. Run \`git status --porcelain\`; it must be empty. If not, return ok=false with the problem.
3. Run \`git fetch ${remote} ${fetchBranch}\` then \`git switch -c <branch> ${parentRef}\` (this also works from a detached HEAD). Before creating it, check whether the branch already exists locally (\`git rev-parse --verify -q <branch>\`) or on ${remote} (\`git ls-remote --heads ${remote} <branch>\`).
   - Exists with no commits of its own (\`git log ${parentRef}..<branch> --oneline\` empty) and not on ${remote}: an empty leftover from a run blocked at Plan; recreate it with \`git switch -C <branch> ${parentRef}\`.
   - Exists with commits of its own whose messages use scope "${scopeFor(issue)}": an earlier run of this issue that was blocked after Plan. Continue on it: \`git switch <branch>\` (when it is only on ${remote}: \`git fetch ${remote} <branch>\` and \`git switch -c <branch> --track ${remote}/<branch>\`; when both exist and differ, use the ${remote} one only if the local one has no commits of its own beyond it, otherwise return ok=false), then \`git merge --no-edit ${parentRef}\`. If that merge conflicts, run \`git merge --abort\` and return ok=false with the conflicting files. Return resumed=true and commits = the lines of \`git log --oneline ${parentRef}..HEAD\` (merge commits excluded).
   - Anything else (commits from another issue, or a dirty state): return ok=false with the problem; do not reuse or delete it.${parents.length === 1 ? `
   If the fetch fails because ${parents[0].branch} no longer exists on ${remote}, read PR #${parents[0].prNumber} with pull_request_read. Merged (\`merged_at\` is not null in that result): its changes are in ${base}, so run \`git fetch ${remote} ${base}\` and \`git switch -c <branch> ${baseRef}\` instead and return parentMerged=true. Closed without merging: return ok=false with the problem.` : ''}
Return the branch name you created. Do not change anything on GitHub.

Issue title: ${issue.title}
Issue labels: ${issue.labels.join(', ')}`
}

function planPrompt(issue, branch) {
  const specPath = specPathFor(issue)
  const qaMode = nt.parallelQa === true
  const step1 = specPath
    ? `Before anything else run \`git show ${baseRef}:${specPath}\` and read the whole spec. Then read the issue's acceptance criteria. The spec and issue are the source of truth for expected behaviour, not the current code.`
    : `The issue links no spec, so the issue text is the contract. Read its acceptance criteria.`
  return `Plan the work for GitHub issue #${issue.number} on branch ${branch} (already checked out). You only plan: do not edit code, do not commit, do not push. ${MCP_NOTE}

devflow config:
${cfgJson}

${issueBlock(issue)}

Instructions:
1. ${step1} ${DECISIONS_NOTE}
2. Read the project's CLAUDE.md and the code the change touches.
3. Work out file ownership.${qaMode ? ` The tests and the change are written in parallel by two agents: a QA agent writes the tests for the "Test cases" rows from the spec and the issue only, a dev agent writes the change. qaFiles = the test files that hold the Test cases tests (QA only); devFiles = every other file the change touches (dev only; dev may add extra tests, but only in files not in qaFiles). No file may be in both lists. When the issue has no Test cases rows that need an automated test (for example a docs-only checklist), qaFiles = [].` : ' qaFiles = []; devFiles = every file the change touches, tests included.'}
4. Write the plan in markdown with sections: Files to change (mark each file QA or Dev); Tests (one entry per "Test cases" row id, or per test-plan item; ${e2eRule(false)}); Risks; Order of commits (failing test first, then the implementation); Open questions (only if there are any).
5. Post the plan on issue #${issue.number} as a comment whose first line is \`<!-- devflow-plan -->\`. If the issue already has a comment starting with that marker, edit it instead of adding another.
6. Look for open questions in two roles. BA: something the spec, the issue and its Decisions do not answer that would change behaviour or a contract. QA: a "Test cases" row that cannot be tested as written (no clear expected result, contradicts the acceptance criteria or another row). Start each question with "[BA] " or "[QA] ". If there is any, return status "blocked" with all of them (still post the plan, with an "Open questions" section). Otherwise return status "ready" and questions = [].
Return status, the plan text exactly as posted, questions, qaFiles, devFiles, and specRead (${specPath ? `the spec path ${specPath}, exactly as you read it` : '"none"'}).`
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
2. For each parent in the order above run \`git merge --no-edit ${remote}/<branch>\`. If a parent branch no longer exists on ${remote}, read its PR with pull_request_read: merged means its changes are already in ${base}, so skip it (leave it out of merged); closed without merging means return ok=false with the problem. Keep the default merge commit message. Never rebase, never force, never rewrite commits.
3. If a merge conflicts, resolve it using the linked issues and the spec so that the behaviour of BOTH parents survives; stage files by name and complete the merge with the default message. Do not change anything that is not needed to resolve the conflict.
4. After all merges, run every configured check; fix only what the integration itself broke:
${checks}
5. Return integrationSha = the output of \`git rev-parse HEAD\` after all merges, and merged = the ${remote}/<branch> names merged, in order.
If you cannot resolve a conflict or the checks cannot be made to pass without a decision, run \`git merge --abort\` if a merge is in progress, leave nothing half-done, and return ok=false with the conflicting files and the question in problem. Do not push and do not touch GitHub labels.`
}

function implementPrompt(issue, branch, planText, own) {
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
${own ? devModeBlock(issue, own) : `
Instructions:
1. ${step1} ${DECISIONS_NOTE}
2. Follow the project's CLAUDE.md for architecture, conventions and its "Never" list.
3. For behaviour changes and bug fixes: first write and commit a failing test (\`test(${scopeFor(issue)}): ...\`), run it and confirm it fails for the right reason, then commit the implementation (\`feat|fix|chore|refactor(${scopeFor(issue)}): ...\`, pick the type that fits). For work without behaviour change (docs, config) one commit is fine. Use Conventional Commits in English.
   If the issue has a "Test cases" table (rows of the spec's test matrix), write a test for every row with priority "must" and make each traceable to its row id. ${TEST_NAMING} "should" rows are optional. If the issue has only a test plan, follow it.
   ${e2eRule(false)}
4. Stage files by name only; never stage everything at once. Make small commits. Add no Co-Authored-By or AI attribution unless CLAUDE.md says otherwise.
   ${MANUAL_RULE}${resumeNote(issue)}${rootCauseNote(issue)}
5. Stay inside the issue's scope. Anything else you notice goes into "outOfScope", unchanged in the code.
6. If a requirement is ambiguous in a way that changes behaviour or a contract and the spec does not answer it, do NOT guess: return status "blocked" with blockedReason stating the question. For minor ambiguity, decide, and record the decision in "assumptions".
7. Do not push, open a PR, or touch GitHub labels.
Return: status, a short summary, the commits you made ("<sha> <message>"), files changed, assumptions, outOfScope, touchesUi (true when the diff against ${parentRef} changes user-facing UI), specRead (${specPath ? `the spec path ${specPath}, exactly as you read it` : '"none"'}), and manualChecks ([] when there are no such rows).`}`
}

// Fix issues: the PR must say why the bug happened.
function rootCauseNote(issue) {
  if (!isFixIssue(issue, cfg)) return ''
  return `\n   This issue is a fix. Find the root cause before changing code, and return rootCause: cause (one or two sentences), introducedBy (the PR, commit or acceptance criterion that introduced it; check \`git log -S\` / \`git blame\` on the faulty lines and the issue's "Introduced by" section; "unknown" if not found) and whyMissed (why tests, review or acceptance did not catch it). The failing test first must reproduce the bug.`
}

// A branch resumed from an earlier blocked run: the agent continues from those commits.
const resumed = {}
function resumeNote(issue) {
  const r = resumed[issue.number]
  if (!r) return ''
  return `\n   This branch already has work from an earlier run of this issue that was blocked: ${JSON.stringify(r)}. Read it (\`git log -p ${parentRefFor(issue)}..HEAD\`), keep what still matches the spec, the issue and its Decisions, and change only what does not. A test that is already committed counts as the failing-test-first commit if it failed before its implementation; add a new failing test first for any new behaviour.`
}

// Dev half of a parallel Implement: the change only, no commits, hands off the QA files.
function devModeBlock(issue, own) {
  const parentRef = parentRefFor(issue)
  const specPath = specPathFor(issue)
  const step1 = specPath
    ? `Before anything else run \`git show ${baseRef}:${specPath}\` and read the whole spec. Then read the issue's acceptance criteria. The spec and issue are the source of truth for expected behaviour, not the current code.`
    : `The issue links no spec, so the issue text is the contract. Read its acceptance criteria.`
  return `
You are the dev half of a parallel pair. A QA agent is writing the tests for the "Test cases" rows at the same time, in the same checkout, in these files: ${JSON.stringify(own.qaFiles)}.

Instructions:
1. ${step1} ${DECISIONS_NOTE}
2. Follow the project's CLAUDE.md for architecture, conventions and its "Never" list.
3. Write the implementation in the files the plan gives to dev: ${JSON.stringify(own.devFiles)}. If you need another file, use it and say so in "assumptions", but never create, edit or delete any of the QA files above. Extra tests of your own are fine in files that are not QA files.
4. Do NOT commit, stage or stash anything: the workflow commits the QA tests first and your change after them. Do not run git commands that change the working tree or the index.
5. You may run the project's checks to see your own work, but do not edit anything to make a QA test pass; the QA tests may still be incomplete while you work.
6. Stay inside the issue's scope. Anything else you notice goes into "outOfScope", unchanged in the code. ${MANUAL_RULE}${rootCauseNote(issue)}
7. If a requirement is ambiguous in a way that changes behaviour or a contract and the spec and Decisions do not answer it, do NOT guess: return status "blocked" with blockedReason stating the question. For minor ambiguity, decide, and record the decision in "assumptions".
8. Do not push, open a PR, or touch GitHub labels.
Return: status, a short summary, commits = [], every file you changed, assumptions, outOfScope, touchesUi (true when your change, compared with ${parentRef}, changes user-facing UI), specRead (${specPath ? `the spec path ${specPath}, exactly as you read it` : '"none"'}), and manualChecks ([] when there are no such rows).`
}

function qaPrompt(issue, branch, planText, own) {
  const specPath = specPathFor(issue)
  const step1 = specPath
    ? `Before anything else run \`git show ${baseRef}:${specPath}\` and read the whole spec. Then read the issue's acceptance criteria and its "Test cases" table.`
    : `The issue links no spec, so the issue text is the contract. Read its acceptance criteria and its "Test cases" table.`
  return `You are the QA half of a parallel pair for GitHub issue #${issue.number} on branch ${branch} (already checked out). A dev agent is writing the implementation at the same time, in the same checkout. ${MCP_NOTE}

devflow config:
${cfgJson}

${issueBlock(issue)}

Plan (already posted on the issue):
${planText}

Instructions:
1. ${step1} ${DECISIONS_NOTE}
2. Read the project's CLAUDE.md for how tests are written (fixtures, test layers, naming).
3. Write a test for every "Test cases" row with priority "must" (and "should" rows when cheap), from the spec, the issue and its Decisions only: black box, against the public interface. Do not read or depend on the dev agent's uncommitted changes (do not run git diff or open files outside your own and the existing code). Make each test traceable to its row id. ${TEST_NAMING} ${e2eRule(false)}
4. Only create or edit these files: ${JSON.stringify(own.qaFiles)}. Never touch any other file.
5. Do NOT commit, stage or stash anything: the workflow commits your tests first. The tests are expected to fail until the change exists; you may run them to check they are collected and fail for the right reason (a missing behaviour, not a syntax or import error of your own).
6. If a row cannot be tested as written (no clear expected result, contradicts the acceptance criteria or another row), do not invent the expectation: add a question starting with "[QA] " and return status "blocked". Otherwise questions = [].
Return status, tests (row id and test name), filesChanged (the files you created or edited), questions, and specRead (${specPath ? `the spec path ${specPath}, exactly as you read it` : '"none"'}).`
}

function commitPrompt(issue, branch, own, qa, dev) {
  const testCheck = cfg.checks.find((c) => /test/i.test(c.name)) || cfg.checks[0]
  return `Commit the work on branch ${branch} for issue #${issue.number}: the QA tests first, then the implementation. Do not edit any file.

QA files: ${JSON.stringify(qa.filesChanged)}
Dev files: ${JSON.stringify(dev.filesChanged)}
Tests written (row id -> test): ${JSON.stringify(qa.tests)}

Steps, in order:
1. \`git status --porcelain\`. Every changed or new file must be in one of the two lists; if not, return ok=false naming the extra files.
2. Stage the QA files by name and commit them: \`test(${scopeFor(issue)}): <what the tests cover>\` (Conventional Commits, English, no AI attribution).
3. Prove they fail without the implementation: \`git stash push -u -m devflow-red-${issue.number} -- <every dev file>\`, run \`${testCheck.run}\`, note how the QA tests fail, then \`git stash pop\`. If the stash pop does not restore every dev file cleanly, stop and return ok=false with the problem (the stash keeps the work). failedFirst = true only if at least one QA test failed because the behaviour is missing (not a syntax or collection error); describe it in failureNote.
4. Stage the dev files by name and commit them with the type that fits (feat|fix|chore|refactor) and scope "${scopeFor(issue)}". Skip this commit only if the dev list is empty.
5. \`git status --porcelain\` must be empty. Never push, never amend or rewrite a commit, never stage everything at once.
Return ok, commits ("<sha> <message>", in order), failedFirst, failureNote.`
}

function checkPrompt() {
  const list = cfg.checks.map((c, i) => `${i + 1}. [${c.name}] ${c.run}`).join('\n')
  return `Run the project's checks in the repository root, in this order. Run every one even if an earlier one fails.

${list}

Report passed=true only if all of them exit 0. For each failing check return its name and the relevant trimmed output (the failing assertions / errors, at most about 60 lines; no passing noise). Do not edit any file and do not commit.`
}

function fixPrompt(issue, branch, why, details, qaFiles) {
  const qaRule =
    qaFiles && qaFiles.length
      ? `\n- These files hold the QA agent's tests for the Test cases rows: ${JSON.stringify(qaFiles)}. Do not edit them. If you are sure a QA test is wrong (it contradicts the spec, the issue or its Decisions), return status "blocked" with blockedReason starting with "[QA] " that names the test and the contradiction.`
      : ''
  return `Fix problems on branch ${branch} for issue #${issue.number}. Reason: ${why}.

devflow config:
${cfgJson}

${issueBlock(issue)}

Problems to fix:
${details}

Instructions:
- Follow the project's CLAUDE.md. Fix the cause, not the symptom; never weaken or delete a test, and never edit acceptance criteria, to make something pass.
- Stay inside the issue's scope. Record unrelated problems in "outOfScope" without changing them.${qaRule}
- Commit with Conventional Commits in English, scope "${scopeFor(issue)}", staging files by name. Never rewrite existing commits. Do not push.
- If you cannot fix it without a decision the spec does not make, return status "blocked" with blockedReason. ${DECISIONS_NOTE}
When a problem says an out-of-scope item is required by the acceptance criteria, implement it (test first) and copy that item exactly into "outOfScopeDone".
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
${verifyCfg.lock !== false ? `0. Take the verify lock first, so parallel sessions on this machine never run the dev server at the same time: \`mkdir "$(git rev-parse --git-common-dir)/devflow-verify.lock"\`. If it already exists, wait 10 seconds and try again, up to 10 minutes; a lock directory older than 30 minutes is stale: remove it and take it. If you still cannot take it, return ran=false with notes "verify lock busy".
` : ''}1. Start the dev server in the background and wait until the URL answers.
2. Walk EVERY acceptance criterion of the issue, and every "Test cases" row with level "http" or "e2e" if the issue has that table. mode "http": call the API with curl and compare status and body to the criterion. mode "browser": use ${browser} to navigate, act as the user, and read the page (accessibility tree or text) to check the visible result; take screenshots only for your own check. Use whichever allowed mode fits each criterion and report the mode(s) used.
3. Record each step as action / expected / actual / pass.
4. ALWAYS stop the dev server you started, also when a step fails, and make sure no process is left listening on its port.${verifyCfg.lock !== false ? ' Then ALWAYS remove the lock directory you took (rmdir), also when something failed.' : ''}
5. Do not edit or commit any file, and do not push.
If you cannot run verification at all (server never started, tool unavailable), return ran=false with the reason in notes; a failure of the code under test is ran=true with pass=false steps.`
}

// The scan runs as a shipped script (bin/devflow-scan) in the checkout, so only the hits travel through the agent.
const pluginRoot = String((args && args.pluginRoot) || '').replace(/\/+$/, '')
const CONFIG_PATH = '.claude/devflow.json'

function scanPrompt(issue, branch) {
  return `Run the weakened-checks scan for branch ${branch} (issue #${issue.number}). Read-only: change nothing.

Run exactly: \`node "${pluginRoot}/bin/devflow-scan" ${parentRefFor(issue)} ${CONFIG_PATH}\`
It prints one JSON object {scanned, hits, error?}. Return scanned and hits exactly as printed (every hit, unchanged) and error when present. If the command cannot be run at all, return scanned=false, hits=[] and the reason in error. Do not produce or print the diff yourself and do not judge the hits.`
}

// Hits the reviewer accepted as justified (same file and line).
function acceptedHit(hit, accepted) {
  return (accepted || []).some((a) => a && a.file === hit.file && Number(a.line) === Number(hit.line))
}

function hitLine(h) {
  return `${h.file}${h.line ? ':' + h.line : ''} ${h.kind}${h.text ? ' (' + h.text.slice(0, 80) + ')' : ''}`
}

function reviewPrompt(issue, branch, state, round, hits) {
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
2. Tests: does each behaviour change have a test that would fail without it? Were tests weakened? If the issue has a "Test cases" table, every row with priority "must" needs a test traceable to its row id; a missing one is a warning that names the row. If the issue, the spec or the plan states a naming pattern for these tests, a test that does not follow it exactly is a warning too (it is cheap to rename now, not later). ${e2eRule(true)}
3. Scope creep: changes not needed for the acceptance criteria.
4. CLAUDE.md conventions and its "Never" list.
5. Out of scope: an item in the out-of-scope list below that leaves behaviour unmet that the issue's acceptance criteria (or a "must" Test cases row) require is NOT out of scope: report it as critical, naming the criterion (for example "AC2.5 requires X; the out-of-scope note leaves it as is"). Only problems the criteria do not cover may stay out of scope.
6. Weakened checks: a deterministic scan of the diff found the hits below (new noqa / type: ignore / eslint-disable / ts-ignore, skipped, focused or deleted tests, removed assertions, empty except or catch, edited check configuration). Each one is critical unless the issue itself asks for exactly that change. For each hit either report it as a critical finding (same file and line) or, only when the issue requires it, list it in acceptedWeakenings with the reason; an accepted hit stays in the PR and makes it risk:high. Also report as critical any other weakening of a check that the scan missed.
Scan hits: ${hits && hits.length ? JSON.stringify(hits) : 'none'}
Severity: critical = wrong behaviour / data loss / security / rule violation; warning = likely bug, missing test, scope creep; suggestion = optional improvement. Only report real problems with a file and line. verdict "pass" means no critical or warning findings.

Implementation summary: ${state.summary}
Assumptions recorded so far: ${JSON.stringify(state.assumptions)}
Out of scope recorded so far: ${JSON.stringify(state.outOfScope)}
Manual checks (rows checked by hand): ${JSON.stringify(state.manualChecks)}. A "must" Test cases row that is neither covered by a test nor in this list with result pass is a warning that names the row; a manual check with result fail is a warning too.`
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
- Manual checks (put them in the Tests section as a table: row, result, evidence): ${JSON.stringify(state.manualChecks)}
- Review notes (suggestions that were NOT applied): ${JSON.stringify(state.suggestions)}
- Assumptions: ${JSON.stringify(state.assumptions)}
- Out of scope: ${JSON.stringify(state.outOfScope)} (review already confirmed none of these is required by the acceptance criteria)${isFixIssue(issue, cfg) ? `
- Root cause: ${(state.rootCause && state.rootCause.cause) || 'unknown'}; Introduced by: ${(state.rootCause && state.rootCause.introducedBy) || 'unknown'}; Why it was missed: ${(state.rootCause && state.rootCause.whyMissed) || 'unknown'}` : ''}
- ${riskLine}
${stacked ? `- Stacked on ${parentList(issue)}.\n` : ''}
Steps:
0. Look for an open PR with head ${branch} in ${gh.owner}/${gh.repo} (a PR left by an earlier run). If one exists, reuse it: push normally (step 1), retarget its base to ${prBase}${parents.length === 1 ? ` (or to ${base} when step 1b finds the parent merged)` : ''} with update_pull_request when it differs, rewrite its title and body from the data as in step 2, add the labels of step 3 without removing any label already on it (never remove "${labels.riskHigh}" or any other label already on it${parents.length === 1 ? `, except "${labels.stacked}" when step 1b finds the parent merged` : ''}), do not open a new PR, return reused=true with its number and URL, then continue with step 4 (the issue labels). Steps 2 and 3 apply only when no such PR exists; step 2b still applies. If none exists, go on with step 1 and return reused=false.
1. \`git push -u ${remote} ${branch}\`. Never push to ${base} or any protected branch; never force-push.${parents.length === 1 ? `
1b. Read PR #${parents[0].prNumber} with pull_request_read; it may have been merged (and its branch deleted) while this issue was built. Merged (\`merged_at\` is not null in that result): its changes are in ${base}, so in steps 0, 2 and 3 use base ${base} (on a reused PR retarget to it, remove the stack line and the "${labels.stacked}" label), leave out the stack line and do not add the "${labels.stacked}" label, and return unstacked=true. Closed without merging: stop and return ok=false with the problem.` : ''}
2. Open a PR with head ${branch} and base ${prBase} in ${gh.owner}/${gh.repo}. Title: Conventional Commits style summary with scope "${scopeFor(issue)}", English, under 72 characters. Body as described,${isFixIssue(issue, cfg) ? ' with the sections "Root cause", "Introduced by" and "Why it was missed" filled from the Root cause data (this is a fix; write "unknown" where the data says so),' : ''} with a "Risk" section holding exactly this line: "${riskLine}"${stacked ? `, and the line "${stackLine}"` : ''}, ending with the line "Closes #${issue.number}". The body must not contain any at-sign mention of a bot or user, and no AI attribution.
2b. Out of scope: for each out-of-scope item that describes a real problem in the product (not a note about style or a remark), search open issues in ${gh.owner}/${gh.repo} for one that already covers it; if there is none, create an issue titled "[follow-up #${issue.number}] <short summary>" with labels "${labels.triage}" only (never "${labels.ready}": a human triages it) and a body ${args.bugTemplatePath ? `from the bug template at ${args.bugTemplatePath} (keep its headings, "unknown" or "None" where you have nothing)` : 'with the sections Context, Expected, Actual, Repro, Introduced by, Risk, Acceptance criteria, Scope, Test cases and Dependencies'}; Context says it was found while working on #${issue.number}. Then comment on the new issue: suggest a priority (one of ${priorityList.join(', ')}) and a risk (${labels.riskLow} or ${labels.riskHigh}, judged against risk.highWhen and risk.highPaths; unsure means high), each with a one-line reason, and say that a human sets the labels and "${labels.ready}". Do not set those labels yourself. List every such issue in the PR body's "Out of scope" section as "- <item>: #<number>", and return them in followUps (existing=true for one that was already open). Items that are only remarks stay in the section as text.
3. Label the new PR (a PR is an issue: use issue_write with the PR number; read its labels first, keep existing ones): ${prLabels.map((l) => '"' + l + '"').join(', ')}.
4. On issue #${issue.number} add the label "${labels.review}" and remove "${labels.inProgress}" (keep other labels).${risk.escalation ? ` Also add "${labels.riskHigh}" to the issue and remove "${labels.riskLow}" (the change was escalated to high).` : ''}
5. ${isolated ? 'Stay on the branch (this checkout is a dedicated worktree; do not switch branches).' : `\`git switch ${startBranch}\`.`}
Return the PR number and URL. If any step fails, return ok=false with the problem.`
}

function blockedPrompt(issue, branch, stage, reason, questions, assignedByRun) {
  const qs = questions || []
  const questionsStep = qs.length
    ? `3. Post the questions as one comment on issue #${issue.number}; if a comment starting with \`<!-- devflow-questions -->\` already exists, edit it instead. The body is exactly:
<!-- devflow-questions -->
**Open questions for #${issue.number}** (blocked at ${stage}${branch ? `, branch \`${branch}\`` : ''})

${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Answer with /devflow:answer #${issue.number}, or reply on this issue with numbered answers.
(No at-sign mentions of bots.)`
    : `3. Comment on issue #${issue.number}: the stage ("${stage}"), the reason, and the concrete question or decision a human must provide to unblock it${branch ? `, and the branch name ${branch}` : ''}. No at-sign mentions of bots.`
  return `Issue #${issue.number} is blocked at stage "${stage}". Clean up. ${MCP_NOTE}

devflow config:
${cfgJson}

Reason / question: ${reason}
Branch: ${branch || '(none created)'}

Steps, in order:
1. Do not make any more code changes or commits. If uncommitted changes exist, leave them; do not discard anything.
2. ${branch ? `If \`git log ${parentRefFor(issue)}..${branch} --oneline\` shows commits, push the branch so work is not lost: \`git push -u ${remote} ${branch}\` (never force, never push to ${base}).` : 'No branch to push.'}
${questionsStep}
4. On the issue add the label "${labels.blocked}" and remove "${labels.inProgress}" (keep other labels). Delete the comment(s) whose body contains "<!-- devflow-claim id=${claimId} -->" (this run's claim; a later run claims again).${assignedByRun === true ? ' Also remove the authenticated user from the assignees of the issue (this run added them); do not remove any other assignee.' : ''}
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
  const fix = await agent(fixPrompt(issue, branch, why, details, state.qaFiles), {
    label: `fix #${issue.number}`,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
    model: 'sonnet',
  })
  if (!fix) return { ok: false, reason: `The fix agent died (${why}).` }
  if (fix.status === 'blocked') return { ok: false, reason: fix.blockedReason || `The fix agent reported blocked (${why}).` }
  merge(state, fix)
  const touched = overlap(fix.filesChanged, state.qaFiles)
  if (touched.length) return { ok: false, qaOverlap: true, reason: `The fix changed QA test files ${touched.join(', ')}; QA tests are only changed by a human decision.` }
  return { ok: true, result: fix }
}

// The implement summary stays the PR's "what"; fix summaries are kept separately.
function merge(state, result) {
  if (!state.summary) state.summary = result.summary
  else if (result.summary) state.fixes.push(result.summary)
  state.commits = state.commits.concat(result.commits)
  state.filesChanged = Array.from(new Set(state.filesChanged.concat(result.filesChanged)))
  state.assumptions = state.assumptions.concat(result.assumptions)
  const done = new Set((Array.isArray(result.outOfScopeDone) ? result.outOfScopeDone : []).map((x) => String(x).trim()))
  state.outOfScope = state.outOfScope.concat(result.outOfScope || []).filter((x) => !done.has(String(x).trim()))
  state.touchesUi = state.touchesUi || result.touchesUi
  if (result.rootCause && result.rootCause.cause) state.rootCause = result.rootCause
  // A later check of the same row (after a fix) replaces the earlier one.
  for (const m of Array.isArray(result.manualChecks) ? result.manualChecks : []) {
    state.manualChecks = state.manualChecks.filter((x) => x.rowId !== m.rowId).concat([m])
  }
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
    qaFiles: [],
    manualChecks: [],
    weakened: [],
    scanProblem: '',
    verifyProblem: '',
    rootCause: null,
  }
  let branch = ''
  // True when the Claim stage added the authenticated user as assignee; only then do cleanups remove them.
  let assignedByRun = false
  // Facts the final report states as they happened (the skill prints them, nothing is inferred later).
  const notes = []
  // The main loop reads these after a throw: the notes so far, whether the claim was won, whether cleanup started.
  issue.notes = notes
  issue.claimWon = false
  issue.inCleanup = false
  const done = (r) => Object.assign(r, { notes })

  async function block(stage, reason, questions) {
    // GitHub cannot be reached: no cleanup comment or label is possible; the run stops (see Main).
    if (mcpDown(reason)) {
      log(`#${issue.number} stopped at ${stage}: ${reason.split('\n')[0]}`)
      notes.push(`stopped at ${stage}: GitHub could not be reached; the issue keeps its in-progress label and claim, clean them up with /devflow:doctor`)
      return done({ issue: issue.number, status: 'blocked', reason: `${stage}: ${reason.split('\n')[0]}`, mcpDown: true })
    }
    // A reason that is itself a tagged question (e.g. from a fix round) goes into the questions comment too.
    if (!questions && /^\[(BA|QA|Dev)\] /.test(reason)) questions = [reason]
    log(`#${issue.number} blocked at ${stage}: ${reason.split('\n')[0]}`)
    issue.inCleanup = true
    await agent(blockedPrompt(issue, branch, stage, reason, questions, assignedByRun), {
      label: `blocked #${issue.number}`,
      phase: stage,
      schema: BLOCKED_SCHEMA,
      model: 'haiku',
    })
    issue.inCleanup = false
    return done({ issue: issue.number, status: 'blocked', reason: `${stage}: ${reason.split('\n')[0]}` })
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
  if (claim.problem && mcpDown(claim.problem)) return block('Claim', claim.problem)
  if (claim.taken) {
    const by = claim.takenBy || 'assignee or label'
    log(`Skipped #${issue.number}: already claimed (${by}).`)
    issue.claimSkip = true // a Claim skip is not worked on: it does not count toward the limit
    return done({ issue: issue.number, status: 'skipped', reason: `already claimed (${by})` })
  }
  assignedByRun = claim.assignedByRun === true
  const claims = Array.isArray(claim.claims) ? claim.claims : []
  if (!claims.some((c) => c.claimId === claimId)) {
    return block('Claim', `Our claim comment (${claimId}) was not found on the issue after posting it.`)
  }
  const winner = pickClaimWinner(claims)
  if (winner.claimId !== claimId) {
    const ours = claims.find((c) => c.claimId === claimId)
    const removeAssignee = assignedByRun && !!ours.author && !!winner.author && winner.author !== ours.author
    await agent(releasePrompt(issue, removeAssignee), {
      label: `release #${issue.number}`,
      phase: 'Implement',
      schema: RELEASE_SCHEMA,
      model: 'haiku',
    })
    log(`Skipped #${issue.number}: claimed by ${winner.claimId}.`)
    issue.claimSkip = true
    return done({ issue: issue.number, status: 'skipped', reason: `claimed by ${winner.claimId}` })
  }

  issue.claimWon = true
  try {
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
    // The parent PR merged (and its branch was deleted) before this issue started: its changes are in the base.
    if (made.parentMerged && parentsOf(issue).length === 1) {
      log(`#${issue.number}: parent PR #${parentsOf(issue)[0].prNumber} is already merged; starting from ${base}, not stacked.`)
      notes.push(`parent PR #${parentsOf(issue)[0].prNumber} was already merged before this issue started; branched from ${base}, not stacked`)
      issue.parents = []
    }
    if (made.resumed) {
      resumed[issue.number] = Array.isArray(made.commits) ? made.commits : []
      log(`#${issue.number}: resuming ${branch} with ${resumed[issue.number].length} earlier commit(s).`)
      notes.push(`resumed branch ${branch} from an earlier blocked run (${resumed[issue.number].length} commit(s) kept)`)
    }

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
      const qs = plan.questions || []
      return block('Plan', qs.join('; ') || 'The plan agent reported blocked without questions.', qs)
    }
    if (specPathForPlan && !readSpec(plan, specPathForPlan)) return block('Plan', `Plan did not read the spec ${specPathForPlan}`)

    const own = { qaFiles: plan.qaFiles || [], devFiles: plan.devFiles || [] }
    const shared = overlap(own.qaFiles, own.devFiles)
    if (shared.length) return block('Plan', `Ownership overlap: ${shared.join(', ')} is planned for both the QA and the dev agent.`)

    // Implement: QA tests and the change in parallel when the plan gives QA its own files, else one agent, test first.
    let impl
    // A resumed branch continues with one agent: the QA tests may already be committed there.
    if (nt.parallelQa === true && own.qaFiles.length && !made.resumed) {
      state.qaFiles = own.qaFiles
      log(`#${issue.number}: QA writes ${own.qaFiles.join(', ')} while dev writes the change.`)
      // Each half catches its own error so both settle before the cleanup runs; the first error is rethrown.
    const caught = []
    const settle = (fn) => async () => {
      try {
        return await fn()
      } catch (e) {
        caught.push(e)
        return null
      }
    }
    const [qa, dev] = await parallel([
      settle(() => agent(qaPrompt(issue, branch, plan.plan, own), { label: `qa #${issue.number}`, phase: 'Implement', schema: QA_SCHEMA, model: 'sonnet' })),
      settle(() => agent(implementPrompt(issue, branch, plan.plan, own), { label: `implement #${issue.number}`, phase: 'Implement', schema: IMPLEMENT_SCHEMA, model: 'sonnet' })),
    ])
    if (caught.length) throw caught[0]
    if (!qa) return block('Implement', 'The QA agent died.')
      if (!dev) return block('Implement', 'The implement agent died.')
      // Every open question, from both roles, goes into one comment and one block.
      const questions = (qa.questions || []).slice()
      if (dev.status === 'blocked') questions.push(`[Dev] ${dev.blockedReason || 'The implement agent reported blocked without a reason.'}`)
      if (qa.status === 'blocked' && !(qa.questions || []).length) questions.push('[QA] The QA agent reported blocked without a question.')
      if (questions.length) return block('Implement', questions.join('; '), questions)
      const qaOut = outside(qa.filesChanged, own.qaFiles)
      if (qaOut.length) return block('Implement', `The QA agent changed files outside its own: ${qaOut.join(', ')}.`)
      const devIn = overlap(dev.filesChanged, own.qaFiles)
      if (devIn.length) return block('Implement', `The dev agent changed QA test files: ${devIn.join(', ')}.`)
      if (specPathForPlan && !readSpec(qa, specPathForPlan)) return block('Implement', `The QA agent did not read the spec ${specPathForPlan}`)

      const committed = await agent(commitPrompt(issue, branch, own, qa, dev), {
        label: `commit #${issue.number}`,
        phase: 'Implement',
        schema: COMMIT_SCHEMA,
        model: 'haiku',
      })
      if (!committed || !committed.ok) return block('Implement', (committed && committed.problem) || 'The commit agent failed.')
      if (!committed.failedFirst) {
        log(`#${issue.number}: the QA tests did not fail without the change (${committed.failureNote || 'no note'}).`)
        dev.assumptions = (dev.assumptions || []).concat([`QA tests did not fail before the implementation: ${committed.failureNote || 'no note'}`])
        notes.push('the QA tests did not fail before the implementation (see the PR assumptions)')
      } else {
        notes.push('QA and dev ran in parallel; the test commit came first and failed without the change')
      }
      impl = Object.assign({}, dev, {
        commits: committed.commits,
        filesChanged: Array.from(new Set((qa.filesChanged || []).concat(dev.filesChanged || []))),
      })
      merge(state, impl)
    } else {
      impl = await agent(implementPrompt(issue, branch, plan.plan), {
        label: `implement #${issue.number}`,
        phase: 'Implement',
        schema: IMPLEMENT_SCHEMA,
        model: 'sonnet',
      })
      if (!impl) return block('Implement', 'The implement agent died.')
      merge(state, impl)
      if (impl.status === 'blocked') {
        const reason = impl.blockedReason || 'The implement agent reported blocked without a reason.'
        return block('Implement', reason, [`[Dev] ${reason}`])
      }
    }

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

    // Fix issues need a root cause for the PR: one round to supply it, then ship with "unknown".
    if (isFixIssue(issue, cfg) && !state.rootCause) {
      const fix = await runFix(
        issue,
        branch,
        state,
        'the fix PR needs its root cause',
        'Find the root cause of the bug this issue fixes and return rootCause (cause, introducedBy, whyMissed). Use `git log -S`, `git blame` on the lines the fix changed and the issue text. Change code only if the cause shows the fix is incomplete.',
      )
      // Only a QA-file edit blocks; a root-cause round that died or was blocked ships with "unknown".
      if (!fix.ok && fix.qaOverlap) return block('Implement', fix.reason)
      if (!fix.ok) {
        log(`#${issue.number}: root cause round failed (${fix.reason.split('\n')[0]}); shipping with "unknown".`)
        notes.push(`root cause round failed (${fix.reason.split('\n')[0]}); the PR says "unknown"`)
      } else if (!state.rootCause) notes.push('root cause not found; the PR says "unknown"')
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
          const why = String(v.notes || '').split('\n')[0].trim() || 'no reason given'
          state.verifyProblem = `verification was required but could not run: ${why}`
          log(`#${issue.number}: verification could not run (${v.notes}); continuing without it.`)
          break
        }
        state.verifyProblem = ''
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

    // Review. Before each round a deterministic scan of the diff (bin/devflow-scan) looks for weakened checks.
    for (let round = 0; round <= nt.maxReviewRounds; round++) {
      phase('Review')
      const scan = pluginRoot
        ? await agent(scanPrompt(issue, branch), {
            label: `scan #${issue.number}${round ? ` (round ${round + 1})` : ''}`,
            phase: 'Review',
            schema: SCAN_SCHEMA,
            model: 'haiku',
          })
        : null
      let hits = []
      if (!pluginRoot) state.scanProblem = 'the weakened-checks scan could not run: no pluginRoot was passed to the engine'
      else if (!scan) state.scanProblem = 'the weakened-checks scan could not run (the scan agent died)'
      else if (!scan.scanned) state.scanProblem = `the weakened-checks scan could not run: ${scan.error || 'no reason given'}`
      else {
        state.scanProblem = ''
        hits = (Array.isArray(scan.hits) ? scan.hits : [])
          .filter((h) => h && h.file)
          .map((h) => ({ file: String(h.file), line: Number(h.line) || 0, kind: String(h.kind || ''), text: String(h.text || '') }))
      }
      if (hits.length) log(`#${issue.number}: weakened-checks scan: ${hits.map(hitLine).join('; ')}`)
      // The plugin's reviewer agent (agents/reviewer.md) when available; the default subagent otherwise.
      const reviewOpts = { label: `review #${issue.number} (round ${round + 1})`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'opus' }
      let review
      if (nt.reviewerAgent && !reviewerMissing) {
        try {
          review = await agent(reviewPrompt(issue, branch, state, round, hits), Object.assign({ agentType: nt.reviewerAgent }, reviewOpts))
        } catch (e) {
          reviewerMissing = `reviewer agent ${nt.reviewerAgent} unavailable (${e && e.message ? e.message : e}); reviewed with the default agent`
          log(`#${issue.number}: ${reviewerMissing}`)
          notes.push(reviewerMissing)
        }
      }
      if (review === undefined) review = await agent(reviewPrompt(issue, branch, state, round, hits), reviewOpts)
      if (!review) return block('Review', 'The review agent died.')
      // Every hit is critical unless the reviewer accepted it; an accepted hit makes the PR risk:high at Ship.
      const accepted = Array.isArray(review.acceptedWeakenings) ? review.acceptedWeakenings : []
      let injected = 0
      for (const h of hits) {
        if (acceptedHit(h, accepted)) continue
        if (review.findings.some((f) => f.severity === 'critical' && f.file === h.file && Number(f.line) === Number(h.line))) continue
        injected++
        review.findings.push({ severity: 'critical', file: h.file, line: h.line, problem: `Weakened check (${h.kind}): ${h.text || h.file}`, fix: 'Remove it and fix the cause instead; keep it only if the issue itself requires it.' })
      }
      state.weakened = hits.filter((h) => acceptedHit(h, accepted)).map((h) => Object.assign({}, h, { reason: (accepted.find((a) => a.file === h.file && Number(a.line) === Number(h.line)) || {}).reason || '' }))
      // Fail closed: only an exact 'suggestion' is non-blocking; any other severity (even 'Suggestion') blocks.
      const blocking = review.findings.filter((f) => f.severity !== 'suggestion')
      state.suggestions = review.findings.filter((f) => f.severity === 'suggestion')
      // The review exits on findings only; the verdict is informational. Injected scan hits are critical findings in `blocking`.
      if (blocking.length === 0) break
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
    // Weakened checks that remain after review (accepted as justified), or a scan that could not see the whole diff.
    // A verification that was required but could not run counts the same way.
    const weakReason = [
      (state.weakened || []).length
        ? `weakened checks kept after review: ${state.weakened.map(hitLine).join('; ')}`
        : state.scanProblem || '',
      state.verifyProblem || '',
    ]
      .filter(Boolean)
      .join('; ')
    if (weakReason) {
      if (risk.level !== 'high') {
        risk.level = 'high'
        risk.escalation = risk.escalation ? `${risk.escalation}; ${weakReason}` : weakReason
      } else {
        risk.reason = risk.reason ? `${risk.reason}; ${weakReason}` : weakReason
      }
      log(`#${issue.number}: risk high: ${weakReason}`)
      notes.push(`risk high: ${weakReason}`)
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
    if (ship.reused === true) notes.push(`reused open PR #${ship.prNumber}`)
    if (ship.unstacked) {
      log(`#${issue.number}: parent PR merged while this issue was built; PR #${ship.prNumber} targets ${base}, not stacked.`)
      notes.push(`parent PR #${parentsOf(issue)[0].prNumber} was merged while this issue was built; the PR targets ${base}, not stacked`)
    }
    const followUps = Array.isArray(ship.followUps) ? ship.followUps : []
    if (followUps.length) notes.push(`out-of-scope follow-ups (${labels.triage}): ${followUps.map((f) => '#' + f.number).join(', ')}`)
    const missingManual = state.manualChecks.filter((m) => m.result !== 'pass').map((m) => `${m.rowId} ${m.result}`)
    if (missingManual.length) notes.push(`manual checks not passing: ${missingManual.join(', ')}`)
    return done({
      issue: issue.number,
      status: 'pr',
      url: ship.url,
      prNumber: ship.prNumber,
      risk: risk.level === 'unknown' ? 'high' : risk.level,
      stackedOn: ship.unstacked ? [] : parentsOf(issue).map((p) => p.prNumber),
      branch,
    })
  } catch (e) {
    // A throw inside the cleanup itself goes to the main loop; a normal block is never cleaned up twice.
    if (issue.inCleanup) throw e
    return block('Error', String((e && e.message) || '').split('\n')[0].trim() || 'unknown')
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
// Deterministic on top of the Select prompt: needs-triage is never worked on; then dependencies, priority, number.
const queue = []
for (const i of selected.issues) {
  if ((i.labels || []).indexOf(labels.triage) !== -1) {
    log(`Skipped #${i.number}: ${labels.triage}`)
    report.push({ issue: i.number, status: 'skipped', reason: `${labels.triage}: a human sets it ready first` })
  } else queue.push(i)
}
if (!(chain && explicitIssues.length)) queue.splice(0, queue.length, ...orderIssues(queue, priorityList))
log(queue.length ? `Candidates: ${queue.map((i) => '#' + i.number).join(', ')}; working on at most ${limit}, sequentially${chain ? ' as a lane (each stacked on the previous one)' : ''}.` : 'No eligible issues.')

// Parents that shipped in this run: issue number -> {prNumber, branch}. Children stack on them.
const shipped = {}
const status = {}
let worked = 0
let previous = null // chain: the last issue worked on, {number, status}
let lastShipped = null // chain: the last issue of the lane that shipped; the next one stacks on it

let stopped = '' // set when GitHub cannot be reached: every remaining issue is skipped
for (const issue of queue) {
  if (stopped) {
    report.push({ issue: issue.number, status: 'skipped', reason: stopped, notes: [] })
    continue
  }
  if (worked >= limit) {
    log(`Skipped #${issue.number}: over limit (${limit})`)
    report.push({ issue: issue.number, status: 'skipped', reason: `over limit (${limit})` })
    continue
  }
  // Chain: an issue that did not ship does not stop the lane. The next one stacks on the last issue that
  // shipped, or starts from the base; only a real "Depends on" the failed issue skips it (resolved below).
  const laneNotes = []
  if (chain && previous && previous.status !== 'pr') {
    laneNotes.push(`the lane continued although #${previous.number} did not ship (${previous.status}); ${lastShipped ? `stacked on #${lastShipped}` : `started from ${base}`}`)
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
  let result
  try {
    result = await runIssue(issue)
  } catch (e) {
    // inCleanup or claimWon: the cleanup agent threw. Otherwise the claim or release agent threw and the claim may be partial.
    const msg = String((e && e.message) || e || '').split('\n')[0].trim() || 'unknown'
    const left = issue.inCleanup || issue.claimWon ? 'cleanup failed; run /devflow:doctor' : 'claim may be partial; run /devflow:doctor'
    result = { issue: issue.number, status: 'blocked', reason: `Workflow error: ${msg}`, notes: (issue.notes || []).concat([left]) }
  }
  // Only an issue that was actually worked on counts toward the limit; Claim skips (taken, lost race) do not.
  if (!issue.claimSkip) worked++
  result.notes = laneNotes.concat(result.notes || [])
  if (result.mcpDown) stopped = `${MCP_DOWN}: the run stopped at #${issue.number}`
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
log(report.map((r) => `#${r.issue}: ${r.status}${r.url ? ' ' + r.url : ''}${r.risk ? ' risk:' + r.risk : ''}${r.stackedOn && r.stackedOn.length ? ' stacked on ' + r.stackedOn.map((n) => '#' + n).join(', ') : ''}${r.reason ? ' (' + r.reason + ')' : ''}${r.notes && r.notes.length ? ' [' + r.notes.join('; ') + ']' : ''}`).join('\n'))
return report
