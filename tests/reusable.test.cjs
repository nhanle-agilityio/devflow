'use strict';
// The reusable workflows in .github/workflows must stay in step with the copy-install templates, and the thin
// callers must point at them through the {{DEVFLOW_REF}} placeholder that /devflow:init fills with a tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const jobs = (text) => text.slice(text.indexOf('\njobs:'));

test('the reusable review has exactly the jobs of the copy template', () => {
  const reusable = read('.github/workflows/devflow-review.yml');
  assert.match(reusable, /\non:\n  workflow_call:/);
  assert.equal(jobs(reusable), jobs(read('skills/init/templates/github/workflows/claude-code-review.yml')));
});

test('the reusable gate runs the gate script that the copy template installs', () => {
  const reusable = read('.github/workflows/devflow-merge-gate.yml');
  assert.match(reusable, /\non:\n  workflow_call:/);
  const m = /require\('\.\/\.devflow-plugin\/(.+?)'\)/.exec(reusable);
  assert.ok(m, 'require path');
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), m[1]);
  assert.match(reusable, /sparse-checkout: skills\/init\/templates\/github\/scripts/);
  assert.match(reusable, /ref: \$\{\{ inputs\.devflow-ref \}\}/);
});

test('callers are pinned through the DEVFLOW_REF placeholder and keep the trigger names the gate needs', () => {
  const review = read('skills/init/templates/github/callers/claude-code-review.yml');
  const gate = read('skills/init/templates/github/callers/devflow-merge-gate.yml');
  assert.match(review, /^name: Claude Code Review$/m);
  assert.match(review, /uses: nhanle-agilityio\/devflow\/\.github\/workflows\/devflow-review\.yml@\{\{DEVFLOW_REF\}\}/);
  assert.match(review, /id-token: write/);
  assert.match(gate, /uses: nhanle-agilityio\/devflow\/\.github\/workflows\/devflow-merge-gate\.yml@\{\{DEVFLOW_REF\}\}/);
  assert.match(gate, /devflow-ref: "\{\{DEVFLOW_REF\}\}"/);
  assert.match(gate, /workflows: \["CI", "Claude Code Review"\]/);
  // secrets: inherit is only guaranteed inside one organization or enterprise; these repositories are user-owned.
  for (const t of [review, gate]) assert.doesNotMatch(t, /secrets: inherit/);
  assert.match(review, /secrets:\n      CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(gate, /secrets:\n      DEVFLOW_GATE_TOKEN: \$\{\{ secrets\.DEVFLOW_GATE_TOKEN \}\}\n      DEVFLOW_READ_TOKEN: \$\{\{ secrets\.DEVFLOW_READ_TOKEN \}\}/);
});

test('every secret a caller passes is declared by the reusable workflow it calls', () => {
  const pairs = [
    ['skills/init/templates/github/callers/claude-code-review.yml', '.github/workflows/devflow-review.yml'],
    ['skills/init/templates/github/callers/devflow-merge-gate.yml', '.github/workflows/devflow-merge-gate.yml'],
  ];
  for (const [caller, called] of pairs) {
    const passed = [...read(caller).matchAll(/^      ([A-Z_]+): \$\{\{ secrets\./gm)].map((m) => m[1]);
    const declared = read(called);
    assert.ok(passed.length, caller);
    for (const name of passed) assert.match(declared, new RegExp(`\\n      ${name}:\\n        required:`), `${name} in ${called}`);
  }
});

// --- T1: review.github flag (wave2-lighter-flow). The `flag` step is run from the YAML with mocked github/core/context. ---
const REVIEW_FILES = ['.github/workflows/devflow-review.yml', 'skills/init/templates/github/workflows/claude-code-review.yml'];
const FLAG_CLAUSE = "steps.flag.outputs.enabled == 'true'";
const stepsOf = (text) => {
  const body = text.slice(text.indexOf('\n    steps:\n') + '\n    steps:\n'.length);
  return body.split(/\n(?=      - name:)/).map((s) => s.replace(/\s+$/, ''));
};
const stepIf = (step) => {
  const m = /^        if: (.*)$/m.exec(step);
  return m ? m[1].trim() : null;
};
const flagScript = (text) => {
  const step = stepsOf(text).find((s) => /^        id: flag$/m.test(s));
  assert.ok(step, 'a step with id: flag');
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^ {10}script: \|\s*$/.test(l));
  assert.ok(at >= 0, 'the flag step has a script: | block');
  return lines.slice(at + 1).map((l) => l.slice(12)).join('\n');
};
const b64 = (obj) => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(obj)).toString('base64') } });
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

