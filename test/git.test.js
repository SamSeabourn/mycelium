const test = require('node:test');
const assert = require('node:assert');
const { parseNameStatus, parseHunks, parseRenames, parseBranches } = require('../dist/git.js');


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


test('parseRenames maps each new path back to its old one', () => {
  const out = ['M\tsrc/a.js', 'R090\tsrc/utils.ts\tsrc/strings.ts', 'C75\tsrc/x.js\tsrc/y.js', ''].join('\n');

  assert.deepEqual(parseRenames(out), { 'src/strings.ts': 'src/utils.ts' });
});

test('parseBranches lists local and remote branches, without the remote HEAD pointer', () => {
  const all = parseBranches(
    ['refs/heads/main', 'refs/heads/feat/x', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/their-pr', ''].join('\n'),
  );

  assert.deepEqual(all, ['main', 'feat/x', 'origin/main', 'origin/their-pr']);
});
