const test = require('node:test');
const assert = require('node:assert');
const {
  parseFile,
  resolveImport,
  buildFunctionGraph,
  markChangedFunctions,
  functionStatus,
} = require('../dist/functions.js');
const { parseHunks } = require('../dist/git.js');

test('parseFile finds declarations, arrows and methods', () => {
  const { defs } = parseFile(
    'src/a.ts',
    `
    export function alpha() {}
    const beta = () => {};
    class Thing { gamma() {} }
    `,
  );

  assert.deepEqual(
    defs.map((d) => d.name).sort(),
    ['Thing.gamma', 'alpha', 'beta'],
  );
});

test('parseFile records only the calls it can name', () => {
  const { calls } = parseFile(
    'src/a.ts',
    `
    function outer() {
      inner();
      lookup[key]();      // dynamic — unresolvable, must not appear
      other.method();     // member call on a value — also skipped
    }
    `,
  );

  assert.deepEqual(calls, [{ from: 'src/a.ts#outer', name: 'inner' }]);
});

test('parseFile attributes this.x() to the enclosing method', () => {
  const { calls } = parseFile('src/a.ts', 'class T { run() { this.step(); } step() {} }');

  assert.deepEqual(calls, [{ from: 'src/a.ts#T.run', name: 'step' }]);
});

test('parseFile survives a syntax error without throwing', () => {
  const facts = parseFile('src/broken.js', 'function ( { { {');

  assert.deepEqual(facts.defs, []);
});

test('resolveImport maps a specifier onto an already-resolved dep', () => {
  const deps = ['src/scan.ts', 'src/util/index.ts'];

  assert.equal(resolveImport('src/main.ts', './scan', deps), 'src/scan.ts');
  assert.equal(resolveImport('src/main.ts', './util', deps), 'src/util/index.ts');
  assert.equal(resolveImport('src/main.ts', 'electron', deps), null, 'packages are outside the graph');
  assert.equal(resolveImport('src/main.ts', './missing', deps), null);
});

test('buildFunctionGraph links a call across an import', () => {
  const files = { 'src/a.ts': 'import { helper } from "./b";\nexport function main() { helper(); }' , 'src/b.ts': 'export function helper() {}' };
  const fileGraph = { 'src/a.ts': ['src/b.ts'], 'src/b.ts': [] };

  const { graph, label, file } = buildFunctionGraph(Object.keys(files), fileGraph, (f) => files[f]);

  assert.deepEqual(graph['src/a.ts#main'], ['src/b.ts#helper']);
  assert.equal(label['src/b.ts#helper'], 'helper');
  assert.equal(file['src/b.ts#helper'], 'src/b.ts');
});

test('buildFunctionGraph does not invent an edge to a same-named function elsewhere', () => {
  // b.ts also has `helper`, but a.ts never imports it — no edge may appear.
  const files = { 'src/a.ts': 'export function main() { helper(); }', 'src/b.ts': 'export function helper() {}' };
  const fileGraph = { 'src/a.ts': [], 'src/b.ts': [] };

  const { graph } = buildFunctionGraph(Object.keys(files), fileGraph, (f) => files[f]);

  assert.deepEqual(graph['src/a.ts#main'], []);
});

test('buildFunctionGraph ghosts calls into files outside the parsed set', () => {
  const files = {
    'src/a.ts': 'import { helper } from "./b";\nexport function main() { helper(); }',
  };
  // b.ts is a real dependency but was NOT passed in — it fell outside the hop window.
  const fileGraph = { 'src/a.ts': ['src/b.ts'] };

  const { graph, ghosts } = buildFunctionGraph(Object.keys(files), fileGraph, (f) => files[f]);

  assert.deepEqual(graph['src/a.ts#main'], [], 'no real edge to an unparsed file');
  assert.deepEqual(ghosts['src/a.ts#main'], ['src/b.ts#helper'], 'the edge is recorded as a ghost');
});

test('markChangedFunctions only flags functions the diff actually touched', () => {
  const defs = [
    { id: 'src/a.ts#touched', file: 'src/a.ts', name: 'touched', start: 10, end: 20 },
    { id: 'src/a.ts#untouched', file: 'src/a.ts', name: 'untouched', start: 30, end: 40 },
  ];

  // A change at line 15 lands inside `touched` only.
  assert.deepEqual(markChangedFunctions(defs, { 'src/a.ts': [[15, 15]] }), ['src/a.ts#touched']);
  assert.deepEqual(markChangedFunctions(defs, { 'src/a.ts': [[25, 26]] }), [], 'gap between functions');
  assert.deepEqual(markChangedFunctions(defs, {}), []);
});

test('parseHunks reads the compare-side line ranges', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -12,0 +13,4 @@',
    '@@ -40,2 +45,1 @@',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,5 +0,0 @@',
  ].join('\n');

  assert.deepEqual(parseHunks(diff), { 'src/a.ts': [[13, 16], [45, 45]] });
});

test('functionStatus reports a new function in an edited file as added', () => {
  // The case that looked broken: the file is 'M', but this function is not in it yet.
  const base = new Set(['parseNameStatus', 'branches']);

  assert.equal(functionStatus('fileDiff', 'M', base), 'A');
  assert.equal(functionStatus('parseNameStatus', 'M', base), 'M');
});

test('functionStatus treats everything in a new file as added', () => {
  assert.equal(functionStatus('anything', 'A', undefined), 'A');
});

test('functionStatus falls back to modified when the base side is unreadable', () => {
  // Must not relabel every function as added just because git show failed.
  assert.equal(functionStatus('whatever', 'M', undefined), 'M');
});
