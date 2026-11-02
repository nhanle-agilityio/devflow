'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planLanes } = require('../bin/devflow-lanes');

const iss = (number, hotspots = [], dependsOn = []) => ({ number, hotspots, dependsOn });
const plan = (issues, maxLanes = 3) => planLanes({ maxLanes, issues });
const nums = (r) => r.lanes.map((l) => l.issues);

test('independent issues get one lane each', () => {
  const r = plan([iss(3, ['c']), iss(1, ['a']), iss(2, ['b'])]);
  assert.deepEqual(nums(r), [[1], [2], [3]]);
  assert.deepEqual(r.deferred, []);
});

test('shared hotspot puts issues in the same lane', () => {
  const r = plan([iss(1, ['x.py']), iss(2, ['y.py']), iss(3, [' x.py '])]);
  assert.deepEqual(nums(r), [[1, 3], [2]]);
});

test('hotspot match is case-sensitive', () => {
  assert.deepEqual(nums(plan([iss(1, ['A.py']), iss(2, ['a.py'])])), [[1], [2]]);
});

test('sharing is transitive', () => {
  const r = plan([iss(1, ['x']), iss(2, ['x', 'y']), iss(3, ['y'])]);
  assert.deepEqual(nums(r), [[1, 2, 3]]);
});

test('dependency inside the set shares a lane, parent first', () => {
  const r = plan([iss(1, [], [5]), iss(5), iss(2)]);
  assert.deepEqual(nums(r), [[5, 1], [2]]);
});

test('dependency outside the set is ignored', () => {
  const r = plan([iss(1, [], [99]), iss(2)]);
  assert.deepEqual(nums(r), [[1], [2]]);
});

test('lanes beyond maxLanes are deferred', () => {
  const r = plan([iss(1, ['a']), iss(2, ['b']), iss(3, ['c']), iss(4, ['c'])], 2);
  assert.deepEqual(nums(r), [[1], [2]]);
  assert.deepEqual(r.deferred, [{ issues: [3, 4], reason: 'over maxLanes (2)' }]);
});

test('cycle keeps number order and warns', () => {
  const r = plan([iss(7, [], [3]), iss(3, [], [7])]);
  assert.deepEqual(nums(r), [[3, 7]]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /cycle/);
});

test('sharedHotspots lists paths in 2+ issues, sorted', () => {
  const r = plan([iss(1, ['b', 'a', 'only1']), iss(2, ['a', 'b']), iss(3, ['b'])]);
  assert.deepEqual(r.lanes[0].sharedHotspots, ['a', 'b']);
  assert.deepEqual(plan([iss(1, ['z'])]).lanes[0].sharedHotspots, []);
});

test('empty input gives no lanes', () => {
  assert.deepEqual(plan([]), { lanes: [], deferred: [], ignoredHotspots: [], warnings: [] });
});

test('default ignore list drops README.md and CHANGELOG.md', () => {
  const r = plan([iss(1, ['README.md', 'a.py']), iss(2, ['README.md', 'CHANGELOG.md']), iss(3, ['CHANGELOG.md'])]);
  assert.deepEqual(nums(r), [[1], [2], [3]]);
  assert.deepEqual(r.ignoredHotspots, ['CHANGELOG.md', 'README.md']);
  assert.deepEqual(r.lanes[0].sharedHotspots, []);
});

test('ignoreHotspots [] ignores nothing', () => {
  const r = planLanes({ maxLanes: 3, ignoreHotspots: [], issues: [iss(1, ['README.md']), iss(2, ['README.md'])] });
  assert.deepEqual(nums(r), [[1, 2]]);
  assert.deepEqual(r.ignoredHotspots, []);
});

test('ignoreHotspots accepts globs with * and **', () => {
  const ignoreHotspots = ['docs/**', '*.md', 'src/*.lock'];
  const issues = [
    iss(1, ['docs/a/b.md', 'x.py']),
    iss(2, ['docs/c.md', 'NOTES.md']),
    iss(3, ['NOTES.md', 'src/a.lock']),
    iss(4, ['src/sub/b.lock', 'sub/NOTES.md']),
    iss(5, ['src/b.lock']),
  ];
  const r = planLanes({ maxLanes: 5, ignoreHotspots, issues });
  assert.deepEqual(r.ignoredHotspots, ['NOTES.md', 'docs/a/b.md', 'docs/c.md', 'src/a.lock', 'src/b.lock']);
  assert.deepEqual(nums(r), [[1], [2], [3], [4], [5]]);
});

test('a non-ignored hotspot still joins lanes next to ignored ones', () => {
  const r = planLanes({ maxLanes: 3, ignoreHotspots: ['*.md'], issues: [iss(1, ['a.md', 'x']), iss(2, ['a.md', 'x'])] });
  assert.deepEqual(nums(r), [[1, 2]]);
  assert.deepEqual(r.lanes[0].sharedHotspots, ['x']);
});

test('everything ignored gives independent lanes', () => {
  const r = planLanes({ maxLanes: 3, ignoreHotspots: ['**'], issues: [iss(1, ['a', 'b/c']), iss(2, ['a', 'b/c'])] });
  assert.deepEqual(nums(r), [[1], [2]]);
  assert.deepEqual(r.ignoredHotspots, ['a', 'b/c']);
});

test('dependencies still join lanes when their hotspots are ignored', () => {
  assert.deepEqual(nums(plan([iss(1, ['README.md']), iss(2, ['README.md'], [1])])), [[1, 2]]);
});

test('invalid input throws', () => {
  assert.throws(() => planLanes(null));
  assert.throws(() => planLanes({ maxLanes: 0, issues: [] }));
  assert.throws(() => planLanes({ maxLanes: 2 }));
  assert.throws(() => planLanes({ maxLanes: 2, issues: [{ number: 'x' }] }));
  assert.throws(() => planLanes({ maxLanes: 2, issues: [iss(1), iss(1)] }));
  assert.throws(() => planLanes({ maxLanes: 2, issues: [{ number: 1, hotspots: [3] }] }));
  assert.throws(() => planLanes({ maxLanes: 2, issues: [{ number: 1, dependsOn: ['2'] }] }));
  assert.throws(() => planLanes({ maxLanes: 2, ignoreHotspots: 'x', issues: [] }));
});
