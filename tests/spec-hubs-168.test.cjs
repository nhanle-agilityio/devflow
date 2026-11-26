'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'skills', 'spec', file), 'utf8');
const skill = read('SKILL.md');
const sections = skill.split(/(?=^## )/m);
const reviewHeading = /^## Review of the draft\b/i;
const shared = sections.filter((s) => !/^## (?:Epic mode|`?--file`? mode|Review of the draft|Final message)\b/i.test(s));

function draftingSteps() {
  const steps = skill.split(/(?=^#{2,3} )/m);
  return [/^### E1\b/i, /^### F1\b/i].map((heading) => {
    const step = steps.find((s) => heading.test(s));
    assert.ok(step, `Expected task drafting step ${heading}`);
    return [...shared, step].join('\n\n');
  });
}

function prose(text) {
  return text.replace(/[`*]/g, '').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
}

function instructions(text) {
  return text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map(prose);
}

const foundation = /\bfoundation(?:al)?[ -]tasks?\b/i;
function extractsGroundwork(p) {
  return foundation.test(p)
    && /\b(?:shared|common|reusable|multiple tasks|several tasks)\b/i.test(p)
    && /\b(?:extract|split|separat|isolat|factor|pull|creat|mak|mov|put|giv|draft|becom|belong|use|goes|own)\w*\b/i.test(p);
}

function limitsDependencies(p) {
  return /\b(?:depends[ -]on|dependenc(?:y|ies))\b/i.test(p)
    && /\b(?:only|unless|requir(?:es?|ed)|must|reserve[ds]?)\b/i.test(p)
    && /\b(?:us(?:e[sd]?|ing)|consum(?:e[sd]?|ing)|calls?|imports?|reads?|needs?|relies on)\b/i.test(p)
    && /\b(?:code|implementation|schema|files?|modules?|functions?|APIs?|calls?|imports?)\b/i.test(p)
    && /\b(?:another|other|upstream|prerequisite|producer|that task|it creates)\b/i.test(p);
}

test('A5.1 both drafting modes extract shared groundwork into a foundation task', () => {
  for (const draft of draftingSteps()) {
    assert.ok(instructions(draft).some(extractsGroundwork),
      'Expected shared groundwork to be extracted into a foundation task during task drafting');
  }
});

test("A5.2 Depends on requires use of another task's code and excludes topic and work order", () => {
  for (const draft of draftingSteps()) {
    const rules = instructions(draft);
    assert.ok(rules.some(limitsDependencies), "Expected Depends on to require using another task's code or artifacts");
    const exclusions = rules.flatMap((p) => p.split(/[.!?]/))
      .filter((s) => /\b(?:not|never|no|nor|neither|avoid|exclude|insufficient|isn't|aren't|doesn't)\b/i.test(s));
    assert.ok(exclusions.some((s) => /\b(?:topics?|themes?|areas?|related work)\b/i.test(s)),
      'Expected a shared topic alone to be excluded');
    assert.ok(exclusions.some((s) => /\b(?:order(?:ing)?|sequenc(?:e|ing)|schedul(?:e|ing)|go(?:es)? first)\b/i.test(s)),
      'Expected a preferred work order alone to be excluded');
  }
});

test('A5.3 draft review warns about a task with three or more dependents without blocking', () => {
  const review = sections.find((s) => reviewHeading.test(s));
  assert.ok(review, 'Expected the Review of the draft section');
  const threshold = /(?:\b(?:3|three)(?:\s*\+|\s+or more)|(?:at least|>=|≥)\s*(?:3|three)\b|more than (?:2|two)\b)/i;
  const downstream = /(?:(?:direct )?dependents?\b|(?:dependent|downstream) tasks?\b|(?:other )?tasks? (?:that |which )?(?:depend(?:ing)?|rely) on\b)/i;
  const trigger = new RegExp(`${threshold.source}\\s+${downstream.source}|depended (?:on|upon) by ${threshold.source} (?:other )?tasks?`, 'i');
  const warning = review.split(/\n(?=\d+\.\s)/).map(prose).find((p) => trigger.test(p));
  assert.ok(warning, 'Expected the warning threshold to be three or more tasks depending on one task');

  assert.match(warning, /\bwarn(?:s|ing|ings)?\b/i, 'Expected the hub to raise a warning');
  const naming = /\b(?:nam(?:es?|ing)|list(?:s|ing)?|identif(?:y|ies|ying)|show(?:s|ing)?|includ(?:es?|ing)|mention(?:s|ing)?|print(?:s|ing)?|report(?:s|ing)?|warning with)\b/i;
  const named = warning.split(/[.!?;]/).filter((s) => naming.test(s)).map((s) => s.slice(s.search(naming)));
  const subject = /\b(?:(?:the|this|that|upstream|central|source) (?:task|hub|prerequisite)\b|its (?:task )?(?:id|name)\b|(?:nam(?:e|es|ing)|list|identify|show|include|mention) it\b)/i;
  assert.ok(named.some((s) => subject.test(s)),
    'Expected the warning to name the task that others depend on');
  assert.ok(named.some((s) => downstream.test(s)), 'Expected the warning to name the dependent tasks');
  assert.ok(warning.split(/[.!?]/).some((s) => foundation.test(s) && /\b(?:suggest|recommend|consider|propos|try)\w*\b/i.test(s)),
    'Expected the warning to suggest a foundation task');
  assert.match(prose(review), /non[ -]?blocking|(?:never|not|no|without|doesn't) (?:a )?(?:block|gate|pause|stop|ask|wait)|(?:no|without) (?:an? )?(?:answer|response|confirmation)|(?:informational|advisory) only/i,
    'Expected an advisory warning that lets drafting proceed');
});

test('A5.4 template Tasks guidance covers foundation tasks and code dependencies', () => {
  const tasks = read('templates/spec.md').split(/(?=^## )/m).find((s) => /^## Tasks\s*$/m.test(s));
  assert.ok(tasks, 'Expected the Tasks section of the spec template');
  const comments = [...tasks.matchAll(/<!--([\s\S]*?)-->/g)].flatMap((m) => instructions(m[1]));
  assert.ok(comments.some((p) => foundation.test(p)), 'Expected foundation task guidance in a Tasks comment');
  assert.ok(comments.some(limitsDependencies), "Expected a Tasks comment limiting dependencies to use of another task's code or artifacts");
});
