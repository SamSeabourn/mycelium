export type LinkTarget = { id: string; change?: 'A' | 'M' | 'D' | 'R' };

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
 * Only call sites link — the name has to be followed by `(`. Without that check a
 * name inside a string or comment links too, which in practice means a line like
 * `/not a git repository/i.test(text) ? 'Not a git repository' : text` grows three
 * links to `git`.
 *
 * tradeoff: still lexical, so `foo(` inside a comment or string would link. Passing a
 * function as a value (`map(edgeBend)`) is missed for the same reason. Both need the
 * parser's token stream rather than diff text; the call-site rule removes the noise
 * that actually shows up.
 */
export function linkifyCode(text: string, targets: Map<string, LinkTarget>): string {
  if (targets.size === 0) return esc(text);

  let out = '';
  let last = 0;

  IDENT.lastIndex = 0;
  for (let m = IDENT.exec(text); m !== null; m = IDENT.exec(text)) {
    const target = targets.get(m[0]);
    if (!target) continue;
    // A call site, not a mention in a string, comment or regex.
    if (!/^\s*\(/.test(text.slice(m.index + m[0].length))) continue;

    out += esc(text.slice(last, m.index));
    out += `<a class="fn-link ${colour(target)}" data-node="${esc(target.id)}">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }

  return out + esc(text.slice(last));
}
