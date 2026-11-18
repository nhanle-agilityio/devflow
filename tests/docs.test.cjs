'use strict';
// Keyword checks over DESIGN.md, README.md and CHANGELOG.md. Append-only: each task adds its own cases.
// A task's changelog entry is found by its issue number "(#NN)" anywhere in CHANGELOG.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const changelogEntry = (n) => read('CHANGELOG.md').split('\n').filter((l) => l.includes(`(#${n})`)).join('\n');
const KEY = /assignedByRun|authenticated user/;

// T1.10
test('test_t1_10_docs_describe_the_claim_assignee_rule', () => {
  const design = read('DESIGN.md');
  const claimLines = design.split('\n').filter((l) => /\bClaim\b/.test(l));
  assert.ok(claimLines.some((l) => KEY.test(l)), 'a DESIGN.md Claim line mentions the rule');
  assert.match(design, /assignedByRun/);
  const cleanup = design.split('\n').filter((l) => /cleanup/i.test(l));
  assert.ok(cleanup.some((l) => KEY.test(l)), 'a DESIGN.md blocked cleanup line mentions the rule');
  const entry = changelogEntry(28);
  assert.ok(entry, 'CHANGELOG has an entry citing (#28)');
  assert.match(entry, KEY);
  const readme = read('README.md');
  if (/claims/i.test(readme)) assert.match(readme, KEY);
});

// T2.14
test('test_t2_14_docs_describe_throw_cleanup_and_doctor_assignee', () => {
  const design = read('DESIGN.md');
  assert.match(design, /cleanup failed; run \/devflow:doctor/);
  assert.match(design, /Error:/);
  const doctor = design.split('\n').filter((l) => /doctor/i.test(l) && /assignee/i.test(l));
  assert.ok(doctor.some((l) => /authenticated user|own assignee/i.test(l)), 'DESIGN.md doctor line limits assignee removal');
  const entry = changelogEntry(29);
  assert.ok(entry, 'CHANGELOG has an entry citing (#29)');
  assert.match(entry, /Error:|thrown|throws?/i);
  assert.match(entry, /cleanup failed; run \/devflow:doctor/);
  assert.match(entry, /assignee/i);
});

// T7.11
test('test_t7_11_docs_describe_worked_limit_and_findings_only_review', () => {
  const design = read('DESIGN.md');
  const entry = changelogEntry(34);
  assert.ok(entry, 'CHANGELOG has an entry citing (#34)');
  const skipRe = /claim[\s\S]{0,120}(do(es)? not|not) count[\s\S]{0,80}limit|limit[\s\S]{0,120}(not count|only (counts )?worked)/i;
  const findingsRe = /(exit(s)?|ends?|leaves?)[\s\S]{0,80}(on )?findings only|findings only|verdict[\s\S]{0,80}(no longer|not)/i;
  for (const [name, text] of [['DESIGN.md', design], ['CHANGELOG entry', entry]]) {
    assert.match(text, skipRe, `${name} says Claim skips do not count toward the limit`);
    assert.match(text, findingsRe, `${name} says the review exits on findings only`);
  }
});

// T8.7
test('test_t8_7_docs_describe_reusing_an_open_pr', () => {
  const design = read('DESIGN.md');
  const shipLines = design.split('\n').filter((l) => /\bShip\b/.test(l) && /open PR/i.test(l) && /(reus|branch)/i.test(l));
  assert.ok(shipLines.length, 'a DESIGN.md Ship line mentions reusing an open PR for the branch');
  const entry = changelogEntry(35);
  assert.ok(entry, 'CHANGELOG has an entry citing (#35)');
  assert.match(entry, /reus/i);
  assert.match(entry, /open PR/i);
});

