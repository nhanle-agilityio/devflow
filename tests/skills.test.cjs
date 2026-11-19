'use strict';
// Keyword checks over skills/*/SKILL.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// T2.13
test('test_t2_13_doctor_fix_removes_only_own_assignee', () => {
  const line = read('skills/doctor/SKILL.md').split('\n').find((l) => /^6\. /.test(l));
  assert.ok(line, 'check 6 exists');
  const fix = line.slice(line.indexOf('--fix'));
  assert.match(fix, /assignee/i);
  assert.match(fix, /authenticated user/i);
  assert.match(fix, /only/i);
  assert.match(fix, /other assignees?[^.]*(kept|keep|left|untouched)|(keep|leave)[^.]*other assignees?/i);
});

// ---- T3: sync and answer act only on trusted authors' comments ----
const section = (text, startRe, endRe) => {
  const s = text.search(startRe);
  assert.ok(s >= 0, `section ${startRe} exists`);
  const rest = text.slice(s + 1);
  const e = endRe ? rest.search(endRe) : -1;
  return e < 0 ? text.slice(s) : text.slice(s, s + 1 + e);
};
const syncText = () => read('skills/sync/SKILL.md');
const syncStep = (n) => section(syncText(), new RegExp(`^## ${n}\\. `, 'm'), new RegExp(`^## ${n + 1}\\. `, 'm'));
const answerText = () => read('skills/answer/SKILL.md');
const answerStep = (n) => section(answerText(), new RegExp(`^## ${n}\\. `, 'm'), new RegExp(`^## ${n + 1}\\. `, 'm'));
const IGNORED = /ignored: not a collaborator/;

// T3.1
test('test_t3_1_sync_handles_only_trusted_thread_starters', () => {
  const s4 = syncStep(4);
  assert.match(s4, /authenticated user/i);
  assert.match(s4, /claude\[bot\]/);
  assert.match(s4, /list_repository_collaborators/);
  assert.match(s4, /untrusted/i);
  assert.match(s4, /first comment/i);
  assert.match(s4, /(not|never|no)[^.\n]*github-actions\[bot\]/i, 'step 4 names github-actions[bot] as not trusted');
});

// T3.2
test('test_t3_2_sync_untrusted_thread_listed_no_reply_or_commit', () => {
  const s4 = syncStep(4);
  assert.match(s4, IGNORED);
  assert.match(s4, /no reply/i);
  assert.match(s4, /no commit/i);
  assert.match(syncStep(6), IGNORED, 'final table lists ignored threads');
});

// T3.3
test('test_t3_3_sync_acts_only_on_trusted_comments_and_never_resolves_others_threads', () => {
  const s4 = syncStep(4);
  assert.match(s4, /repl(y|ies)[^.]*untrusted|untrusted[^.]*repl(y|ies)/i);
  assert.match(s4, /ignore/i);
  assert.match(s4, /never resolves? (a|any) (review )?thread (it|you|sync) did not start/i);
});

// T3.4
test('test_t3_4_sync_no_longer_says_author_reply_clears_human_threads', () => {
  const text = syncText();
  assert.doesNotMatch(text, /ignores threads whose last comment is by the PR author/i);
  const sentences = text.split(/(?<=[.!?])\s+|\n/);
  assert.ok(
    sentences.some((x) => /trusted human/i.test(x) && /block/i.test(x) && /resolve/i.test(x)),
    'a sentence says a trusted human thread blocks the gate until resolved',
  );
});

// T3.4 (review): the gate counts the PR author's reply as an answer on their own threads
test('test_t3_4_sync_reply_answers_threads_started_by_the_pr_author', () => {
  const AUTHOR = /thread started by the PR author[^.;]*answered/i;
  assert.match(syncStep(4), AUTHOR);
  const design = read('DESIGN.md').split('\n').find((l) => /^4\. \*\*Review\.\*\* Only trusted authors/.test(l));
  assert.ok(design, 'DESIGN.md has sync step 4');
  assert.match(design, AUTHOR);
});

// T3.5
test('test_t3_5_answer_takes_questions_and_answers_from_trusted_authors_only', () => {
  const s1 = answerStep(1);
  assert.match(s1, /authenticated user/i);
  assert.match(s1, /OWNER/);
  assert.match(s1, /MEMBER/);
  assert.match(s1, /COLLABORATOR/);
  assert.match(s1, /author_association/);
  const s2 = answerStep(2);
  assert.match(s2, /authenticated user/i);
  assert.match(s2, /OWNER, MEMBER(,| or) (or )?COLLABORATOR/);
  assert.match(s2, /never bots?|bots? (are|is) never/i);
});

// T3.6
test('test_t3_6_answer_lists_ignored_comments_and_latest_trusted_answer_wins', () => {
  const s2 = answerStep(2);
  assert.match(s2, /latest trusted answer/i);
  assert.match(s2, IGNORED);
  assert.match(answerStep(6), IGNORED, 'report lists ignored comments');
});

// T3.7
test('test_t3_7_answer_step_6_engine_resumes_branch_with_commits', () => {
  const s6 = answerStep(6);
  assert.doesNotMatch(s6, /must be handled by hand/i);
  assert.match(s6, /resumed by the engine/i);
  assert.match(s6, /commits/i);
});

