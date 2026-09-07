import { linkifyCode, type LinkTarget } from './src/linkify';
const panel = document.getElementById('panel')!;
const targets = new Map<string, LinkTarget>([
  ['edgeBend', { id: 'src/graph-style.ts#edgeBend', change: 'A' }],
  ['toElements', { id: 'src/renderer.ts#toElements', change: 'M' }],
  ['esc', { id: 'src/renderer.ts#esc' }],
]);
panel.innerHTML =
  `<div class="diff-scroll"><table class="diff">
     <colgroup><col class="c-no" /><col class="c-code-full" /></colgroup>
     <tr><td class="no">1</td><td class="code">${linkifyCode('edgeBend(id); toElements(g); esc(t);', targets)}</td></tr>
   </table></div>`;

// Three tooltips at once so all three border colours are visible in one shot.
const mk = (link: HTMLElement, dy: number) => {
  const tip = document.createElement('div');
  tip.id = 'tip';
  tip.textContent = link.dataset.tip!;
  tip.className = link.classList.contains('fn-added')
    ? 'tip-added'
    : link.classList.contains('fn-modified')
      ? 'tip-modified'
      : 'tip-plain';
  document.body.appendChild(tip);
  const r = link.getBoundingClientRect();
  tip.style.left = `${r.left}px`;
  tip.style.top = `${r.bottom + dy}px`;
};
document.querySelectorAll<HTMLElement>('a.fn-link').forEach((l, i) => mk(l, 20 + i * 44));