// T4.12
test('test_t4_12_docs_describe_the_update_slot', () => {
  const WAIT = 'deferred: waits for its turn';
  const design = read('DESIGN.md');
  const section = design.split(/^## /m).find((s) => /^Risk and the merge gate/i.test(s));
  assert.ok(section, 'DESIGN.md has a "Risk and the merge gate" section');
  assert.ok(section.includes(WAIT), 'DESIGN.md section has the deferred reason');
  assert.match(section, /in[- ]flight/i);
  assert.match(section, /window/i);
  assert.match(section, /(stuck|never resolves|does not resolve|not resolve)[\s\S]{0,80}pending|pending[\s\S]{0,120}(stuck|never resolves|does not resolve|not resolve)/i);
  assert.match(section, /re-?run|replace/i);
  const readme = read('README.md');
  if (/merge gate/i.test(readme)) assert.ok(readme.includes(WAIT), 'README lists the deferred reason');
  const entry = changelogEntry(31);
  assert.ok(entry, 'CHANGELOG has an entry citing (#31)');
  assert.ok(entry.includes(WAIT), 'CHANGELOG entry has the deferred reason');
});

// T5.12
test('test_t5_12_docs_describe_the_collaborator_thread_rule', () => {
  const RULE = /collaborator/i;
  const design = read('DESIGN.md');
  const section = design.split(/^## /m).find((s) => /^Risk and the merge gate/i.test(s));
  assert.ok(section, 'DESIGN.md has a "Risk and the merge gate" section');
  assert.match(section, RULE);
  assert.match(section, /resolved/i);
  assert.match(section, /CONTRIBUTOR/);
  const readme = read('README.md');
  if (/merge gate/i.test(readme)) assert.match(readme, RULE);
  const entry = changelogEntry(32);
  assert.ok(entry, 'CHANGELOG has an entry citing (#32)');
  assert.match(entry, RULE);
  assert.match(entry, /resolved|unresolved/i);
});

// T3.8
test('test_t3_8_docs_describe_the_trust_rule', () => {
  const trust = /OWNER\W+MEMBER\W+(or\s+)?COLLABORATOR/;
  const design = read('DESIGN.md');
  const sec = (re) => {
    const i = design.search(re);
    assert.ok(i >= 0, `DESIGN.md has ${re}`);
    const rest = design.slice(i + 1);
    const e = rest.search(/^## /m);
    return e < 0 ? design.slice(i) : design.slice(i, i + 1 + e);
  };
  for (const re of [/^## `\/devflow:sync/m, /^## `\/devflow:answer/m]) {
    const s = sec(re);
    assert.match(s, trust);
    assert.match(s, /ignored: not a collaborator/);
  }
  const readme = read('README.md');
  const rline = (re) => {
    const l = readme.split('\n').find((x) => re.test(x));
    assert.ok(l, `README.md has a line for ${re}`);
    return l;
  };
  for (const re of [/^- `\/devflow:sync/, /^- `\/devflow:answer/]) {
    const l = rline(re);
    assert.match(l, trust);
    assert.match(l, /ignored: not a collaborator/);
  }
  assert.match(readme, trust);
  assert.match(readme, /ignored: not a collaborator/);
  const entry = changelogEntry(30);
  assert.ok(entry, 'CHANGELOG has an entry citing (#30)');
  assert.match(entry, trust);
  assert.match(entry, /ignored: not a collaborator/);
});

// T9.7
test('test_t9_7_docs_describe_the_github_mcp_probe_and_prefix_warning', () => {
  const PROBE = /probe/i;
  const WARN = /prefix/i;
  const design = read('DESIGN.md');
  const sec = (re) => design.split(/^## /m).find((s) => re.test(s.split('\n')[0]));
  const init = sec(/devflow:init/);
  const doctor = sec(/devflow:doctor/);
  assert.ok(init && doctor, 'DESIGN.md has init and doctor sections');
  assert.match(init, PROBE);
  assert.match(init, /GitHub MCP/);
  assert.match(doctor, /prefix/i);
  assert.match(doctor, /warn/i);
  const readme = read('README.md');
  if (/allow list|allow-list/i.test(readme)) {
    assert.match(readme, PROBE);
    assert.match(readme, WARN);
  }
  const entry = changelogEntry(36);
  assert.ok(entry, 'CHANGELOG has an entry citing (#36)');
  assert.match(entry, PROBE);
  assert.match(entry, /prefix/i);
  assert.match(entry, /warn/i);
});

// T6.13
test('test_t6_13_docs_describe_stages_reading_the_issue_from_github', () => {
  const readFrom = /read[^.\n]*issue[^.\n]*from GitHub/i;
  const parsing = /Select[^.\n]*(copy|body)[^.\n]*(only|pars)|pars[^.\n]*Select[^.\n]*(copy|body)/i;
  const design = read('DESIGN.md');
  assert.match(design, readFrom);
  assert.match(design, parsing);
  assert.match(read('README.md'), /Bash\(gh issue view:\*\)/);
  const entry = changelogEntry(33);
  assert.ok(entry, 'CHANGELOG has an entry citing (#33)');
  assert.match(entry, readFrom);
  assert.match(entry, parsing);
});

// T1.12 (wave2-lighter-flow, issue #52)
test('test_t1_12_docs_describe_review_flag', () => {
  for (const f of ['README.md', 'DESIGN.md', 'docs/devflow-flows.html', 'CHANGELOG.md']) {
    assert.match(read(f), /review\.github/, `${f} mentions review.github`);
  }
  const design = read('DESIGN.md');
  assert.ok(
    design.split('\n').some((l) => /review\.github/.test(l) && /devflow:reviewer/.test(l)) ||
      /review\.github[\s\S]{0,1500}devflow:reviewer|devflow:reviewer[\s\S]{0,1500}review\.github/.test(design),
    'DESIGN.md states the trade-off with devflow:reviewer',
  );
  const log = read('CHANGELOG.md');
  assert.ok(log.includes('## [Unreleased]'), 'CHANGELOG has [Unreleased]');
  // The entry sits under [Unreleased] until the release moves it into its version section.
  const entry = log.split('\n').find((l) => /^- /.test(l) && /\(#52\)/.test(l));
  assert.ok(entry, 'CHANGELOG has an entry citing (#52)');
  assert.match(entry, /review\.github/);
});

// T2.10 (wave2-lighter-flow, issue #53): the gate callers keep their triggers
test('test_t2_10_gate_triggers_kept', () => {
  const callers = [
    ['.github/workflows/devflow-merge-gate-caller.yml', ['test']],
    ['skills/init/templates/github/workflows/devflow-merge-gate.yml', ['CI']],
  ];
  for (const [f, ci] of callers) {
    const text = read(f);
    const on = text.slice(text.search(/^on:/m)).split(/^jobs:/m)[0];
    const wr = on.match(/workflow_run:[\s\S]*?workflows:\s*\[([^\]]*)\]/);
    assert.ok(wr, `${f} has workflow_run.workflows`);
    const names = wr[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, ''));
    for (const n of [...ci, 'Claude Code Review']) assert.ok(names.includes(n), `${f} lists ${n}`);
    assert.match(on, /^ {2}status:/m, `${f} keeps status`);
    assert.match(on, /^ {2}workflow_dispatch:/m, `${f} keeps workflow_dispatch`);
  }
});

// T2.11
test('test_t2_11_docs_describe_effective_list', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.match(text, /effective/i, `${f} mentions the effective list`);
    assert.match(text, /refusing to merge/, `${f} mentions refusing to merge`);
  }
  assert.ok(changelogEntry(53), 'CHANGELOG has an entry citing (#53)');
});

// T3.5 (#54)
test('test_t3_5_docs_describe_init_prompt', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.match(text, /review\.github/, `${f} mentions review.github`);
    assert.match(text, /--upgrade/, `${f} mentions --upgrade`);
  }
  const entry = changelogEntry(54);
  assert.ok(entry, 'CHANGELOG has an entry citing (#54)');
  assert.match(entry, /review\.github/);
  assert.match(entry, /--upgrade/);
});

// T12.7
test('test_t12_7_docs_describe_cleanup', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.match(text, /--fix/, `${f} mentions --fix`);
    assert.match(text, /merged/, `${f} mentions merged`);
  }
  assert.ok(changelogEntry(63), 'CHANGELOG has an entry citing (#63)');
});

