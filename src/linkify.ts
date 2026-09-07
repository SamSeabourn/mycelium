export type LinkTarget = { id: string; change?: 'A' | 'M' | 'D' | 'R'; self?: boolean };

const IDENT = /[A-Za-z_$][\w$]*/g;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colour = (t: LinkTarget) =>
  t.change === 'A' ? 'fn-added' : t.change ? 'fn-modified' : 'fn-plain';

/**
 * Wrap known function names in a line of code so they can be coloured and clicked.
 *
 * Tokenises the RAW text and escapes each piece afterwards, rather than regexing over
 * already-escaped HTML: escaping first would let a function named `amp`, `lt` or
 * `quot` match inside an entity like `&amp;` and corrupt it.
 *
 * tradeoff: the match is lexical, so a name inside a string or comment links too.
 * Fixing that needs the parser's token stream rather than the diff text — not worth
 * the machinery for a link that still points at the right function.
 */
export function linkifyCode(text: string, targets: Map<string, LinkTarget>): string {
  if (targets.size === 0) return esc(text);

  let out = '';
  let last = 0;

  IDENT.lastIndex = 0;
  for (let m = IDENT.exec(text); m !== null; m = IDENT.exec(text)) {
    const target = targets.get(m[0]);
    if (!target) continue;

    out += esc(text.slice(last, m.index));
    out += target.self
      ? `<span class="fn-self ${colour(target)}">${esc(m[0])}</span>`
      : `<a class="fn-link ${colour(target)}" data-node="${esc(target.id)}">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }

  return out + esc(text.slice(last));
}
