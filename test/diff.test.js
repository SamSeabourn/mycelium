const test = require('node:test');
const assert = require('node:assert');
const { parseUnified, sliceRows } = require('../dist/diff.js');

const unified = (...lines) => lines.join('\n');

test('parseUnified pairs a replaced line side by side', () => {
  const rows = parseUnified(
    unified(
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,3 +1,3 @@ header text',
      ' keep',
      '-was',
      '+now',
      ' tail',
      '',
    ),
  );

  assert.deepEqual(rows, [
    { kind: 'gap', text: 'header text' },
    { kind: 'context', leftNo: 1, rightNo: 1, text: 'keep' },
    { kind: 'change', leftNo: 2, left: 'was', rightNo: 2, right: 'now' },
    { kind: 'context', leftNo: 3, rightNo: 3, text: 'tail' },
  ]);
});

test('parseUnified leaves a blank side when the runs are uneven', () => {
  const rows = parseUnified(unified('@@ -1,1 +1,3 @@', '-one', '+one', '+two', '+three'));

  assert.deepEqual(rows.slice(1), [
    { kind: 'change', leftNo: 1, left: 'one', rightNo: 1, right: 'one' },
    { kind: 'change', leftNo: null, left: null, rightNo: 2, right: 'two' },
    { kind: 'change', leftNo: null, left: null, rightNo: 3, right: 'three' },
  ]);
});

test('parseUnified ignores headers that look like content', () => {
  // "--- a/x" and "+++ b/x" start with - and +; misreading them shifts every line.
  const rows = parseUnified(unified('--- a/x.js', '+++ b/x.js', '@@ -5,1 +5,1 @@', ' only'));

  assert.deepEqual(rows, [
    { kind: 'gap', text: '' },
    { kind: 'context', leftNo: 5, rightNo: 5, text: 'only' },
  ]);
});

test('parseUnified skips the no-newline marker', () => {
  const rows = parseUnified(unified('@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+b'));

  assert.deepEqual(rows.slice(1), [{ kind: 'change', leftNo: 1, left: 'a', rightNo: 1, right: 'b' }]);
});

test('parseUnified on an unchanged file returns nothing', () => {
  assert.deepEqual(parseUnified(''), []);
});

// One file's diff, spanning two functions: alpha at 10-12, beta at 20-22.
const wholeFile = [
  { kind: 'gap', text: 'function alpha()' },
  { kind: 'context', leftNo: 9, rightNo: 9, text: 'before' },
  { kind: 'context', leftNo: 10, rightNo: 10, text: 'function alpha() {' },
  { kind: 'change', leftNo: 11, left: 'old', rightNo: 11, right: 'new' },
  { kind: 'context', leftNo: 12, rightNo: 12, text: '}' },
  { kind: 'gap', text: 'function beta()' },
  { kind: 'context', leftNo: 20, rightNo: 20, text: 'function beta() {' },
  { kind: 'change', leftNo: 21, left: 'gone', rightNo: null, right: null },
  { kind: 'context', leftNo: 22, rightNo: 21, text: '}' },
];

test('sliceRows keeps only the requested function', () => {
  const rows = sliceRows(wholeFile, [10, 12], [10, 12]);

  assert.deepEqual(rows.map((r) => r.rightNo), [10, 11, 12], 'hunk headers and out-of-range lines go');
});

test('sliceRows keeps a removal that belongs to the function', () => {
  // beta's own removal, at old line 21, inside its base-side span.
  const rows = sliceRows(wholeFile, [20, 21], [20, 22]);

  assert.ok(rows.some((r) => r.leftNo === 21 && r.left === 'gone'));
});

test('sliceRows drops removals from outside the base span', () => {
  // alpha's compare-side range, but beta's removal must not ride along.
  const rows = sliceRows(wholeFile, [10, 12], [10, 12]);

  assert.ok(!rows.some((r) => r.left === 'gone'));
});

test('sliceRows blanks the left side when the function is new', () => {
  // No base span: the function did not exist, so it can have no removals — this is
  // what stopped a neighbouring rewrite's deletions appearing in an added function.
  const rows = sliceRows(wholeFile, [10, 12]);

  assert.ok(rows.every((r) => r.kind === 'context' || r.left === null));
  assert.ok(rows.some((r) => r.right === 'new'), 'additions still come through');
});

test('sliceRows returns nothing when the function is untouched', () => {
  assert.deepEqual(sliceRows(wholeFile, [40, 50], [40, 50]), []);
});