// T4.11
test('test_t4_11_docs_describe_short_path', () => {
  for (const f of ['README.md', 'DESIGN.md']) {
    const text = read(f);
    assert.match(text, /short path/i, `${f} mentions the short path`);
    assert.match(text, /risk:low/, `${f} mentions risk:low`);
  }
  const flows = read('docs/devflow-flows.html');
  assert.match(flows, /short path/i, 'flows page (EN) mentions the short path');
  assert.match(flows, /đường ngắn/i, 'flows page (VI) mentions the short path');
  assert.match(flows, /risk:low/);
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /risk:low/);
  const entry = changelogEntry(55);
  assert.ok(entry, 'CHANGELOG has an entry citing (#55)');
  assert.match(entry, /short path/i);
});

// T5.8
test('test_t5_8_docs_describe_markers', () => {
  for (const f of ['DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.match(text, /## Review/, `${f} mentions the ## Review section`);
    assert.match(text, /devflow-run/, `${f} mentions devflow-run`);
    assert.match(text, /devflow-blocked/, `${f} mentions devflow-blocked`);
  }
  assert.ok(changelogEntry(56), 'CHANGELOG has an entry citing (#56)');
});

// T6.10
test('test_t6_10_docs_describe_source_rule', () => {
  for (const f of ['DESIGN.md', 'README.md', 'CHANGELOG.md']) {
    assert.match(read(f), /Epic: #/, `${f} mentions the Epic: line`);
  }
  assert.ok(changelogEntry(57), 'CHANGELOG has an entry citing (#57)');
});

// T7.8
test('test_t7_8_docs_describe_both_modes', () => {
  for (const f of ['README.md', 'DESIGN.md', 'docs/devflow-flows.html', 'CHANGELOG.md']) {
    const text = read(f);
    assert.match(text, /epic/i, `${f} mentions epic`);
    assert.ok(text.includes('--file'), `${f} mentions --file`);
  }
  assert.ok(changelogEntry(58), 'CHANGELOG has an entry citing (#58)');
});

// T8.4
test('test_t8_4_docs_describe_spec_review', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.match(text, /spec review/i, `${f} mentions spec review`);
    assert.ok(text.includes('QA'), `${f} mentions QA`);
  }
  assert.ok(changelogEntry(59), 'CHANGELOG has an entry citing (#59)');
});

