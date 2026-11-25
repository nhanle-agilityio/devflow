'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const readme = read('README.md');
const flows = read('docs/devflow-flows.html');

// The page uses t(vi, en), named bilingual blocks, and a VI-to-EN map.
const STR = "((?:[^'\\\\]|\\\\.)*)";
const pairs = [
  ...flows.matchAll(new RegExp(`\\bt\\(\\s*'${STR}',\\s*'${STR}'\\s*\\)`, 'g')),
  ...flows.matchAll(new RegExp(`\\bvi:\\s*'${STR}',\\s*en:\\s*'${STR}'`, 'g')),
];
const staticTranslations = flows.split('const EN = {')[1].split('\n  };')[0];
pairs.push(...staticTranslations.matchAll(new RegExp(`^\\s*'${STR}':\\s*'${STR}',?\\s*$`, 'gm')));

const documents = [
  ['README.md', readme, 'en'],
  ['flows page (EN)', pairs.map((pair) => pair[2]).join('\n'), 'en'],
  ['flows page (VI)', pairs.map((pair) => pair[1]).join('\n'), 'vi'],
];

const rows = [
  ['D1.1 decide-or-block and recommended answers', [
    'nextTask.onQuestion', 'nextTask.trustDecisions', 'decisions:review', '/devflow:answer #<n> accept',
  ]],
  ['D1.2 branch resume, base conflicts and run helpers', [
    'branchPattern', '<type>/<issue>-', 'Integrate', 'bin/devflow-run check',
    'bin/devflow-run branch', 'bin/devflow-run restore', 'bin/devflow-gh',
  ]],
  ['D1.3 changelog fragments', [
    'changelog.d/', 'changelog.fragmentsDir', 'bin/devflow-changelog',
  ]],
  ['D1.4 dispatch planning and the Next column', [
    '/devflow:dispatch --plan',
  ]],
  ['D1.5 doctor checks and Waiting on you', [
    '/devflow:doctor', 'release.tagPrefix',
    'needs-triage', 'labels.inProgress', 'labels.review', 'labels.blocked', 'devflow-claim',
  ]],
  ['D1.6 report details and evidence-only acceptance', [
    '/devflow:report', 'devflow/review',
    'devflow-gate-merged',
    '/devflow:accept', 'verify.devServer',
  ]],
  ['D1.7 merge gate holds and state-label cleanup', [
    'decisions:review', 'nextTask.trustDecisions', 'labels.inProgress', 'labels.review', 'labels.blocked',
  ]],
  ['D1.8 review models and agent-call budget', [
    'nextTask.reviewModel', 'nextTask.maxAgentCalls', 'Sonnet', 'Opus',
  ]],
  ['D1.9 epic approval and auto-ready', [
    '/devflow:approve', 'labels.epicApproved', 'epic:approved', 'spec.autoReady',
  ]],
];

for (const [title, names] of rows) {
  test(title, () => {
    const missing = [];
    for (const [document, source, language] of documents) {
      const text = source.replace(/<\/?code>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const absent = names
        .map((name) => typeof name === 'string' ? name : name[language])
        .filter((name) => !text.includes(name));
      if (absent.length) missing.push(`${document} missing ${absent.join(', ')}`);
    }
    assert.ok(missing.length === 0, missing.join('\n'));
  });
}
