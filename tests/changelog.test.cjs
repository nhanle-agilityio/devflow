'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'devflow-changelog');
const { parseFragment, renderSection } = require(BIN);

function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else out += c;
  }
  return out;
}

const CHANGELOG = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [1.1.0] - 2026-01-01\n\n### Added\n- old\n';

function project(files = {}, config = { changelog: { fragmentsDir: 'changelog.d' } }, changelog = CHANGELOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-changelog-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  if (config) fs.writeFileSync(path.join(dir, '.claude', 'devflow.json'), JSON.stringify(config));
  if (changelog !== null) fs.writeFileSync(path.join(dir, (config && config.changelog && config.changelog.file) || 'CHANGELOG.md'), changelog);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'changelog.d', name), body);
  }
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
};
const V = ['--version', '1.2.0', '--date', '2026-11-18'];

test('T8.1 schema and example declare changelog.fragmentsDir and changelog.file', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/init/templates/devflow.schema.json'), 'utf8'));
  const props = schema.properties.changelog.properties;
  assert.equal(props.fragmentsDir.type, 'string');
  assert.ok(!('default' in props.fragmentsDir));
  assert.equal(props.file.type, 'string');
  assert.equal(props.file.default, 'CHANGELOG.md');
  const example = JSON.parse(stripJsonc(fs.readFileSync(path.join(ROOT, 'skills/init/templates/devflow.json'), 'utf8')));
  assert.equal(typeof example.changelog.fragmentsDir, 'string');
  assert.equal(example.changelog.file, 'CHANGELOG.md');
});

test('T8.2 a config without a changelog object stays valid', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/init/templates/devflow.schema.json'), 'utf8'));
  assert.ok(!schema.required.includes('changelog'));
  assert.equal(schema.properties.changelog.additionalProperties, false);
  assert.ok(!(schema.properties.changelog.required || []).length);
});

test('T8.3 has: valid fragment exits 0', () => {
  const dir = project({ '7.md': '### Added\n- a\n' });
  assert.equal(run(dir, 'has', '7').status, 0);
});

test('T8.4 has: missing fragment exits 1', () => {
  const dir = project({ '8.md': '### Added\n- a\n' });
  assert.equal(run(dir, 'has', '7').status, 1);
});

test('T8.5 has: invalid fragment exits 1', () => {
  const dir = project({ '7.md': '### Added\n' });
  assert.equal(run(dir, 'has', '7').status, 1);
});

test('T8.6 has: fragmentsDir unset exits 2 with a message on stderr', () => {
  const dir = project({}, { changelog: {} });
  const r = run(dir, 'has', '7');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fragmentsDir/);
});

test('T8.7 has: no argument or a non-number exits 2', () => {
  const dir = project({});
  assert.equal(run(dir, 'has').status, 2);
  assert.equal(run(dir, 'has', 'abc').status, 2);
});

test('T8.8 valid: several sections', () => {
  assert.equal(parseFragment('### Added\n- a\n\n### Fixed\n- b\n').ok, true);
});

test('T8.9 valid: indented sub-bullets and continuation lines', () => {
  assert.equal(parseFragment('### Added\n- a\n  continued\n  - sub\n').ok, true);
});

