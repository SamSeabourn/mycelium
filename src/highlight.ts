import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';

hljs.registerLanguage('typescript', typescript);

/**
 * Split highlighted HTML into one entry per line, closing and re-opening any spans
 * that straddle the break.
 *
 * highlight.js emits a multi-line construct as a single span with newlines inside it
 * — a JSDoc block comes back as one `<span class="hljs-comment">` covering all its
 * lines. Splitting on "\n" naively would hand the first line an unclosed span and
 * every later line a stray closing tag.
 *
 * Only `<span …>` and `</span>` appear in its output, which is why closing is just a
 * count rather than real tag matching.
 */
export const splitHighlighted = (html: string): string[] => {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  let i = 0;

  while (i < html.length) {
    const ch = html[i];

    if (ch === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) {
        current += html.slice(i);
        break;
      }
      const tag = html.slice(i, gt + 1);
      if (tag.startsWith('</')) {
        open.pop();
      } else {
        open.push(tag);
      }
      current += tag;
      i = gt + 1;
      continue;
    }

    if (ch === '\n') {
      current += '</span>'.repeat(open.length);
      lines.push(current);
      current = open.join('');
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  current += '</span>'.repeat(open.length);
  lines.push(current);
  return lines;
};

/**
 * Highlight a block of code, one array entry per line.
 *
 * tradeoff: the whole block is highlighted together so multi-line comments and
 * template literals keep their context. A diff only carries ±3 lines of context, so
 * a construct opened before the visible slice still starts mid-air — fixing that
 * would mean shipping whole files to the renderer.
 */
export const highlightLines = (text: string): string[] => {
  const html = hljs.highlight(text, { language: 'typescript', ignoreIllegals: true }).value;
  return splitHighlighted(html);
};
