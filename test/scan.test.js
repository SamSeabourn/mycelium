const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { scan } = require('../dist/scan.js');

test('scan returns the file graph with the cycle intact', async () => {
  const result = await scan(path.join(__dirname, 'fixture'));

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.keys(result.graph).sort(), ['a.js', 'b.js', 'c.js']);

  // a -> b -> a. If a cycle-breaking "tree" assumption ever creeps in, this fails.
  assert.ok(result.graph['a.js'].includes('b.js'));
  assert.ok(result.graph['b.js'].includes('a.js'));

  assert.ok(result.graph['c.js'].includes('a.js'));
  assert.equal(result.graph['c.js'].length, 1);
});

test('scan skips node_modules and dist', async () => {
  // Scans diffish itself: it has both directories populated by this point,
  // so no fixture is needed (and .gitignore would eat a fixture copy anyway).
  const result = await scan(path.join(__dirname, '..'));

  assert.equal(result.ok, true, result.error);
  const files = Object.keys(result.graph);
  assert.ok(files.length > 0);
  assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules leaked');
  assert.ok(!files.some((f) => f.includes('dist/')), 'dist leaked');
});

test('scan on a directory with no JS reports an error', async () => {
  const result = await scan(path.join(__dirname, 'empty'));

  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});
