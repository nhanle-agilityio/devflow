'use strict';
// Every place that states the plugin's current version must agree with .claude-plugin/plugin.json and with the
// newest release heading in CHANGELOG.md. A guard against a half-done release, not a hard-coded number.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SEMVER = '(\\d+\\.\\d+\\.\\d+)';
const first = (text, re, what) => {
  const m = re.exec(text);
  assert.ok(m, `${what}: no match for ${re}`);
  return m[1];
};

const pluginVersion = JSON.parse(read('.claude-plugin/plugin.json')).version;

test('plugin.json holds a semantic version', () => {
  assert.match(pluginVersion, new RegExp(`^${SEMVER}$`));
});

test('the marketplace entry for devflow has the plugin version', () => {
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  const entry = market.plugins.find((p) => p.name === 'devflow');
  assert.ok(entry, 'devflow entry');
  assert.equal(entry.version, pluginVersion);
});

test('the init template devflowVersion has the plugin version (JSON with // comments: read by regex)', () => {
  const v = first(read('skills/init/templates/devflow.json'), new RegExp(`"devflowVersion"\\s*:\\s*"${SEMVER}"`), 'devflowVersion');
  assert.equal(v, pluginVersion);
});

test('the newest release heading in the changelog is the plugin version ([Unreleased] is skipped)', () => {
  const v = first(read('CHANGELOG.md'), new RegExp(`^## \\[${SEMVER}\\]`, 'm'), 'changelog heading');
  assert.equal(v, pluginVersion);
});

test('the README opening paragraph states the plugin version', () => {
  const v = first(read('README.md'), new RegExp(`^A Claude Code plugin \\(version ${SEMVER}, see `, 'm'), 'README opening');
  assert.equal(v, pluginVersion);
});

test('DESIGN.md states the plugin version in its opening paragraph and its config example', () => {
  const design = read('DESIGN.md');
  assert.equal(first(design, new RegExp(`^A Claude Code plugin \\(${SEMVER};`, 'm'), 'DESIGN opening'), pluginVersion);
  assert.equal(first(design, new RegExp(`"devflowVersion"\\s*:\\s*"${SEMVER}"`), 'DESIGN devflowVersion'), pluginVersion);
});

test('the flows page shows the plugin version in its header and footer', () => {
  const html = read('docs/devflow-flows.html');
  assert.equal(first(html, new RegExp(`nhanle-agilityio/devflow · v${SEMVER}</span>`), 'flows header'), pluginVersion);
  assert.equal(first(html, new RegExp(`<span>devflow ${SEMVER} · plugin Claude Code`), 'flows footer'), pluginVersion);
});

test('the reusable gate documents the current tag as its devflow-ref example', () => {
  const v = first(read('.github/workflows/devflow-merge-gate.yml'), new RegExp(`\\(e\\.g\\. v${SEMVER}\\)`), 'devflow-ref example');
  assert.equal(v, pluginVersion);
});