test('T8.10 duplicate heading is merged', () => {
  const f = parseFragment('### Added\n- a\n\n### Added\n- b\n');
  assert.equal(f.ok, true);
  const out = renderSection('1.0.0', '2026-01-01', [{ n: 3, sections: f.sections }]);
  assert.equal(out.match(/### Added/g).length, 1);
  assert.match(out, /- a \(#3\)\n- b \(#3\)/);
});

test('T8.11 unknown heading is invalid', () => {
  assert.equal(parseFragment('### Misc\n- a\n').ok, false);
});

test('T8.12 prose line under a heading is invalid', () => {
  assert.equal(parseFragment('### Added\nsome prose\n').ok, false);
});

test('T8.13 non-numeric file name makes preview and assemble exit 1 naming it', () => {
  const dir = project({ 'notes.md': 'x\n', '7.md': '### Added\n- a\n' });
  for (const cmd of ['preview', 'assemble']) {
    const r = run(dir, cmd, ...V);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notes\.md/);
  }
});

test('T8.14 preview format', () => {
  const dir = project({ '10.md': '### Fixed\n- f\n', '2.md': '### Added\n- a\n' });
  const r = run(dir, 'preview', '--version', '1.2.0', '--date', '2026-11-18');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '## [1.2.0] - 2026-11-18\n\n### Added\n- a (#2)\n\n### Fixed\n- f (#10)\n');
});

test('T8.15 fragments are ordered by issue number, not lexically', () => {
  const mk = (n) => ({ n, sections: parseFragment(`### Added\n- x${n}\n`).sections });
  const out = renderSection('1.0.0', '2026-01-01', [mk(2), mk(10), mk(9)]);
  assert.ok(out.indexOf('x2 ') < out.indexOf('x9 ') && out.indexOf('x9 ') < out.indexOf('x10 '));
});

test('T8.16 a bullet that already cites the issue is not suffixed twice', () => {
  const f = parseFragment('### Added\n- a (#2)\n');
  const out = renderSection('1.0.0', '2026-01-01', [{ n: 2, sections: f.sections }]);
  assert.match(out, /- a \(#2\)\n/);
  assert.ok(!out.includes('(#2) (#2)'));
});

test('T8.17 preview writes nothing', () => {
  const dir = project({ '2.md': '### Added\n- a\n' });
  const before = snapshot(dir);
  assert.equal(run(dir, 'preview', ...V).status, 0);
  assert.deepEqual(snapshot(dir), before);
});

test('T8.18 assemble happy path', () => {
  const dir = project({ '2.md': '### Added\n- a\n', '3.md': '### Fixed\n- b\n' });
  const r = run(dir, 'assemble', ...V);
  assert.equal(r.status, 0);
  const text = read(dir, 'CHANGELOG.md');
  assert.ok(text.indexOf('## [Unreleased]') < text.indexOf('## [1.2.0] - 2026-11-18'));
  assert.ok(text.indexOf('## [1.2.0]') < text.indexOf('## [1.1.0]'));
  assert.match(text, /### Added\n- a \(#2\)\n\n### Fixed\n- b \(#3\)\n\n## \[1\.1\.0\]/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'changelog.d')), []);
});

test('T8.19 bullets already under Unreleased move into the new section', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- x\n\n## [1.1.0] - 2026-01-01\n\n### Added\n- old\n';
  const dir = project({ '2.md': '### Fixed\n- y\n' }, undefined, log);
  assert.equal(run(dir, 'assemble', ...V).status, 0);
  const text = read(dir, 'CHANGELOG.md');
  const [head, rest] = text.split('## [1.2.0]');
  assert.ok(!head.includes('- x'));
  assert.match(rest, /### Fixed\n- x\n- y \(#2\)/);
});

test('T8.20 custom changelog.file', () => {
  const dir = project({ '2.md': '### Added\n- a\n' }, { changelog: { fragmentsDir: 'changelog.d', file: 'HISTORY.md' } });
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'untouched\n');
  assert.equal(run(dir, 'assemble', ...V).status, 0);
  assert.match(read(dir, 'HISTORY.md'), /## \[1\.2\.0\]/);
  assert.equal(read(dir, 'CHANGELOG.md'), 'untouched\n');
});

test('T8.21 assemble with an invalid fragment writes and deletes nothing', () => {
  const dir = project({ '2.md': '### Added\n- a\n', '3.md': '### Misc\n- b\n' });
  const before = snapshot(dir);
  assert.equal(run(dir, 'assemble', ...V).status, 1);
  assert.deepEqual(snapshot(dir), before);
});

test('T8.22 assemble refuses an existing version', () => {
  const dir = project({ '2.md': '### Added\n- a\n' });
  const before = snapshot(dir);
  assert.equal(run(dir, 'assemble', '--version', '1.1.0', '--date', '2026-11-18').status, 1);
  assert.deepEqual(snapshot(dir), before);
});

test('T8.23 assemble with fragmentsDir unset exits 2 and writes nothing', () => {
  const dir = project({}, { changelog: {} });
  const before = snapshot(dir);
  assert.equal(run(dir, 'assemble', ...V).status, 2);
  assert.deepEqual(snapshot(dir), before);
});

test('T8.24 assemble: missing changelog or missing Unreleased heading exits 1', () => {
  const none = project({ '2.md': '### Added\n- a\n' }, undefined, null);
  assert.equal(run(none, 'assemble', ...V).status, 1);
  const noHeading = project({ '2.md': '### Added\n- a\n' }, undefined, '# Changelog\n\n## [1.1.0] - 2026-01-01\n');
  const before = snapshot(noHeading);
  assert.equal(run(noHeading, 'assemble', ...V).status, 1);
  assert.deepEqual(snapshot(noHeading), before);
});

test('T8.25 assemble: nothing to release', () => {
  const dir = project({});
  const before = snapshot(dir);
  const r = run(dir, 'assemble', ...V);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to release/);
  assert.deepEqual(snapshot(dir), before);
});

test('T8.26 only Unreleased bullets and no fragments succeeds', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n## [1.1.0] - 2026-01-01\n';
  const dir = project({}, undefined, log);
  assert.equal(run(dir, 'assemble', ...V).status, 0);
  assert.match(read(dir, 'CHANGELOG.md'), /## \[Unreleased\]\n\n## \[1\.2\.0\] - 2026-11-18\n\n### Added\n- x\n/);
});

test('T8.27 usage errors exit 2', () => {
  const dir = project({ '2.md': '### Added\n- a\n' });
  assert.equal(run(dir, 'assemble', '--date', '2026-11-18').status, 2);
  assert.equal(run(dir, 'assemble', '--version', '1.2.0').status, 2);
  assert.equal(run(dir, 'frobnicate').status, 2);
});

test('T8.28 pre-release version is accepted', () => {
  const dir = project({ '2.md': '### Added\n- a\n' });
  assert.equal(run(dir, 'assemble', '--version', '1.2.0-rc.1', '--date', '2026-11-18').status, 0);
  assert.match(read(dir, 'CHANGELOG.md'), /## \[1\.2\.0-rc\.1\] - 2026-11-18/);
});

test('T8.29 invalid version format exits 2', () => {
  const dir = project({ '2.md': '### Added\n- a\n' });
  assert.equal(run(dir, 'assemble', '--version', '1.2', '--date', '2026-11-18').status, 2);
});