// copies: { default: obj|Error, <ref>: obj|Error }; any other ref is a 404.
async function runFlag(copies) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const script = flagScript(read('.github/workflows/devflow-review.yml'));
  const calls = [];
  const out = {};
  const warnings = [];
  let failed = 0;
  const summary = [];
  const getContent = async (params) => {
    calls.push(params);
    const key = params.ref === undefined || params.ref === 'main' ? 'default' : params.ref;
    const v = copies[key];
    if (v === undefined) throw notFound();
    if (v instanceof Error) throw v;
    return b64(v);
  };
  const sum = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'write') return async () => sum;
      return (...a) => { for (const x of a) if (typeof x === 'string') summary.push(x); return sum; };
    },
  });
  const github = {
    rest: { repos: { getContent } },
    request: async (route, params) => getContent(params),
  };
  const core = {
    setOutput: (k, v) => { out[k] = v; },
    warning: (m) => warnings.push(String(m)),
    setFailed: () => { failed++; },
    info: () => {},
    notice: () => {},
    summary: sum,
  };
  const context = {
    repo: { owner: 'acme', repo: 'shop' },
    payload: {
      repository: { default_branch: 'main' },
      pull_request: { number: 7, head: { sha: 'HEADSHA1234', ref: 'feature/head-branch' }, base: { ref: 'develop' } },
    },
  };
  await new AsyncFunction('github', 'context', 'core', 'Buffer', script)(github, context, core, Buffer);
  return { calls, out, warnings, failed, summary: summary.join('\n') };
}
const OFF_LINE = 'devflow review is off (review.github is not true)';

// T1.4
test('test_t1_4_flag_reads_base_branch_copy', async () => {
  const r = await runFlag({ default: { baseBranch: 'develop', review: { github: false } }, develop: { review: { github: true } } });
  assert.equal(r.out.enabled, 'true');
  assert.ok(r.calls.some((c) => c.ref === 'develop'), 'a read used ref develop');
  assert.ok(r.calls.every((c) => c.path === '.claude/devflow.json'));
});

// T1.5
test('test_t1_5_flag_never_reads_pr_head', async () => {
  const head = { baseBranch: 'develop', review: { github: true } };
  const r = await runFlag({
    default: { baseBranch: 'develop' },
    develop: { baseBranch: 'develop' },
    HEADSHA1234: head,
    'feature/head-branch': head,
    'refs/pull/7/head': head,
  });
  for (const c of r.calls) {
    assert.ok(!['HEADSHA1234', 'feature/head-branch', 'refs/pull/7/head'].includes(c.ref), `ref ${c.ref}`);
    assert.ok(!/HEADSHA1234|head-branch/.test(JSON.stringify(c)), JSON.stringify(c));
  }
  assert.notEqual(r.out.enabled, 'true');
});

// T1.6
test('test_t1_6_flag_only_boolean_true', async () => {
  for (const review of [{ github: 'true' }, { github: 1 }, undefined]) {
    const cfg = review === undefined ? { baseBranch: 'develop' } : { baseBranch: 'develop', review };
    const r = await runFlag({ default: cfg, develop: cfg });
    assert.notEqual(r.out.enabled, 'true', JSON.stringify(review));
    assert.ok(r.summary.includes(OFF_LINE), `summary for ${JSON.stringify(review)}: ${r.summary}`);
  }
});

// T1.7
test('test_t1_7_flag_read_error_off_with_warning', async () => {
  const boom = new Error('boom');
  const r = await runFlag({ default: boom, develop: boom });
  assert.notEqual(r.out.enabled, 'true');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.failed, 0);
});

