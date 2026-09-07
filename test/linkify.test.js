const test = require('node:test');
const assert = require('node:assert');
const { linkifyCode } = require('../dist/linkify.js');

const targets = new Map([
  ['toElements', { id: 'src/renderer.ts#toElements', change: 'M' }],
  ['edgeBend', { id: 'src/graph-style.ts#edgeBend', change: 'A' }],
  ['esc', { id: 'src/renderer.ts#esc' }],
]);

test('linkifyCode wraps a callee and colours it by its own status', () => {
  const html = linkifyCode('  const els = toElements(g);', targets);

  assert.match(html, /<a class="fn-link fn-modified" data-node="src\/renderer\.ts#toElements">toElements<\/a>/);
  assert.match(html, /const els = /, 'surrounding code survives');
});

test('linkifyCode uses success for added and the plain link colour for unchanged', () => {
  assert.match(linkifyCode('edgeBend(id)', targets), /fn-added/);
  assert.match(linkifyCode('esc(text)', targets), /fn-plain/);
});

test('linkifyCode leaves identifiers that are not callees alone', () => {
  const html = linkifyCode('const result = elements.map(x);', targets);

  assert.equal(html, 'const result = elements.map(x);');
});

test('linkifyCode matches whole identifiers only', () => {
  // A target named `esc` must not match inside `escape` or `unesc`.
  const html = linkifyCode('escape(unesc);', targets);

  assert.equal(html, 'escape(unesc);', 'no partial-word links');
});

test('linkifyCode escapes the code around a link', () => {
  const html = linkifyCode('if (a < b) toElements("<x>");', targets);

  assert.match(html, /a &lt; b/);
  assert.match(html, /&quot;&lt;x&gt;&quot;/);
});

test('a target named like an HTML entity does not corrupt escaping', () => {
  // This is why the raw text is tokenised before escaping: regexing over escaped
  // HTML would match `amp` inside `&amp;` and split the entity.
  const entityish = new Map([['amp', { id: 'x#amp', change: 'M' }]]);
  const html = linkifyCode('a && amp(b)', entityish);

  assert.match(html, /a &amp;&amp; /, 'the && is still a valid entity pair');
  assert.match(html, /data-node="x#amp">amp<\/a>/, 'the real call is still linked');
  assert.doesNotMatch(html, /&<a/, 'the entity was not split open');
});

test('the function itself is coloured but not a link', () => {
  const self = new Map([['render', { id: 'src/renderer.ts#render', change: 'M', self: true }]]);
  const html = linkifyCode('function render(result) {', self);

  assert.match(html, /<span class="fn-self fn-modified">render<\/span>/);
  assert.doesNotMatch(html, /fn-link/);
});