// T9.5
test('test_t9_5_docs_describe_answer_rule', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.ok(text.includes('/devflow:answer'), `${f} mentions /devflow:answer`);
    assert.ok(text.includes('## Decisions'), `${f} mentions ## Decisions`);
  }
  assert.ok(changelogEntry(60), 'CHANGELOG has an entry citing (#60)');
});

// T10.5
test('test_t10_5_docs_describe_accept_epic', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    assert.ok(read(f).includes('/devflow:accept #'), `${f} describes /devflow:accept #<n>`);
  }
  assert.ok(changelogEntry(61), 'CHANGELOG has an entry citing (#61)');
});

// T11.7
test('test_t11_7_docs_describe_metrics', () => {
  for (const f of ['README.md', 'DESIGN.md', 'CHANGELOG.md']) {
    const text = read(f);
    assert.ok(text.includes('/devflow:report #'), `${f} describes /devflow:report #<n>`);
    assert.ok(text.includes('metrics'), `${f} mentions metrics`);
  }
  assert.ok(changelogEntry(62), 'CHANGELOG has an entry citing (#62)');
});

// #86: docs/devflow-flows.html shows epic mode, the spec review step and the epic source rule.
// Source-text assertions only (no DOM): the page keeps one entry per spec-flow node, each starting `id: '<mode>-<step>'`.
const flows = () => read('docs/devflow-flows.html');
const STR = "((?:[^'\\\\]|\\\\.)*)";
const tPair = (key, text) => {
  const m = new RegExp(`\\b${key}: t\\('${STR}', '${STR}'\\)`).exec(text);
  return m && { vi: m[1], en: m[2] };
};
const specEntries = (mode) => {
  const src = flows();
  const start = src.indexOf(`const SPEC_${mode.toUpperCase()} = () => [`);
  assert.ok(start >= 0, `page defines SPEC_${mode.toUpperCase()}`);
  const end = src.indexOf('\n  ];', start);
  return src.slice(start, end).split(`id: '${mode}-`).slice(1).map((chunk) => {
    const id = chunk.slice(0, chunk.indexOf("'"));
    return { id, text: chunk, l: tPair('l', chunk), d: tPair('d', chunk) };
  });
};
const EPIC_LABELS = ['Analyse', 'Grill', 'Tasks', 'QA', 'Spec review', 'Size check', 'Create', 'Human sets ready'];
const FILE_LABELS = ['Analyse', 'Grill', 'Spec + tasks', 'QA', 'Spec review', 'Spec PR', 'Gate 1', 'Issues'];
const cardsOf = (entry) => {
  const i = entry.text.indexOf('cards: [');
  assert.ok(i >= 0, `${entry.id} has cards`);
  return [...entry.text.slice(i).matchAll(/n: (\d+), [^\n]*?l: \[([^\]]*)\]/g)].map((m) => ({ n: Number(m[1]), labels: m[2] }));
};