// T1.8
test('test_t1_8_flag_falls_back_to_default_copy', async () => {
  const r = await runFlag({ default: { baseBranch: 'develop', review: { github: true } }, develop: notFound() });
  assert.equal(r.out.enabled, 'true');
  assert.equal(r.warnings.length, 0);
  assert.equal(r.failed, 0);
});

// T1.9
test('test_t1_9_every_step_gated_on_flag', () => {
  for (const f of REVIEW_FILES) {
    const steps = stepsOf(read(f));
    assert.ok(steps.length >= 5, f);
    assert.match(steps[0], /^      - name:/);
    assert.match(steps[0], /^        id: flag$/m, `${f}: flag is step 0`);
    assert.match(steps[0], /uses: actions\/github-script@/);
    for (const s of steps.slice(1)) {
      const cond = stepIf(s);
      assert.ok(cond && cond.includes(FLAG_CLAUSE), `${f}: ${s.split('\n')[0]} is gated on the flag (if: ${cond})`);
    }
    const publish = steps.find((s) => /Publish devflow\/review status/.test(s));
    assert.ok(publish && /always\(\)/.test(stepIf(publish)) && stepIf(publish).includes(FLAG_CLAUSE), `${f}: publish step`);
  }
});

// T1.10: the 2.9.0 conditions, by step name ('' = no condition).
const IF_2_9_0 = [
  ['Checkout repository', ''],
  ['Set devflow/review to pending', ''],
  ['Carry over the previous result when only the base was merged', ''],
  ['Review the PR', "steps.carry.outputs.skip != 'true'"],
  ['Publish devflow/review status', "always() && steps.carry.outputs.skip != 'true'"],
];
function stripFlag(cond) {
  let c = (cond || '').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  c = c.split(FLAG_CLAUSE).join(' ');
  for (let i = 0; i < 4; i++) c = c.replace(/&&\s*&&/g, '&&').replace(/^\s*&&/, '').replace(/&&\s*$/, '').trim();
  while (c.startsWith('(') && c.endsWith(')')) {
    let depth = 0;
    let closesEarly = false;
    for (let i = 0; i < c.length - 1; i++) {
      if (c[i] === '(') depth++;
      if (c[i] === ')') depth--;
      if (depth === 0) { closesEarly = true; break; }
    }
    if (closesEarly) break;
    c = c.slice(1, -1).trim();
  }
  return c.replace(/\s+/g, ' ').trim();
}
test('test_t1_10_conditions_unchanged_when_on', () => {
  for (const f of REVIEW_FILES) {
    const steps = stepsOf(read(f)).slice(1);
    assert.equal(steps.length, IF_2_9_0.length, `${f}: step count`);
    steps.forEach((s, i) => {
      const [name, old] = IF_2_9_0[i];
      assert.ok(s.startsWith(`      - name: ${name}`), `${f}: step ${i + 1} is "${name}"`);
      assert.equal(stripFlag(stepIf(s)), old, `${f}: ${name}`);
    });
  }
});

// T1.11
test('test_t1_11_jobs_identical_interface_unchanged', () => {
  const significant = (t) => t.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
  const reusable = read(REVIEW_FILES[0]);
  assert.equal(jobs(reusable), jobs(read(REVIEW_FILES[1])));
  const iface = reusable.slice(reusable.indexOf('\non:'), reusable.indexOf('\njobs:'));
  assert.equal(
    significant(iface),
    ['on:', '  workflow_call:', '    secrets:', '      CLAUDE_CODE_OAUTH_TOKEN:', '        required: true'].join('\n'),
  );
  for (const f of REVIEW_FILES) {
    const t = read(f);
    const perms = t.slice(t.indexOf('    permissions:\n'), t.indexOf('    steps:\n'));
    assert.equal(
      significant(perms),
      ['    permissions:', '      contents: read', '      pull-requests: write', '      issues: read', '      statuses: write', '      id-token: write'].join('\n'),
      f,
    );
    assert.match(t, /\n  review:\n    if: github\.event\.pull_request\.draft == false\n    runs-on: ubuntu-latest\n/);
  }
});
