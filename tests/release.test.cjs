'use strict';
// Release 3.0.0 checks (#64). Names follow test_t13_<n>_<description>.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Body of a changelog section: from its "## [name]" heading up to the next "## [" heading.
function section(changelog, name) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${name}]`));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('test_t13_1_version_3_0_0', () => { // T13.1
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, '3.0.0');
});

test('test_t13_2_changelog_3_0_0_entries', () => { // T13.2
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /^## \[3\.0\.0\] - \d{4}-\d{2}-\d{2}/m);
  // [Unreleased] collects entries of the next release (3.1.0 work); only its heading is required.
  assert.ok(section(changelog, 'Unreleased') !== null, 'an [Unreleased] heading exists');
  const body = section(changelog, '3.0.0');
  assert.ok(body, '3.0.0 section exists');
  for (let n = 52; n <= 63; n++) {
    assert.match(body, new RegExp(`#${n}(?!\\d)`), `issue #${n} appears in the 3.0.0 section`);
  }
});

test('test_t13_3_upgrade_note_keywords', () => { // T13.3
  const body = section(read('CHANGELOG.md'), '3.0.0');
  assert.ok(body, '3.0.0 section exists');
  const lower = body.toLowerCase();
  for (const kw of ['review.github', 'requiredChecks', '--file', 'epic', 'short path']) {
    assert.ok(lower.includes(kw.toLowerCase()), `3.0.0 section mentions ${kw}`);
  }
});

test('test_t13_4_full_suites_pass', { timeout: 600000 }, () => { // T13.4
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.cjs') && f !== 'release.test.cjs')
    .map((f) => path.join('tests', f));
  const node = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(node.status, 0, `node suites failed:\n${(node.stdout || '').slice(-2000)}${node.stderr || ''}`);
  const py = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'hooks', '-p', 'test_*.py'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(py.status, 0, `hook suite failed:\n${(py.stderr || '').slice(-2000)}`);
});
