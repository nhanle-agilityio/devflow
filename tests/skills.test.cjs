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