test('T1.1 epic mode has eight nodes in order and the size check names 65,000 and --file', () => {
  const e = specEntries('epic');
  assert.deepEqual(e.map((x) => x.l && x.l.en), EPIC_LABELS);
  const size = e.find((x) => x.id === 'size');
  for (const lang of ['vi', 'en']) {
    assert.ok(size.d[lang].includes('65,000'), `size check ${lang} has 65,000`);
    assert.ok(size.d[lang].includes('--file'), `size check ${lang} has --file`);
  }
  const create = e.find((x) => x.id === 'create').d.en;
  assert.match(create, /creates the epic and (the )?sub-issues/);
  assert.match(create, /links them/);
  assert.match(create, /Tasks table/);
});

test('T1.2 epic mode VI labels are non-empty', () => {
  const e = specEntries('epic');
  assert.equal(e.length, 8);
  for (const x of e) assert.ok(x.l && x.l.vi.trim(), `${x.id} has a VI label`);
});

test('T1.3 the default play button is epic mode and a separate --file button exists', () => {
  const src = flows();
  assert.match(src, /<button[^>]*id="spec-play"[^>]*>/);
  assert.match(src, /<button[^>]*id="spec-play-file"[^>]*>▶ --file<\/button>/);
  assert.match(src, /\$\('#spec-play'\)\.addEventListener\('click', \(\) => specPlay\('epic'\)\)/);
  assert.match(src, /\$\('#spec-play-file'\)\.addEventListener\('click', \(\) => specPlay\('file'\)\)/);
});

test('T1.4 --file mode has eight nodes in order, each with VI and EN', () => {
  const e = specEntries('file');
  assert.deepEqual(e.map((x) => x.l && x.l.en), FILE_LABELS);
  for (const x of e) assert.ok(x.l.vi.trim(), `${x.id} has a VI label`);
});

test('T1.5 the spec review step says what it is in both modes (EN)', () => {
  for (const mode of ['epic', 'file']) {
    const en = specEntries(mode).find((x) => x.id === 'review').d.en;
    for (const lit of ['spec.qaModel', 'missing requirement', 'contradiction', 'not independent', 'only critical', 'at most 2 reviewer calls', 'not a testability check']) {
      assert.ok(en.includes(lit), `${mode} review EN contains ${lit}`);
    }
  }
});

test('T1.6 testability only appears inside "not a testability check"', () => {
  for (const mode of ['epic', 'file']) {
    const en = specEntries(mode).find((x) => x.id === 'review').d.en;
    assert.equal(en.split('testability').length - 1, en.split('not a testability check').length - 1);
  }
});

test('T1.7 the spec review step VI text names spec.qaModel and 2', () => {
  for (const mode of ['epic', 'file']) {
    const vi = specEntries(mode).find((x) => x.id === 'review').d.vi;
    assert.ok(vi.includes('spec.qaModel'));
    assert.ok(vi.includes('2'));
  }
});

