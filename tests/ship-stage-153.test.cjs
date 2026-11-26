'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const fixture = fs.readFileSync(path.join(__dirname, 'engine.test.cjs'), 'utf8').split(/^test\(/m)[0];
const { BASE, run, prompt } = new Function(
  'require', '__dirname', fixture + '\nreturn { BASE, run, prompt };',
)(require, __dirname);

// Find the payload without depending on its key order, indentation, or enclosing shell syntax.
function shipPayload(ship) {
  for (const start of ship.matchAll(/\{(?=\s*"[^"]+"\s*:)/g)) {
    const rest = ship.slice(start.index);
    let depth = 0;
    for (const token of rest.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
      if (token[0] === '{') depth++;
      if (token[0] === '}') depth--;
      if (depth !== 0) continue;
      let value;
      try {
        value = JSON.parse(rest.slice(0, token.index + 1));
      } catch {
        break;
      }
      if (Object.hasOwn(value, 'reviewTrace') || Object.hasOwn(value, 'runMarker')) return value;
      break;
    }
  }
}

test('M5.8 gives Ship both CLI commands and a JSON payload with the exact review trace and marker', async () => {
  const prTemplatePath = path.join(__dirname, '..', 'skills/next-task/templates/pr.md');
  const summary = 'Build the shipping payload from the stage results.';
  const { rep, calls } = await run({ ...BASE, issues: [7], prTemplatePath }, {
    labels: ['risk:low'],
    body: 'Risk: low - PR metadata only',
    devOut: { summary },
  });
  assert.equal(rep[0].status, 'pr', rep[0].reason);
  const ship = prompt(calls, 'ship #7');
  assert.ok(ship, 'Expected a Ship stage');
  assert.ok(/devflow-run["']?\s+push\b/.test(ship), 'Expected Ship to run devflow-run push');
  assert.ok(/devflow-run["']?\s+pr-body\b/.test(ship), 'Expected Ship to run devflow-run pr-body');
  assert.ok(ship.includes(prTemplatePath), 'Expected Ship to use the configured PR template');

  const payload = shipPayload(ship);
  assert.ok(payload, 'Expected engine-built PR body input JSON in the Ship prompt');
  assert.deepEqual(payload.issue, { number: 7, title: 't7' });
  assert.equal(payload.summary, summary);
  assert.deepEqual(payload.closes, [7]);
  assert.deepEqual(payload.reviewTrace, [
    'Review: pass after 1 round(s) - local devflow reviewer in this run (GitHub review: off)',
    'Path: short (Plan and Verify skipped)',
    'Verify: not needed',
  ]);
  assert.equal(payload.runMarker,
    '<!-- devflow-run {"path":"short","reviewRounds":1,"claimedAt":"2026-01-01T00:00:05Z","agentCalls":6} -->');

  assert.doesNotMatch(ship, /\b(?:write the PR body with sections|fill every section from the data|rewrite its title and body from the data)\b/i);
  assert.doesNotMatch(ship, /\bBody as described\b|\bgit push -u\b/);
});
