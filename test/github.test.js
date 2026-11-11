const test = require('node:test');
const assert = require('node:assert');
const { parsePrs, parseComments, reviewPayload, ghError } = require('../dist/github.js');

test('parsePrs flattens gh pr list output', () => {
  const prs = parsePrs(
    JSON.stringify([
      { number: 12, title: 'Add thing', author: { login: 'kim' }, headRefName: 'feat/thing', baseRefName: 'main', isDraft: false },
      { number: 9, title: 'WIP', author: {}, headRefName: 'wip', baseRefName: 'develop', isDraft: true },
    ]),
  );

  assert.deepEqual(prs, [
    { number: 12, title: 'Add thing', author: 'kim', base: 'main', head: 'feat/thing', draft: false },
    { number: 9, title: 'WIP', author: '', base: 'develop', head: 'wip', draft: true },
  ]);
});

test('parseComments reads one comment per line and drops outdated ones', () => {
  const comments = parseComments(
    [
      JSON.stringify({ id: 1, path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'why?', user: 'kim', at: '2026-11-01T00:00:00Z' }),
      // Outdated: the code it was written against has since changed.
      JSON.stringify({ id: 2, path: 'src/a.ts', line: null, side: 'RIGHT', body: 'old', user: 'kim', at: '' }),
      JSON.stringify({ id: 3, path: 'src/a.ts', line: 4, side: 'LEFT', body: 'gone\nnow', user: 'lee', at: '2026-11-02T00:00:00Z' }),
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    comments.map((c) => [c.id, c.line, c.side, c.body]),
    [
      [1, 10, 'RIGHT', 'why?'],
      [3, 4, 'LEFT', 'gone\nnow'],
    ],
  );
});

test('reviewPayload pins the review to the commit and carries every draft', () => {
  const payload = JSON.parse(
    reviewPayload('abc123', 'REQUEST_CHANGES', '  please fix  ', [
      { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'here' },
    ]),
  );

  assert.deepEqual(payload, {
    commit_id: 'abc123',
    event: 'REQUEST_CHANGES',
    body: 'please fix',
    comments: [{ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'here' }],
  });
});

test('reviewPayload leaves out an empty body', () => {
  const payload = JSON.parse(reviewPayload('abc123', 'APPROVE', '  ', []));

  assert.equal('body' in payload, false);
  assert.deepEqual(payload.comments, []);
});

test('ghError adds the reasons GitHub gave to the summary gh printed', () => {
  const text = ghError(
    'gh: Unprocessable Entity (HTTP 422)\n',
    JSON.stringify({ message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] }),
  );

  assert.equal(text, 'Unprocessable Entity (HTTP 422): Can not approve your own pull request');
});

test('ghError copes with no JSON body', () => {
  assert.equal(ghError('gh: Not Found (HTTP 404)', ''), 'Not Found (HTTP 404)');
});
