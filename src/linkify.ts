export type LinkTarget = { id: string; change?: 'A' | 'M' | 'D' | 'R' };

const IDENT = /[A-Za-z_$][\w$]*/g;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colour = (t: LinkTarget) =>
  t.change === 'A' ? 'fn-added' : t.change ? 'fn-modified' : 'fn-plain';

const STATUS: Record<string, string> = {
  A: '+ added',
  M: '~ modified',
  D: '\u2212 deleted',
  R: '\u2192 renamed',
};

/** Glyph plus word for a status — the hover tooltip and the reference tags share it. */
export const statusLabel = (t: LinkTarget) => (t.change ? STATUS[t.change] : 'no changes');

const tip = statusLabel;

/** Class suffix for the status colour, shared by tooltips, tags and links. */
export const statusClass = (change?: 'A' | 'M' | 'D' | 'R') =>
  change === 'A' ? 'added' : change ? 'modified' : 'plain';

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
export type LinkHit = { start: number; end: number; target: LinkTarget };

/** Where the links go. Pure, so the matching rules stay testable without a DOM. */
export function findLinks(text: string, targets: Map<string, LinkTarget>): LinkHit[] {
  const hits: LinkHit[] = [];
  if (targets.size === 0) return hits;

  IDENT.lastIndex = 0;
  for (let m = IDENT.exec(text); m !== null; m = IDENT.exec(text)) {
    const target = targets.get(m[0]);
    if (!target) continue;
    const end = m.index + m[0].length;
    // A call site, not a mention in a string, comment or regex.
    if (!/^\s*\(/.test(text.slice(end))) continue;
    hits.push({ start: m.index, end, target });
  }

  return hits;
}

export function linkifyCode(text: string, targets: Map<string, LinkTarget>): string {
  let out = '';
  let last = 0;

  for (const hit of findLinks(text, targets)) {
    out += esc(text.slice(last, hit.start));
    out +=
      `<a class="fn-link ${colour(hit.target)}" data-node="${esc(hit.target.id)}"` +
      ` data-tip="${esc(tip(hit.target))}">${esc(text.slice(hit.start, hit.end))}</a>`;
    last = hit.end;
  }

  return out + esc(text.slice(last));
}

/**
 * Wrap call sites in anchors inside already-highlighted markup.
 *
 * Runs over the element's text nodes, never its HTML, so highlight.js's spans cannot
 * be damaged. The match runs against the concatenated text of all those nodes rather
 * than each node alone: highlight.js wraps a called name in its own span and leaves
 * the "(" outside it, so a per-node lookahead would never find the paren and no link
 * would ever be created.
 */
export function linkifyElement(root: ParentNode, targets: Map<string, LinkTarget>): void {
  if (targets.size === 0) return;

  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text);

  const spans: { node: Text; start: number; end: number }[] = [];
  let full = '';
  for (const node of nodes) {
    spans.push({ node, start: full.length, end: full.length + node.data.length });
    full += node.data;
  }

  const byNode = new Map<Text, LinkHit[]>();
  for (const hit of findLinks(full, targets)) {
    const span = spans.find((s) => hit.start >= s.start && hit.end <= s.end);
    if (!span) continue; // straddles two nodes; leave it rather than mangle the markup
    const local = { ...hit, start: hit.start - span.start, end: hit.end - span.start };
    byNode.set(span.node, [...(byNode.get(span.node) ?? []), local]);
  }

  for (const [node, hits] of byNode) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const hit of hits) {
      if (hit.start > last) frag.append(node.data.slice(last, hit.start));
      const a = document.createElement('a');
      a.className = `fn-link ${colour(hit.target)}`;
      a.dataset.node = hit.target.id;
      a.dataset.tip = tip(hit.target);
      a.textContent = node.data.slice(hit.start, hit.end);
      frag.append(a);
      last = hit.end;
    }
    if (last < node.data.length) frag.append(node.data.slice(last));
    node.replaceWith(frag);
  }
}