// T3.9
test('test_t3_9_sync_ignores_other_bots_threads', () => {
  const s4 = syncStep(4);
  assert.match(s4, /Copilot/);
  assert.match(s4, /CodeRabbit/);
  assert.match(s4, /other bots?|bot other than/i);
  assert.match(s4, IGNORED);
});

// T3.10
test('test_t3_10_sync_skips_behind_update_only_where_the_gate_updates', () => {
  const s2 = syncStep(2);
  assert.match(s2, /mergeGate\.enabled/);
  assert.match(s2, /mergeGate\.dryRun/);
  assert.match(s2, /risk:low|labels\.riskLow/);
  assert.match(s2, /baseBranch/);
  assert.match(s2, /blocked/);
  assert.match(s2, /skip/i);
  assert.match(s2, /dry run/i);
  assert.match(s2, /risk:high|labels\.riskHigh/);
  assert.match(s2, /stacked/i);
  assert.match(s2, /update_pull_request_branch/);
});

// T3.11
test('test_t3_11_sync_ignores_a_summary_comment_from_anyone_else', () => {
  const s4 = syncStep(4);
  assert.match(s4, /summary comment/i);
  assert.match(s4, /<!-- devflow-verdict/);
  assert.match(s4, /author is `claude\[bot\]` or the authenticated user|`claude\[bot\]` or the authenticated user/);
  assert.match(s4, IGNORED);
});

// T3.12
test('test_t3_12_sync_recognises_review_bot_from_get_reviews', () => {
  const s4 = syncStep(4);
  assert.match(s4, /`claude`/);
  assert.match(s4, /get_reviews/);
  assert.match(s4, /only when/i);
  assert.match(s4, /human/i);
  assert.match(s4, /collaborator/i);
});

const initBg = () => {
  const p = read('skills/init/SKILL.md').split('\n').find((l) => /^Background sessions:/.test(l));
  assert.ok(p, 'init has a Background sessions paragraph');
  return p;
};
const doctorCheck3 = () => {
  const l = read('skills/doctor/SKILL.md').split('\n').find((x) => /^3\. /.test(x));
  assert.ok(l, 'doctor check 3 exists');
  return l;
};

// T9.1
test('test_t9_1_init_probes_each_github_mcp_server_before_the_allow_list', () => {
  const p = initBg();
  const probe = p.search(/probe/i);
  assert.ok(probe >= 0, 'says to probe');
  assert.match(p, /probe[^.]*(each|every)[^.]*GitHub MCP server/i);
  assert.match(p, /authenticated user/i);
  assert.match(p, /(tool )?prefix of the (one|server)[^.]*(answers|responds)|(one|server) (that )?answers[^.]*prefix|(use|using) its (tool )?prefix/i);
  assert.ok(probe < p.indexOf('devflow-setup'), 'the probe comes before the allow command');
});

// T9.2
test('test_t9_2_init_asks_which_server_when_several_answer', () => {
  assert.match(initBg(), /several[^.]*answer[^.]*ask the user which|ask the user which[^.]*several/i);
});

