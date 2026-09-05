const test = require('node:test');
const assert = require('node:assert');
const { parseNameStatus, parseUnified } = require('../dist/git.js');

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

test('parseNameStatus reads add, modify and delete', () => {
  const files = parseNameStatus(['A\tsrc/new.js', 'M\tsrc/old.js', 'D\tsrc/gone.js', ''].join('\n'));

  assert.deepEqual(files, {
    'src/new.js': 'A',
    'src/old.js': 'M',
    'src/gone.js': 'D',
  });
});

test('parseNameStatus takes the new path for a rename', () => {
  const files = parseNameStatus('R100\tsrc/before.js\tsrc/after.js\n');

  // The old path no longer exists on the compare branch, so it must not be a key.
  assert.deepEqual(files, { 'src/after.js': 'R' });
});

test('parseNameStatus treats a copy as an addition', () => {
  const files = parseNameStatus('C75\tsrc/source.js\tsrc/copy.js\n');

  assert.deepEqual(files, { 'src/copy.js': 'A' });
});

test('parseNameStatus on empty output returns nothing', () => {
  assert.deepEqual(parseNameStatus(''), {});
  assert.deepEqual(parseNameStatus('\n\n'), {});
});
