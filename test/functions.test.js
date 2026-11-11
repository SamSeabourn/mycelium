const test = require('node:test');
const assert = require('node:assert');
const {
  parseFile,
  resolveImport,
  buildFunctionGraph,
  markChangedFunctions,
  functionStatus,
  removedCalls,
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

test('buildFunctionGraph follows an aliased import to the exported name', () => {
  const files = {
    'src/a.ts': 'import { install as installMap } from "./b";\nexport const main = () => { installMap(); };',
    'src/b.ts': 'export const install = () => {};',
  };
  const fileGraph = { 'src/a.ts': ['src/b.ts'], 'src/b.ts': [] };

  const { graph } = buildFunctionGraph(Object.keys(files), fileGraph, (f) => files[f]);

  assert.deepEqual(graph['src/a.ts#main'], ['src/b.ts#install']);
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

test('parseFile survives decorators', () => {
  const { defs } = parseFile(
    'src/a.ts',
    `
    @Injectable()
    export class Service {
      constructor(@Inject(Dep) private dep: Dep) {}
      @Get()
      run() {}
    }
    `,
  );

  assert.deepEqual(defs.map((d) => d.name).sort(), ['Service.constructor', 'Service.run']);
});

test('parseFile sees through memo and forwardRef wrappers', () => {
  const { defs } = parseFile(
    'src/Card.tsx',
    `
    const Card = React.memo(forwardRef((p, r) => <div ref={r} />));
    const total = items.reduce((a, b) => a + b, 0);
    `,
  );

  // The wrapper unwraps; an ordinary method call on a lowercase object does not.
  assert.deepEqual(defs.map((d) => d.name), ['Card']);
});

test('parseFile names an anonymous default export after its file', () => {
  const { defs } = parseFile('src/Button.tsx', 'export default function () { return <button /> }');

  assert.deepEqual(defs.map((d) => d.name), ['Button']);
});

test('parseFile treats JSX element usage as a call', () => {
  const { calls } = parseFile(
    'src/App.tsx',
    'export function App() { return <div><Button /></div> }',
  );

  // <div> is a host element, not a component.
  assert.deepEqual(calls, [{ from: 'src/App.tsx#App', name: 'Button' }]);
});

test('removedCalls reports calls that vanished, only from changed files', () => {
  const before = {
    graph: {
      'a.ts#run': ['legacy.ts#old', 'b.ts#keep'],
      'b.ts#keep': ['c.ts#gone'], // b.ts unchanged: its calls cannot have moved
    },
    file: { 'a.ts#run': 'a.ts', 'b.ts#keep': 'b.ts' },
  };
  const after = { 'a.ts#run': ['b.ts#keep'], 'b.ts#keep': [] };

  assert.deepEqual(removedCalls(before, after, new Set(['a.ts'])), { 'a.ts#run': ['legacy.ts#old'] });
});

test('buildFunctionGraph links obj.m() to the one class defining m, and namespace imports', () => {
  const src = {
    'src/cart.ts': 'export class Cart { total() {} clear() {} }\nexport class Bag { clear() {} }',
    'src/util.ts': 'export function fmt() {}',
    'src/api.ts': `import * as util from './util';
      import ext from 'pkg';
      function checkout(cart) { cart.total(); cart.clear(); util.fmt(); ext.total(); }`,
  };
  const files = Object.keys(src);
  const { graph } = buildFunctionGraph(files, { 'src/api.ts': files }, (f) => src[f]);

  // clear is ambiguous (Cart and Bag) and ext comes from a package: no edge for either.
  assert.deepEqual(graph['src/api.ts#checkout'].sort(), ['src/cart.ts#Cart.total', 'src/util.ts#fmt']);
});

test('buildFunctionGraph ignores builtin-looking method calls unless the receiver names the class', () => {
  const src = {
    'src/cart.ts': 'export class Cart { map() {} add() {} log() {} }',
    'src/api.ts': `function run(items, cart, seen) { items.map(); seen.add(); cart.add(); console.log(); }`,
  };
  const files = Object.keys(src);
  const { graph } = buildFunctionGraph(files, { 'src/api.ts': files }, (f) => src[f]);

  assert.deepEqual(graph['src/api.ts#run'], ['src/cart.ts#Cart.add']);
});

test('parseFile names a top-level anonymous callback after the call registering it', () => {
  const { defs, calls } = parseFile(
    'src/main.ts',
    `ipcMain.handle('go', async () => { helper(); });
     panel.addEventListener('click', () => {});
     panel.addEventListener('click', () => {});`,
  );

  assert.deepEqual(defs.map((d) => d.name), [
    "ipcMain.handle('go')",
    "panel.addEventListener('click')",
    "panel.addEventListener('click') #2",
  ]);
  assert.deepEqual(calls, [
    { from: 'src/main.ts#main.ts', name: "ipcMain.handle('go')" },
    { from: "src/main.ts#ipcMain.handle('go')", name: 'helper' },
    { from: 'src/main.ts#main.ts', name: "panel.addEventListener('click')" },
    { from: 'src/main.ts#main.ts', name: "panel.addEventListener('click') #2" },
  ]);
});

test('buildFunctionGraph gives a file top-level node only when it calls something of ours', () => {
  const src = {
    'src/main.ts': `app.whenReady().then(createWindow);
      ipcMain.handle('ping', () => Date.now());
      const createWindow = () => {};`,
    'src/quiet.ts': `console.log('hi');`,
  };
  const files = Object.keys(src);
  const { graph, label, span } = buildFunctionGraph(files, {}, (f) => src[f]);

  assert.deepEqual(graph['src/main.ts#main.ts'].sort(), ["src/main.ts#createWindow", "src/main.ts#ipcMain.handle('ping')"]);
  assert.equal(label['src/main.ts#main.ts'], 'main.ts');
  assert.equal(span['src/main.ts#main.ts'], undefined, 'no span: never marked changed');
  assert.equal(graph['src/quiet.ts#quiet.ts'], undefined);
});

test('parseFile counts a function passed as an argument as a call', () => {
  const { calls } = parseFile('src/a.ts', 'function start() { requestAnimationFrame(tick); }');

  assert.deepEqual(calls, [
    { from: 'src/a.ts#start', name: 'requestAnimationFrame' },
    { from: 'src/a.ts#start', name: 'tick' },
  ]);
});

test('parseFile keeps same-named functions in one file apart', () => {
  const { defs, calls } = parseFile(
    'src/plugin.ts',
    `function isAttachedTo() { walk({ enter() { a(); } }); }
     function rewrite() { walk({ enter() { b(); } }); walk({ enter() { c(); } }); }`,
  );

  assert.deepEqual(defs.map((d) => d.name), [
    'isAttachedTo',
    'enter (in isAttachedTo)',
    'rewrite',
    'enter (in rewrite)',
    'enter (in rewrite) #2',
  ]);
  // Each body's calls stay with its own node.
  assert.deepEqual(
    calls.filter((c) => ['a', 'b', 'c'].includes(c.name)).map((c) => `${c.from.split('#').slice(1).join('#')} -> ${c.name}`),
    ['enter (in isAttachedTo) -> a', 'enter (in rewrite) -> b', 'enter (in rewrite) #2 -> c'],
  );
});

test('parseFile names object methods after a named object, whatever else is in the file', () => {
  const { defs } = parseFile(
    'src/plugin.ts',
    `const awaitVisitor = { AwaitExpression() {} };
     export default () => ({ visitor: { AwaitExpression() {}, Program: { exit() {} } } });`,
  );

  assert.deepEqual(defs.map((d) => d.name).filter((n) => n !== 'plugin'), [
    'awaitVisitor.AwaitExpression',
    'visitor.AwaitExpression',
    'Program.exit',
  ]);
});

test('buildFunctionGraph survives calls named like Object.prototype members', () => {
  const src = { 'src/a.js': 'function run(x) { constructor(); toString(); x.hasOwnProperty("y"); }' };

  const { graph } = buildFunctionGraph(Object.keys(src), {}, (f) => src[f]);

  assert.deepEqual(graph['src/a.js#run'], []);
});