test('T1.8 the epic Create step shows the epic card and two sub-issues without agent:ready', () => {
  const cards = cardsOf(specEntries('epic').find((x) => x.id === 'create'));
  assert.deepEqual(cards.map((c) => c.n), [30, 31, 32]);
  assert.ok(cards[0].labels.includes('type:epic'));
  for (const c of cards) assert.ok(!c.labels.includes('agent:ready'), `#${c.n} has no agent:ready yet`);
});

test('T1.9 the Human sets ready step adds agent:ready to #31 and #32 only', () => {
  const cards = cardsOf(specEntries('epic').find((x) => x.id === 'ready'));
  const by = Object.fromEntries(cards.map((c) => [c.n, c.labels]));
  assert.ok(by[31].includes('agent:ready'));
  assert.ok(by[32].includes('agent:ready'));
  assert.ok(!by[30].includes('agent:ready'));
});

test('T1.10 the --file Issues step labels cards agent:ready and shows no epic card', () => {
  const cards = cardsOf(specEntries('file').find((x) => x.id === 'issues'));
  assert.ok(cards.length >= 2);
  for (const c of cards) {
    assert.ok(c.labels.includes('agent:ready'), `#${c.n} is ready`);
    assert.ok(!c.labels.includes('type:epic'), `#${c.n} is not an epic`);
  }
});

test('T1.11 the epic cards carry the task risk, type and dependency labels', () => {
  const cards = cardsOf(specEntries('epic').find((x) => x.id === 'create'));
  const by = Object.fromEntries(cards.map((c) => [c.n, c.labels]));
  assert.ok(by[31].includes('risk:low') && by[31].includes('type:feat'));
  assert.ok(by[32].includes('risk:high') && by[32].includes('type:feat') && by[32].includes('needs-e2e'));
  assert.match(specEntries('epic').find((x) => x.id === 'create').text, /dep: 'Depends on #31'/);
});

const ruleNote = () => {
  const src = flows();
  const i = src.indexOf('const SRC_NOTE = {');
  assert.ok(i >= 0, 'page defines SRC_NOTE');
  const block = src.slice(i, src.indexOf('};', i));
  const vi = /vi: '((?:[^'\\]|\\.)*)'/.exec(block);
  const en = /en: '((?:[^'\\]|\\.)*)'/.exec(block);
  return { vi: vi && vi[1], en: en && en[1] };
};

test('T1.12 the next-task source rule note exists in VI and EN', () => {
  const n = ruleNote();
  for (const lang of ['vi', 'en']) {
    assert.ok(n[lang], `${lang} note exists`);
    for (const lit of ['Epic: #<n>', '## Decisions', 'epic #<n> could not be read']) assert.ok(n[lang].includes(lit), `${lang} note has ${lit}`);
  }
});

test('T1.13 the EN note orders spec path, epic, issue alone and says the issue wins', () => {
  const en = ruleNote().en;
  const a = en.indexOf('spec path'), b = en.indexOf('Epic: #<n>'), c = en.indexOf('issue alone');
  assert.ok(a >= 0 && a < b && b < c, 'order: spec path, Epic: #<n>, issue alone');
  assert.ok(en.includes('Claim'));
  assert.match(en, /criteria, Test cases and ## Decisions[^.]*win over the epic/i);
});

test('T1.14 the Plan and Review node subtitles mention spec or epic in both languages', () => {
  const src = flows();
  for (const st of ['plan', 'review']) {
    const line = src.split('\n').find((l) => l.includes(`data-st="${st}"`));
    const vi = /<span class="s">([^<]*)<\/span>/.exec(line)[1];
    assert.ok(vi.includes('spec hoặc epic'), `${st} VI subtitle`);
    const en = new RegExp(`'${vi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}': '([^']*)'`).exec(src);
    assert.ok(en && en[1].includes('spec or epic'), `${st} EN subtitle`);
  }
});

test('T1.17 specPlay does not tie step indexes to one mode length', () => {
  const src = flows();
  const i = src.indexOf('function specPlay');
  const body = src.slice(i, src.indexOf('\n  }\n', i));
  for (const bad of ['i === 6', 'i === 5', 'sNodes[6]']) assert.ok(!body.includes(bad), `specPlay has no ${bad}`);
});