// T9.3
test('test_t9_3_init_stops_when_no_server_answers', () => {
  const p = initBg();
  assert.match(p, /(none|no server)[^.]*answers?[^.]*stop|stop[^.]*(none|no server)[^.]*answers?/i);
  assert.match(p, /connect a GitHub MCP server/i);
  assert.match(p, /auth(entication)? error[^.]*(not answering|does not answer|doesn't answer)/i);
});

// T9.4
test('test_t9_4_init_replaces_a_stale_github_mcp_prefix', () => {
  const p = initBg();
  assert.match(p, /other than the (chosen|selected)[^.]*replaced|replace[^.]*other than the (chosen|selected)/i);
  assert.match(p, /diff/i);
});

// T9.5
test('test_t9_5_doctor_check_3_reports_the_tool_prefix', () => {
  assert.match(doctorCheck3(), /report[^.]*(tool )?prefix|(tool )?prefix[^.]*(reported|report)/i);
  assert.match(doctorCheck3(), /server (it|check 3) used|used server|server it used/i);
});

// T9.6
test('test_t9_6_doctor_check_3_warns_on_an_allow_list_mismatch', () => {
  const l = doctorCheck3();
  assert.match(l, /settings\.json/);
  assert.match(l, /warn[^.]*(other|another|different)[^.]*prefix|(other|another|different)[^.]*prefix[^.]*warn/i);
  assert.match(l, /\bok\b[^.]*both|both[^.]*\bok\b/i);
  assert.match(l, /check 8/i);
});

// T9.6 (review): several authenticated servers give no false warn
test('test_t9_6_doctor_check_3_probes_each_server_and_warns_only_when_no_allowed_prefix_answers', () => {
  const l = doctorCheck3();
  assert.match(l, /probe[^.]*(each|every)[^.]*GitHub MCP server/i);
  assert.match(l, /warn[^.]*only when[^.]*no allowed (GitHub MCP )?prefix belongs to a server that answers/i);
});

// ---- T3 (wave2-lighter-flow, #54): init and doctor review flag, upgrade offer, empty-checks warning ----
const initText54 = () => read('skills/init/SKILL.md');
const doctorCheck1 = () => {
  const l = read('skills/doctor/SKILL.md').split('\n').find((x) => /^1\. /.test(x));
  assert.ok(l, 'doctor check 1 exists');
  return l;
};
const initChecksStep54 = () => {
  const l = initText54().split('\n').find((x) => /^\s*-\s+`mergeGate\.requiredChecks`/.test(x));
  assert.ok(l, 'init has a mergeGate.requiredChecks proposal step');
  return l;
};
const emptyWarnLines54 = (text) => text.split('\n').filter((l) => /mergeGate\.enabled/.test(l) && /effective/i.test(l) && /requiredChecks|required list/i.test(l));

// T3.1
test('test_t3_1_init_asks_review_github', () => {
  const text = initText54();
  assert.match(text, /review\.github/);
  assert.match(text, /`false`|\bfalse\b/);
  assert.match(text, /AskUserQuestion/);
  const step = initChecksStep54();
  assert.match(step, /devflow\/review/);
  assert.match(step, /review\.github/);
  assert.match(step, /only when[^.]*true|when[^.]*(true|yes)[^.]*only|if[^.]*true/i);
});

// T3.2
test('test_t3_2_empty_checks_warning_in_init_and_doctor', () => {
  const init = initText54();
  const doctor1 = doctorCheck1();
  for (const [name, text] of [['init', init], ['doctor check 1', doctor1]]) {
    assert.match(text, /mergeGate\.enabled/, `${name} mentions mergeGate.enabled`);
    assert.match(text, /requiredChecks/, `${name} mentions requiredChecks`);
    assert.match(text, /\.github\/workflows\//, `${name} mentions .github/workflows/`);
    assert.match(text, /name:/, `${name} mentions name:`);
  }
  assert.match(read('skills/doctor/SKILL.md'), /mergeGate\.enabled/);
});

// T3.3
test('test_t3_3_warning_regardless_of_flag', () => {
  for (const [name, text] of [['init', initText54()], ['doctor', read('skills/doctor/SKILL.md')]]) {
    const lines = emptyWarnLines54(text);
    assert.ok(lines.length > 0, `${name} has the empty effective list warning`);
    const rule = lines.join('\n');
    assert.match(rule, /effective/i);
    assert.match(rule, /refuse/i);
    assert.doesNotMatch(rule, /(only|just) (when|if)[^.]*review\.github[^.]*(false|off)/i);
    assert.doesNotMatch(rule, /(when|if)[^.]*review\.github (is )?(false|off)[^.]*(warn)/i);
  }
});

// T3.4
test('test_t3_4_upgrade_offers_review_flag', () => {
  const up = section(initText54(), /^## Upgrade/m, /^## (?!Upgrade)/m);
  assert.match(up, /review\.github: true/);
  assert.match(up, /claude-code-review\.yml/);
  assert.match(up, /after a yes/i);
});

// ---- T12: doctor cleans up branches of merged devflow PRs ----
const doctorText63 = () => read('skills/doctor/SKILL.md');
const doctorCheck5 = () => section(doctorText63(), /^5\. /m, /^6\. /m);

// T12.1
test('test_t12_1_doctor_lists_merged_leftovers', () => {
  const c5 = doctorCheck5();
  assert.match(c5, /merged_at/);
  assert.match(c5, /devflow/);
  assert.match(c5, /worktree/i);
  assert.match(c5, /local branch/i);
  assert.match(c5, /remote/i);
});

// T12.2
test('test_t12_2_doctor_rechecks_before_delete', () => {
  const c5 = doctorCheck5();
  assert.match(c5, /baseBranch/);
  assert.match(c5, /protectedBranches/);
  assert.match(c5, /open PR/i);
  assert.match(c5, /\bbase\b/i);
  assert.match(c5, /\bhead\b/i);
  assert.match(c5, /current branch/i);
  assert.match(c5, /current directory|directory doctor runs in/i);
});

// T12.3
test('test_t12_3_doctor_safe_delete_commands', () => {
  const text = doctorText63();
  assert.match(text, /git worktree remove/);
  assert.match(text, /git branch -d/);
  assert.match(text, /git branch -D <branch>/);
  assert.match(text, /git push <remote> --delete/);
  assert.match(text, /github\.remote/);
  assert.doesNotMatch(text, /git worktree remove[^\n`]*--force/);
});

// T12.4
test('test_t12_4_closed_unmerged_per_branch_yes', () => {
  const c5 = doctorCheck5();
  assert.match(c5, /closed/i);
  assert.match(c5, /per branch|per-branch|each branch|every branch/i);
  assert.match(c5, /\byes\b/i);
});

// T12.5
test('test_t12_5_auto_delete_setting_reported', () => {
  const text = doctorText63();
  assert.match(text, /delete_branch_on_merge/);
  assert.match(text, /Automatically delete head branches/);
  assert.match(text, /\bwarn\b/);
  assert.match(text, /\bunknown\b/);
  assert.match(read('README.md'), /Automatically delete head branches/);
});

// Helpers for T7: split skills/spec/SKILL.md into sections by heading.
function specSection(re) {
  const lines = read('skills/spec/SKILL.md').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && re.test(l));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
const epicModeText = () => specSection(/epic mode/i);
const fileModeText = () => specSection(/`?--file`? mode/i);
const finalMessageText = () => specSection(/final message/i);

// T7.1
test('test_t7_1_epic_template_sections', () => {
  const text = read('skills/spec/templates/epic.md');
  assert.match(text, /Goal/);
  assert.match(text, /Design/);
  assert.match(text, /## Decisions/);
  const header = text.split('\n').find((l) => /^\|/.test(l) && /risk/i.test(l) && /depends[ -]?on/i.test(l));
  assert.ok(header, 'Tasks table header has risk and depends-on columns');
});

// T7.2
test('test_t7_2_epic_mode_titles_and_epic_line', () => {
  const skill = read('skills/spec/SKILL.md');
  assert.ok(skill.includes('[<slug>]'));
  assert.ok(skill.includes('T<n>:'));
  assert.ok(skill.includes('type:epic'));
  const issue = read('skills/spec/templates/issue.md');
  assert.ok(issue.includes('Epic: #'));
  assert.match(issue, /spec/i);
  assert.match(issue, /\[[^\]]*spec[^\]]*\]\(/i, 'issue.md has the spec link variant');
  assert.ok(issue.includes('Depends on #'));
});

// T7.3
test('test_t7_3_sub_issue_labels_no_ready', () => {
  const epic = epicModeText();
  assert.ok(epic, 'SKILL.md has an Epic mode section');
  for (const k of ['labels.riskLow', 'labels.riskHigh', 'labels.e2e', 'type:']) {
    assert.ok(epic.includes(k), `epic mode mentions ${k}`);
  }
  assert.ok(!epic.includes('labels.ready'), 'epic mode does not mention labels.ready');
  assert.ok(finalMessageText().includes('labels.ready'), 'final message mentions labels.ready');
});

// T7.4
test('test_t7_4_links_with_sub_issue_write', () => {
  const skill = read('skills/spec/SKILL.md');
  assert.match(skill, /sub_issue_write/);
  assert.match(skill, /\badd\b/);
});

// T7.5
test('test_t7_5_size_check_before_create', () => {
  const epic = epicModeText();
  assert.ok(epic, 'SKILL.md has an Epic mode section');
  assert.ok(epic.includes('65,000'));
  assert.match(epic, /\blength\b/);
  assert.ok(epic.includes('--file'));
  const check = epic.indexOf('65,000');
  const create = epic.search(/(?<!sub_)issue_write/);
  assert.ok(create >= 0, 'epic mode has a create step using issue_write');
  assert.ok(check < create, 'size check comes before the create step');
});

// T7.9 (decision Q1: reused epic's Tasks table is the only edit to a reused issue)
test('test_t7_9_reuse_step_excepts_epic_tasks_table', () => {
  const epic = epicModeText();
  const step = epic.split('\n').find((l) => /^1\.\s.*exact match/.test(l)) || '';
  assert.ok(step, 'reuse step found');
  assert.match(step, /except[^.]*Tasks table/i);
});

// T7.6
test('test_t7_6_file_mode_keeps_290_steps', () => {
  const text = fileModeText();
  assert.ok(text, 'SKILL.md has a --file mode section');
  assert.match(text, /Gate 1/);
  assert.match(text, /spec PR/i);
  assert.ok(text.includes('labels.ready'));
});

// T7.7
test('test_t7_7_final_message_ready', () => {
  const text = finalMessageText();
  assert.ok(text, 'SKILL.md has a Final message step');
  assert.ok(text.includes('labels.ready'));
});

// Helpers for T8: step labels are headings (--file mode) or bold paragraph leads (epic mode).
const stepOffset = (text, re) => {
  const m = text.match(new RegExp(`^(?:#{1,6}\\s+|\\*\\*)?(?:[EF]\\d+\\.\\s*)?(?:${re.source})`, 'im'));
  return m ? m.index : -1;
};

// T8.1
test('test_t8_1_open_questions_section', () => {
  const skill = read('skills/spec/SKILL.md');
  assert.ok(skill.includes('## Open questions'), 'SKILL.md has ## Open questions');
  assert.ok(read('skills/spec/templates/issue.md').includes('## Open questions'), 'issue.md has ## Open questions');
  assert.ok(skill.includes('Risks and unknowns'), 'SKILL.md names Risks and unknowns');
  assert.ok(fileModeText().includes('Risks and unknowns'), '--file mode names Risks and unknowns');
});

// T8.2
test('test_t8_2_spec_review_contract', () => {
  const skill = read('skills/spec/SKILL.md');
  for (const k of ['spec.qaModel', 'missing requirement', 'contradiction', 'not independent', 'critical', 'warning', 'suggestion']) {
    assert.ok(skill.includes(k), `SKILL.md contains ${k}`);
  }
});

// T8.3
test('test_t8_3_spec_review_order_both_modes', () => {
  const epic = epicModeText();
  const file = fileModeText();
  assert.ok(epic && file, 'both mode sections exist');
  const eQa = stepOffset(epic, /[^\n]*\(QA\)/);
  const eReview = stepOffset(epic, /Spec review/);
  const eCreate = stepOffset(epic, /(?:Build|Create)\b/);
  assert.ok(eQa >= 0, 'epic mode has a QA step');
  assert.ok(eReview >= 0, 'epic mode has a Spec review step');
  assert.ok(eCreate >= 0, 'epic mode has a build/create step');
  assert.ok(eQa < eReview, 'epic: QA before spec review');
  assert.ok(eReview < eCreate, 'epic: spec review before issue creation');
  const fQa = stepOffset(file, /[^\n]*\(QA\)/);
  const fReview = stepOffset(file, /Spec review/);
  const fPr = stepOffset(file, /Spec PR/);
  assert.ok(fQa >= 0, '--file has a QA step');
  assert.ok(fReview >= 0, '--file has a Spec review step');
  assert.ok(fPr >= 0, '--file has a Spec PR step');
  assert.ok(fQa < fReview, '--file: QA before spec review');
  assert.ok(fReview < fPr, '--file: spec review before spec PR');
});

// ---- T9 (#60): answer appends decisions only, no PR in epic mode ----
// T9.1
test('test_t9_1_append_only_format', () => {
  const t = answerText();
  assert.ok(t.includes('(Q<k>):'), 'issue entry form');
  assert.ok(t.includes('(#<issue>, Q<k>):'), 'epic entry form');
  assert.ok(t.includes('→'));
  assert.ok(t.includes('## Decisions'));
  assert.ok(!t.includes('(updated by /devflow:answer)'), 'update-in-place rule is gone');
});

// T9.2
test('test_t9_2_epic_append_no_pr', () => {
  const t = answerText();
  const i = t.indexOf('Epic: #');
  assert.ok(i >= 0, 'mentions the Epic: # line');
  const after = t.slice(i, i + 1500);
  assert.match(after, /no (branch|PR)|(without|not)[^.\n]*(branch|PR)/i, 'no branch or PR');
  assert.match(after, /spec path/i, 'conditioned on the spec path');
});

// T9.3
test('test_t9_3_spec_pr_appends_decisions_only', () => {
  const t = answerText();
  assert.ok(!/in the section it belongs to/i.test(t), 'old wording is gone');
  const s3 = answerStep(3);
  assert.ok(s3.includes('## Decisions'), 'spec step names the spec Decisions section');
  assert.match(s3, /(only|nothing else|no other)/i, 'states it is the only change');
  assert.ok(s3.includes('(Q<k>):'), 'spec entry form');
});

// T9.4
test('test_t9_4_unblock_step_unchanged', () => {
  const t = answerText();
  for (const s of ['<!-- devflow-claim id=', 'assignee', 'labels.blocked', 'labels.inProgress', 'labels.ready']) {
    assert.ok(t.includes(s), `unblock keeps ${s}`);
  }
});

// ---- T10 (#61): accept takes an epic ----
const acceptText = () => read('skills/accept/SKILL.md');

// T10.1
test('test_t10_1_accept_takes_epic', () => {
  const t = acceptText();
  assert.ok(t.includes('#<n>'), 'epic argument form');
  assert.ok(t.includes('Epic: #'), 'Epic: # line source');
  assert.ok(/sub-issue/i.test(t), 'native sub-issue source');
});

// T10.2
test('test_t10_2_accept_comment_and_gap_titles', () => {
  const t = acceptText();
  assert.ok(t.includes('<!-- devflow-accept -->'));
  assert.ok(t.includes('[<slug>]'));
  assert.ok(t.includes('[epic #'));
});

// T10.3
test('test_t10_3_accept_not_an_epic', () => {
  assert.ok(acceptText().includes('is not an epic'));
});

// T10.4
test('test_t10_4_accept_spec_path_kept', () => {
  const t = acceptText();
  assert.ok(t.includes('a path under `specDir`'));
  assert.ok(t.includes('or a slug'));
  assert.ok(t.includes('git show <remote>/<baseBranch>:<specDir>/<file>'));
  assert.ok(t.includes('Gap: '));
});

// ---- T21 (#102): accept without a dev server ----
// T21.1
test('T21.1 accept does not stop at preflight without a dev server or modes', () => {
  const t = acceptText();
  assert.ok(!t.includes('acceptance cannot run'), 'no stop at preflight');
  assert.ok(t.includes('Evidence-only mode'), 'evidence-only mode named');
  assert.ok(/without `verify\.devServer`, or with empty `verify\.modes`/.test(t), 'both triggers named');
  assert.ok(/does not stop/.test(t), 'says it does not stop');
});

// T21.2
test('T21.2 accept marks running-app criteria not checkable in evidence-only mode', () => {
  const t = acceptText();
  assert.ok(/criteri\w+ that need a running app are `not checkable`/i.test(t));
});

// T21.3
test('T21.3 accept takes other results from merged PR checks, matrix rows and manual rows', () => {
  const t = acceptText();
  assert.ok(t.includes("merged PRs' checks"));
  assert.ok(t.includes('test-matrix rows'));
  assert.ok(t.includes('manual rows recorded as pass in the PR body'));
});

// T21.4
test('T21.4 accept marks a criterion with no evidence not checkable', () => {
  const t = acceptText();
  assert.ok(/criterion with no such evidence is `not checkable`/.test(t));
});

// T21.5
test('T21.5 accept still posts the devflow-accept result in evidence-only mode', () => {
  const t = acceptText();
  const i = t.indexOf('Evidence-only mode');
  assert.ok(i >= 0);
  assert.ok(/still posts the `<!-- devflow-accept -->` result on the epic or spec PR/.test(t));
});

// ---- T11: /devflow:report takes an epic and shows per-issue metrics ----
const reportText = () => read('skills/report/SKILL.md');

// T11.1
test('test_t11_1_report_json_contract', () => {
  const t = reportText();
  for (const k of ['spec.epic', 'spec.pr', 'metrics', 'path', 'reviewRounds', 'blocked', 'claimedAt', 'mergedAt', 'durationHours', 'mergedBy']) {
    assert.ok(t.includes(k), `SKILL.md contains ${k}`);
  }
});

// T11.2
test('test_t11_2_report_metric_sources', () => {
  const t = reportText();
  assert.ok(t.includes('devflow-run'));
  assert.ok(t.includes('<!-- devflow-blocked -->'));
  assert.match(t, /verdict[- ]marker/i);
});

// Runs the script of trace.html in node:vm against a stub DOM; returns all rendered text.
const renderTrace = (data, lang) => {
  const vm = require('node:vm');
  const html = read('skills/report/templates/trace.html');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'trace.html has an inline script');
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class El {
    constructor() { this.children = []; this.attrs = {}; this.dataset = {}; this.own = ''; this.style = { setProperty() {} }; this.className = ''; this._cl = new Set(); }
    get textContent() { return this.own + this.children.map((c) => c.textContent).join(' '); }
    set textContent(v) { this.own = String(v); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    get classList() { const s = this._cl; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle() {} }; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener() {}
    querySelectorAll(sel) {
      const m2 = /^\[(data-[a-z]+)\]$/.exec(sel);
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (m2 && c.attrs[m2[1]] !== undefined) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  const root = new El();
  const byId = {};
  const document = {
    documentElement: new El(),
    createElement: () => new El(),
    querySelector: (s) => { if (!byId[s]) { byId[s] = new El(); root.appendChild(byId[s]); } return byId[s]; },
    querySelectorAll: (s) => root.querySelectorAll(s)
  };
  document.querySelector('#data').textContent = JSON.stringify(data);
  const localStorage = { getItem: () => lang || null, setItem() {} };
  const ctx = vm.createContext({ document, localStorage, setTimeout, clearTimeout, console });
  vm.runInContext(m[1], ctx);
  return root.children.filter((c) => c !== byId['#data']).map((c) => c.textContent).join(' ');
};

const traceIssue = (over) => Object.assign({
  number: 101, url: 'https://github.com/o/r/issues/101', title: 'Sample issue', labels: ['devflow'], risk: 'low',
  plan: null, questions: null, blocked: false,
  pr: { number: 201, url: 'https://github.com/o/r/pull/201', state: 'merged', base: 'main', stacked: false, byGate: false, mergedByKnown: true, mergedBy: 'pr-merger' },
  review: { state: 'success', rounds: 2, description: 'ok' }, tests: null, accepted: null
}, over || {});
const fullMetrics = () => ({ path: 'short', reviewRounds: 7, blocked: 4, claimedAt: '2031-05-06T07:08:09Z', mergedAt: '2032-01-02T03:04:05Z', durationHours: 12.3, mergedBy: 'gate' });
const unknownCount = (s) => (s.match(/unknown|chưa rõ/g) || []).length;

// T11.3
test('test_t11_3_trace_renders_five_metrics', () => {
  const text = renderTrace({
    spec: { slug: 'e', title: 'Epic', epic: { number: 100, url: 'https://github.com/o/r/issues/100' }, pr: null },
    issues: [traceIssue({ metrics: fullMetrics() })], release: null
  });
  assert.ok(text.includes('short'), 'path');
  assert.match(text, /\b7\b/, 'review rounds');
  assert.match(text, /\b4\b/, 'times blocked');
  assert.ok(text.includes('12.3'), 'duration');
  assert.match(text, /Merged by\s+(gate|the gate)/i, 'merged by');
  assert.ok(!text.includes('2031-05-06'), 'claimedAt value not shown');
  assert.ok(!text.includes('2032-01-02'), 'mergedAt value not shown');
});

// T11.4
test('test_t11_4_trace_null_renders_unknown', () => {
  const mk = (m) => ({ spec: { slug: 'e', title: 'Epic', epic: null, pr: null }, issues: [traceIssue({ metrics: m })], release: null });
  const nulls = Object.assign(fullMetrics(), { reviewRounds: null, durationHours: null });
  for (const [lang, word] of [['en', 'unknown'], ['vi', 'chưa rõ']]) {
    const base = unknownCount(renderTrace(mk(fullMetrics()), lang));
    const text = renderTrace(mk(nulls), lang);
    assert.ok(text.includes(word), `${lang} shows ${word}`);
    assert.ok(unknownCount(text) >= base + 2, `${lang}: two more unknown cells than with full metrics`);
  }
});

// T11.5
test('test_t11_5_trace_renders_290_data', () => {
  const text = renderTrace({
    spec: { slug: 's', title: 'Old spec', pr: { number: 9, url: 'https://github.com/o/r/pull/9', mergedBy: 'someone' } },
    issues: [traceIssue(), traceIssue({ number: 102, title: 'Second issue', pr: null })], release: null
  });
  assert.ok(text.includes('#101 Sample issue'));
  assert.ok(text.includes('#102 Second issue'));
});

// T1.1 (#125)
test('test_t1_1_trace_short_path_shows_skipped_plan_and_verify', () => {
  const short = { path: 'short', reviewRounds: 1, blocked: 0, claimedAt: null, mergedAt: null, durationHours: null, mergedBy: 'gate' };
  const data = { spec: { slug: 'e', title: 'Epic', epic: null, pr: null }, issues: [traceIssue({ metrics: short })], release: null };
  const count = (s, w) => s.split(w).length - 1;
  const en = renderTrace(data, 'en');
  assert.strictEqual(count(en, 'skipped (short path)'), 2, 'Plan and Verify are skipped');
  assert.ok(en.includes('Checks'), 'Checks row present');
  assert.ok(en.includes('Verify'), 'Verify row present');
  assert.match(renderTrace(data, 'vi'), /skipped \(short path\)|bỏ qua \(đường ngắn\)/);
  const html = read('skills/report/templates/trace.html');
  assert.match(html, /\.node\.skipped\s*\{[^}]*--c:/, 'neutral skipped style exists');
});

// T1.2 (#125)
test('test_t1_2_trace_full_path_shows_plan_review_checks_verify_greyed_when_missing', () => {
  const full = { path: 'full', reviewRounds: 1, blocked: 0, claimedAt: null, mergedAt: null, durationHours: null, mergedBy: 'gate' };
  const mk = (extra) => Object.assign({ spec: { slug: 'e', title: 'Epic', epic: null, pr: null }, issues: [traceIssue({ metrics: full, review: null })], release: null }, extra);
  const withVerify = renderTrace(mk({ verifyConfigured: true }), 'en');
  assert.ok(!withVerify.includes('skipped (short path)'), 'nothing skipped on the full path');
  for (const w of ['Plan', 'Review', 'Checks', 'Verify']) assert.ok(withVerify.includes(w), w + ' row');
  const without = renderTrace(mk({}), 'en');
  assert.ok(without.includes('Checks'));
  assert.ok(!without.includes('Verify'), 'Verify only when verify is configured');
});

// T11.6
test('test_t11_6_report_read_only', () => {
  const t = reportText();
  for (const w of ['add_issue_comment', 'issue_write', 'create_pull_request']) {
    assert.ok(!t.includes(w), `SKILL.md does not name ${w}`);
  }
});

// ---- T14: missing-tag check in doctor, predecessor check in release ----
const doctorTagCheck = () => {
  const line = read('skills/doctor/SKILL.md').split('\n').find((l) => /^\d+\. \*\*Release tag\.\*\*/.test(l));
  assert.ok(line, 'doctor has a "Release tag" check');
  return line;
};
const releasePredecessor = () => {
  const t = read('skills/release/SKILL.md');
  const v = section(t, /^## 2\. Version/m, /^## 3\. /m);
  const i = v.search(/predecessor/i);
  assert.ok(i >= 0, 'version step has a predecessor check');
  return v.slice(i);
};

test('T14.1 doctor warns when the declared version has no tag', () => {
  const l = doctorTagCheck();
  assert.match(l, /`warn`/);
  assert.match(l, /<release\.tagPrefix><version>/);
  assert.match(l, /nam(e|ing) the missing tag/i);
});

test('T14.2 doctor version source and mismatch', () => {
  const l = doctorTagCheck();
  assert.match(l, /\.claude-plugin\/plugin\.json/);
  assert.match(l, /newest changelog version heading/i);
  assert.match(l, /differ[^.]*`warn`|mismatch[^.]*`warn`/i);
});

test('T14.3 release refuses when the previous released version has no tag', () => {
  const p = releasePredecessor();
  assert.match(p, /previous released version/i);
  assert.match(p, /no tag/i);
  assert.match(p, /refus/i);
  assert.match(p, /nam(e|es|ing) it/i);
  assert.match(p, /only after the user says so/i);
});

test('T14.4 release check skipped without an earlier heading; non-semver ignored', () => {
  const p = releasePredecessor();
  assert.match(p, /skipped[^.]*no earlier version heading|no earlier version heading[^.]*skipped/i);
  assert.match(p, /non-semver headings are ignored/i);
});

test('T14.5 doctor tag check skipped without any declared version', () => {
  const l = doctorTagCheck();
  assert.match(l, /skipped[^.]*neither|neither[^.]*skipped/i);
});

// ---- T22 (#103): doctor "Waiting on you" section ----
const doctorWaiting = () => section(read('skills/doctor/SKILL.md'), /^## Waiting on you/m, /^## (?!Waiting on you)/m);

test('T22.1 doctor ends with a read-only Waiting on you section with six categories and commands', () => {
  const text = read('skills/doctor/SKILL.md');
  const w = doctorWaiting();
  assert.ok(text.trimEnd().endsWith(w.trimEnd()), 'Waiting on you is the last section');
  assert.match(w, /read-only/i);
  for (const re of [/\/devflow:answer #n/, /merge/i, /\/devflow:sync #pr/, /\/devflow:next-task/, /\/devflow:dispatch/, /\/devflow:accept #n/, /labels\.ready/]) {
    assert.match(w, re);
  }
});

test('T22.2 doctor lists an unclassifiable item as check by hand', () => {
  assert.match(doctorWaiting(), /check by hand/i);
});

test('T22.3 doctor says so when nothing is waiting', () => {
  assert.match(doctorWaiting(), /nothing (is waiting|to do)/i);
});

test('T22.4 doctor lists each issue or PR once in the first matching category', () => {
  const w = doctorWaiting();
  assert.match(w, /once[^.]*first matching category|first matching category[^.]*once/i);
  const order = ['blocked', 'waiting for a merge', 'conflict or behind', 'ready', 'sub-issue', 'epic'];
  let at = -1;
  const orderLine = w.split('\n').find((l) => /first matching category/i.test(l)) || '';
  for (const k of order) {
    const i = orderLine.toLowerCase().indexOf(k);
    assert.ok(i > at, `${k} follows the previous category in the order`);
    at = i;
  }
});

test('T22.5 doctor section has no cap on lines', () => {
  assert.match(doctorWaiting(), /no cap/i);
});

test('T22.6 doctor Waiting on you never changes anything, also with --fix', () => {
  assert.match(doctorWaiting(), /never changes anything[^.]*--fix|--fix[^.]*never changes anything/i);
});

test('T22.7 doctor sub-issue not ready leaves out in-review sub-issues and ones with an open PR', () => {
  const l = doctorWaiting().split('\n').find((x) => /Sub-issue not ready/.test(x)) || '';
  assert.match(l, /labels\.review/);
  assert.match(l, /open PR/i);
});

// T17.4
test("test_t17_4_spec_writes_resolves_into_epic", () => {
  const skill = read("skills/spec/SKILL.md");
  const tpl = read("skills/spec/templates/epic.md");
  assert.match(skill, /Resolves: #a, #b/);
  assert.match(skill, /names existing issues it resolves/);
  assert.match(tpl, /Resolves: #a, #b/);
});

// ---- T19: report shows local review, skipped steps and who merged ----
const reportItem = (label) => {
  const m = reportText().match(new RegExp('^- \\*\\*' + label + '\\*\\*[^\\n]*', 'm'));
  assert.ok(m, `SKILL.md has the ${label} item`);
  return m[0];
};

test('T19.1 report review falls back to the local review from ## Review and the devflow-run marker', () => {
  const r = reportItem('Review');
  assert.match(r, /no `devflow\/review` status/);
  assert.ok(r.includes('## Review') && r.includes('devflow-run'));
  assert.ok(r.includes('local review: pass, N round(s)') && r.includes('local review: fail, N round(s)'));
});

test('T19.2 report uses the devflow/review status when present', () => {
  assert.match(reportItem('Review'), /with a `devflow\/review` status the status is used/);
});

test('T19.3 report writes the literal round(s)', () => {
  const t = reportText();
  assert.ok(t.includes('round(s)'));
  assert.doesNotMatch(t, /\b[12] rounds?\b/);
});

test('T19.4 report shows Plan and Verify as skipped on the short path', () => {
  assert.match(reportText(), /short path[^.]*Plan and Verify[^.]*"skipped \(short path\)"[^.]*neutral/i);
});

test('T19.5 report greys missing steps on the full path', () => {
  const t = reportText();
  assert.match(t, /full path[^.]*Plan, Review, Checks and Verify[^.]*grey[^.]*missing/i);
  assert.match(t, /Verify[^.]*only when `verify` is configured/);
});

test('T19.6 report mergedBy is gate for the marker comment or the trailer', () => {
  assert.match(reportText(), /`mergedBy` is `gate` when[^.]*<!-- devflow-gate-merged -->[^.]*Merged-by: devflow merge gate/);
});

test('T19.7 report mergedBy is human when the body has a devflow-run marker and no gate evidence', () => {
  assert.match(reportText(), /otherwise `human` when the PR body has a `devflow-run` marker/);
});

test('T19.8 report mergedBy falls back to the 3.0.0 rule', () => {
  assert.match(reportText(), /otherwise the 3\.0\.0 rule[^.]*`human`[^.]*other than the gate token owner[^.]*`unknown`/);
});

// ---- T6: /devflow:answer accept ----
const answerStep2 = () => answerStep(2);

test('T6.1 answer accept answers every open question with its Recommended option', () => {
  assert.match(answerStep2(), /`\/devflow:answer #n accept`[^.]*answers every open question with its `Recommended:` option/);
});

test('T6.2 answer accept with an override takes the typed answer for that question only', () => {
  assert.match(answerStep2(), /`accept; 2: <answer>`[^.]*recommended options (for all questions )?except question 2[^.]*typed answer/);
});

test('T6.3 answer accept refuses a criterion-changing question and records nothing until all are answered', () => {
  const s = answerStep2();
  assert.match(s, /`accept` refuses a question whose recommended option changes an acceptance criterion/);
  assert.match(s, /\[changes a criterion: typed answer needed\]/);
  assert.match(s, /asks? for a typed answer/);
  assert.match(s, /no answer is recorded until all (questions )?are answered/i);
});

test('T6.4 answer accept with no open questions says so and changes nothing', () => {
  assert.match(answerStep2(), /`accept` with no open questions says so and changes nothing/);
});

test('T6.5 answer accept override out of range or repeated refuses the whole answer', () => {
  assert.match(answerStep2(), /override number out of range or repeated refuses the whole answer/);
});
