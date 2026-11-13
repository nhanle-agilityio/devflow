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
