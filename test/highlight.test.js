const test = require('node:test');
const assert = require('node:assert');
const { splitHighlighted, highlightLines } = require('../dist/highlight.js');

test('splitHighlighted reopens a span that straddles a line break', () => {
  // What hljs actually returns for a JSDoc block: one span containing newlines.
  const html = '<span class="hljs-comment">/**\n * doc\n */</span>';

  assert.deepEqual(splitHighlighted(html), [
    '<span class="hljs-comment">/**</span>',
    '<span class="hljs-comment"> * doc</span>',
    '<span class="hljs-comment"> */</span>',
  ]);
});

test('splitHighlighted leaves single-line markup alone', () => {
  const html = '<span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>;';

  assert.deepEqual(splitHighlighted(html), [html]);
});

test('splitHighlighted returns one entry per line', () => {
  assert.deepEqual(splitHighlighted('a\nb\nc'), ['a', 'b', 'c']);
});

test('highlightLines keeps a doc block a comment on every line', () => {
  // The case per-line highlighting gets wrong: continuation lines look like code.
  const lines = highlightLines('/**\n * A doc block.\n */\nconst x = 1;');

  assert.equal(lines.length, 4);
  for (const l of lines.slice(0, 3)) assert.match(l, /hljs-comment/);
  assert.match(lines[3], /hljs-keyword/);
});

test('highlightLines aligns one output line per input line', () => {
  const input = 'const a = 1;\n\nfunction f() {\n  return `x${a}`;\n}';

  assert.equal(highlightLines(input).length, input.split('\n').length);
});
