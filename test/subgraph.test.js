const test = require('node:test');
const assert = require('node:assert');
const { withinHops, restrict, hiddenNeighbours } = require('../dist/subgraph.js');

// a -> b -> c -> d -> e
const chain = {
  'a.js': ['b.js'],
  'b.js': ['c.js'],
  'c.js': ['d.js'],
  'd.js': ['e.js'],
  'e.js': [],
};

test('withinHops keeps 2 hops and stops', () => {
  const { files, distance } = withinHops(chain, ['c.js'], 2);

  assert.equal(distance.get('c.js'), 0);
  assert.equal(distance.get('b.js'), 1);
  assert.equal(distance.get('d.js'), 1);
  assert.equal(distance.get('a.js'), 2);
  assert.equal(distance.get('e.js'), 2);

  assert.equal(files.size, 5);
});

test('withinHops excludes anything past the limit', () => {
  const { files } = withinHops(chain, ['a.js'], 2);

  // a -> b -> c reachable; d is 3 hops out and must not appear.
  assert.deepEqual([...files].sort(), ['a.js', 'b.js', 'c.js']);
});

test('withinHops walks importers as well as imports', () => {
  // e.js imports nothing, so a directed walk would find nobody.
  const { distance } = withinHops(chain, ['e.js'], 1);

  assert.equal(distance.get('d.js'), 1, 'importer not reached — traversal is directed');
});

test('withinHops tolerates a seed missing from the graph', () => {
  const { files } = withinHops(chain, ['gone.js'], 2);

  assert.deepEqual([...files], ['gone.js']);
});

test('hiddenNeighbours reports what the cut removed, in both directions', () => {
  const { files } = withinHops(chain, ['a.js'], 1); // keeps a, b
  const hidden = hiddenNeighbours(chain, files);

  // b.js imports c.js, which fell outside — that is exactly what a ghost shows.
  assert.deepEqual(hidden, { 'b.js': ['c.js'] });
  assert.ok(!('a.js' in hidden), 'a.js has no neighbour outside the set');
});

test('hiddenNeighbours finds importers, not just imports', () => {
  // Keep only c.js: b.js imports it, d.js is imported by it. Both are hidden.
  const hidden = hiddenNeighbours(chain, new Set(['c.js']));

  assert.deepEqual(hidden['c.js'], ['b.js', 'd.js']);
});

test('hiddenNeighbours is empty when the set covers everything', () => {
  const { files } = withinHops(chain, ['c.js'], 5);

  assert.deepEqual(hiddenNeighbours(chain, files), {});
});

test('restrict drops edges leaving the kept set', () => {
  const { files } = withinHops(chain, ['a.js'], 1);
  const out = restrict(chain, files);

  assert.deepEqual(Object.keys(out).sort(), ['a.js', 'b.js']);
  assert.deepEqual(out['a.js'], ['b.js']);
  assert.deepEqual(out['b.js'], [], 'c.js is outside the set, so the edge must go');
});
