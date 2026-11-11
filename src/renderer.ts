import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Analysis, Comments, FileDiff, PickedPr, Progress, Project, Prs, Source, Submitted } from './main';
import type { Draft, Pr, PrComment, ReviewEvent, Side } from './github';
import type { ChangeStatus } from './git';
import { edgeBend, graphStyle } from './graph-style';
import { HOPS } from './subgraph';
import { linkifyElement, statusClass, statusLabel, type LinkTarget } from './linkify';
import { highlightLines } from './highlight';
import { commentable, fadeFor, sidesUsed } from './diff';

cytoscape.use(fcose);

declare global {
  interface Window {
    mycelium: {
      pickProject(): Promise<Project>;
      analyse(opts: { base: string; compare: string; run: number }): Promise<Analysis>;
      onProgress(heard: (p: Progress) => void): void;
      fileDiff(opts: {
        base: string;
        compare: string;
        file: string;
        range?: [number, number];
        baseRange?: [number, number];
        from?: string;
      }): Promise<FileDiff>;
      source(opts: { compare: string; file: string; range: [number, number] }): Promise<Source>;
      prs(): Promise<Prs>;
      pickPr(opts: { number: number; base: string }): Promise<PickedPr>;
      prComments(opts: { number: number }): Promise<Comments>;
      submitReview(opts: {
        number: number;
        sha: string;
        event: ReviewEvent;
        body: string;
        drafts: Draft[];
      }): Promise<Submitted>;
    };
  }
}

/** Everything below builds HTML by hand, so nothing reaches innerHTML unescaped. */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const openBtn = document.getElementById('open-project') as HTMLButtonElement;
const baseSel = document.getElementById('base') as HTMLSelectElement;
const compareSel = document.getElementById('compare') as HTMLSelectElement;
const search = document.getElementById('search') as HTMLInputElement;
const status = document.getElementById('status') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const cyEl = document.getElementById('cy') as HTMLElement;
const mainEl = document.querySelector('main') as HTMLElement;
const modeBranches = document.getElementById('mode-branches') as HTMLButtonElement;
const modePrs = document.getElementById('mode-prs') as HTMLButtonElement;
const byBranch = document.getElementById('by-branch') as HTMLElement;
const byPr = document.getElementById('by-pr') as HTMLElement;
const prSel = document.getElementById('pr') as HTMLSelectElement;
const prRevs = document.getElementById('pr-revs') as HTMLElement;
const reviewBtn = document.getElementById('review') as HTMLButtonElement;
const reviewDialog = document.getElementById('review-dialog') as HTMLDialogElement;
const reviewWhat = document.getElementById('review-what') as HTMLElement;
const reviewBody = document.getElementById('review-body') as HTMLTextAreaElement;
const reviewError = document.getElementById('review-error') as HTMLElement;

const themeBtn = document.getElementById('theme-btn') as HTMLButtonElement;
const themeDialog = document.getElementById('theme-dialog') as HTMLDialogElement;
const themesEl = document.getElementById('themes') as HTMLElement;

const SPINNER = '<span class="spin"></span>';

const graphBusy = document.getElementById('graph-busy') as HTMLElement;
const graphBusyText = document.getElementById('graph-busy-text') as HTMLElement;
const graphBusyBar = document.getElementById('graph-busy-bar') as HTMLProgressElement;
const graphBusyCount = document.getElementById('graph-busy-count') as HTMLElement;

/**
 * Anything slow enough to wonder about. Said twice: in the status line, and over the
 * graph itself, which is where the eyes are and which is otherwise still showing the
 * previous answer as if nothing had been asked.
 */
const busy = (text: string, done?: number, total?: number) => {
  // A count when the work can be counted; otherwise the bar stays away rather than
  // pretend to measure something it cannot.
  const counted = done !== undefined && total !== undefined && total > 0;
  status.innerHTML = `${SPINNER} ${esc(text)}${counted ? ` ${done} / ${total}` : ''}`;
  graphBusyText.textContent = text;
  graphBusyBar.hidden = !counted;
  graphBusyCount.textContent = counted ? `${done} of ${total} files` : '';
  if (counted) {
    graphBusyBar.max = total;
    graphBusyBar.value = done;
  }
  graphBusy.hidden = false;
};

/** Whatever was being waited for has arrived, or failed; the graph is live again. */
const idle = () => {
  graphBusy.hidden = true;
};

/** Let the browser paint what was just changed before the next thing blocks it. */
const painted = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/**
 * The two revisions on screen. Branches mode reads them off the selects; pull request
 * mode gets them from the PR, so nothing else has to know which mode it is in.
 */
let rev = { base: '', compare: '' };
let mode: 'branches' | 'prs' = 'branches';
let prs: Pr[] = [];
/** The pull request under review, with the commit its head was at when fetched. */
let pr: { number: number; sha: string; base: string; compare: string } | null = null;
let comments: PrComment[] = [];
/** Unsent comments per PR number: switching PR or mode must not throw work away. */
const draftsByPr: Record<number, Draft[]> = {};

const drafts = (): Draft[] => (pr ? (draftsByPr[pr.number] ??= []) : []);
const reviewing = () => mode === 'prs' && pr !== null;

const BADGE: Record<ChangeStatus, string> = {
  A: 'badge-success',
  M: 'badge-warning',
  D: 'badge-deleted',
  R: 'badge-warning',
};

const CHANGE_LABEL: Record<ChangeStatus, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
};

let cy: Core | null = null;
let graph: Record<string, string[]> = {};
/** caller -> callees it no longer calls; drawn as dashed red edges */
let removed: Record<string, string[]> = {};
let changed: Record<string, ChangeStatus> = {};
let hop: Record<string, number> = {};
let ghosts: Record<string, string[]> = {};
let label: Record<string, string> = {};
let owner: Record<string, string> = {};
let span: Record<string, [number, number]> = {};
let baseSpan: Record<string, [number, number]> = {};
let renamedFrom: Record<string, string> = {};
/** Names used by more than one drawn function — the only time a path is worth showing. */
let dupes = new Set<string>();

/** Node ids are "file#name"; the diff view needs the file half. */
const fileOf = (id: string) => owner[id] ?? id;

const callersIn = (g: Record<string, string[]>, id: string) => Object.keys(g).filter((k) => g[k].includes(id));

/** The file, but only when the name alone is ambiguous. */
const pathIfDupe = (id: string) => (dupes.has(label[id] ?? '') ? fileOf(id) : '');

const GHOST_PREFIX = 'ghost:';
// Past this many hidden neighbours a node would drown in stubs, so they collapse
// into one "+N more" marker instead.
// tradeoff: fixed cap. If a summary stub needs expanding on click, that is the
// upgrade — do it when a real repo makes the aggregate feel opaque.
const GHOST_MAX = 6;

const ghostElements = (): ElementDefinition[] => {
  const out: ElementDefinition[] = [];

  for (const [parent, hidden] of Object.entries(ghosts)) {
    const stubs =
      hidden.length <= GHOST_MAX
        ? hidden.map((h) => ({
            id: `${GHOST_PREFIX}${parent}|${h}`,
            label: h.includes('#') ? h.slice(h.indexOf('#') + 1) : (h.split('/').pop() ?? h),
          }))
        : [{ id: `${GHOST_PREFIX}${parent}|+`, label: `+${hidden.length} more` }];

    for (const stub of stubs) {
      out.push({ data: { id: stub.id, label: stub.label, ghost: '1' } });
      out.push({
        data: { id: `${stub.id}~edge`, source: parent, target: stub.id, ghost: '1', bend: 0 },
      });
    }
  }

  return out;
};

const toElements = (g: Record<string, string[]>): ElementDefinition[] => {
  // Build the node set from keys AND values: a dep that only ever appears as an
  // edge target still needs a node, or cytoscape silently drops the edge.
  const ids = new Set<string>();
  for (const [file, deps] of Object.entries(g)) {
    ids.add(file);
    for (const d of deps) ids.add(d);
  }
  for (const [file, deps] of Object.entries(removed)) {
    ids.add(file);
    for (const d of deps) ids.add(d);
  }

  const nodes: ElementDefinition[] = [...ids].map((id) => ({
    data: {
      id,
      // Two lines for a clashing name: the path underneath, in the label's faint ink.
      label: (label[id] ?? id) + (pathIfDupe(id) ? `\n${pathIfDupe(id)}` : ''),
      change: changed[id] ?? '',
      hop: String(hop[id] ?? 0),
    },
  }));

  const edges: ElementDefinition[] = Object.entries(g).flatMap(([file, deps]) =>
    deps.map((dep) => {
      const id = `${file}->${dep}`;
      // A call that touches something you changed is the point of the graph, so it
      // is drawn at full strength; everything else is background wiring.
      const direct = changed[file] !== undefined || changed[dep] !== undefined;
      return { data: { id, source: file, target: dep, bend: edgeBend(id), direct: direct ? '1' : '0' } };
    }),
  );

  const gone: ElementDefinition[] = Object.entries(removed).flatMap(([file, deps]) =>
    deps.map((dep) => {
      const id = `${file}-x->${dep}`;
      return { data: { id, source: file, target: dep, bend: edgeBend(id), removed: '1' } };
    }),
  );

  return [...nodes, ...edges, ...gone, ...ghostElements()];
};

type Ref = { id: string; name: string; where?: string; change?: ChangeStatus; gone?: boolean };

const fileList = (title: string, entries: Ref[]): string => {
  const count = `<span class="badge badge-sm badge-ghost">${entries.length}</span>`;
  if (entries.length === 0) {
    return `<h3>${title} ${count}</h3><p class="path">none</p>`;
  }

  const items = entries
    .map(
      (e) =>
        `<li><a class="ref${e.gone ? ' gone' : ''}" data-node="${esc(e.id)}"${e.gone ? ' title="call removed"' : ''}>` +
        `<span class="tag tag-${statusClass(e.change)}">${esc(statusLabel({ id: e.id, change: e.change }))}</span>` +
        `<span class="ref-name">${esc(e.name)}</span>` +
        (e.where ? `<span class="where">${esc(e.where)}</span>` : '') +
        `</a></li>`,
    )
    .join('');

  return `<h3>${title} ${count}</h3><ul class="list">${items}</ul>`;
};

let diffOpen = false;

/**
 * Marching ants on the focused node.
 *
 * cytoscape has no looping animation for a style property, so the dash offset is
 * stepped per frame. The loop stops as soon as nothing is selected rather than
 * burning a frame callback for the life of the app.
 *
 * Roughly 13px/s at 60fps — enough to read as alive without pulling the eye away
 * from the code.
 */
let antsFrame = 0;
let antsOffset = 0;

const marchAnts = () => {
  const selected = cy?.$(':selected');
  if (!selected || selected.empty()) {
    antsFrame = 0;
    return;
  }
  antsOffset -= 0.22;
  selected.style('border-dash-offset', antsOffset);
  antsFrame = requestAnimationFrame(marchAnts);
};

const startAnts = () => {
  // Same courtesy the CSS pulse gets: the ring still shows, it just holds still.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  if (antsFrame === 0) {
    antsFrame = requestAnimationFrame(marchAnts);
  }
};

const stopAnts = () => {
  if (antsFrame !== 0) {
    cancelAnimationFrame(antsFrame);
  }
  antsFrame = 0;
};

/** Graph column width the viewport was last laid out for. */
let graphW = 0;

/**
 * Tell cytoscape the column changed width, keeping what was in the middle in the
 * middle. A bare resize() pins the top-left corner, so widening the panel slid half
 * the map out of view.
 */
const resizeGraph = () => {
  if (!cy) {
    return;
  }
  const w = cyEl.clientWidth;
  cy.resize();
  cy.panBy({ x: (w - graphW) / 2, y: 0 });
  graphW = w;
};

const setWide = (on: boolean) => {
  diffOpen = on;
  mainEl.classList.toggle('wide', on);
  resizeGraph();
};

/** Bring a picked node into view — after the panel has settled on its width. */
const centreOn = (id: string) => {
  const node = cy?.$id(id);
  if (!cy || !node || node.empty()) {
    return;
  }
  cy.animate({ center: { eles: node }, duration: 200 });
};

/**
 * Hover tooltip for diff links.
 *
 * A floating element on <body> rather than DaisyUI's tooltip or a ::before, because
 * both of those are drawn inside the link — and the link lives in `.diff-scroll`,
 * which clips on overflow. The native `title` attribute works but only after about a
 * second of motionless hover, which reads as "no tooltip".
 */
const tip = document.createElement('div');
tip.id = 'tip';
tip.hidden = true;
document.body.appendChild(tip);

const placeTip = (e: MouseEvent) => {
  const pad = 12;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - pad);
  const y = Math.max(e.clientY - tip.offsetHeight - 10, pad);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
};

panel.addEventListener('mouseover', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('.fn-link');
  if (!link?.dataset.tip) {
    tip.hidden = true;
    return;
  }
  tip.textContent = link.dataset.tip;
  // Border takes the status colour. Read from the link's own class rather than a
  // second data attribute — it already carries the status.
  const kind = [...link.classList].find((c) => c.startsWith('fn-') && c !== 'fn-link')?.slice(3);
  tip.className = `tip-${kind ?? 'plain'}`;
  tip.hidden = false;
  placeTip(e);
});

panel.addEventListener('mousemove', (e) => {
  if (!tip.hidden) {
    placeTip(e);
  }
});

panel.addEventListener('mouseout', (e) => {
  const to = (e.relatedTarget as HTMLElement | null)?.closest?.('.fn-link');
  if (!to) {
    tip.hidden = true;
  }
});

// Delegated: the panel's innerHTML is rebuilt on every selection, so a listener bound
// to the links themselves would die with the markup that created it.
panel.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
  const target = link?.dataset.node;
  if (!target || !cy) {
    return;
  }

  const node = cy.$id(target);
  if (node.empty()) {
    return;
  }

  cy.elements().unselect();
  node.select();
  startAnts();
  showFile(target);
  // Centre it — the target is often off-screen, and without this the graph looks
  // like nothing happened.
  centreOn(target);
});

// Drag the divider to size the panel. Pointer capture keeps the events coming even
// when the cursor outruns the 5px strip.
const divider = document.getElementById('divider') as HTMLElement;
const MIN_PANEL = 240;
const MIN_GRAPH = 200;

let resizeQueued = false;

divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('dragging');
  // Suppresses text selection across the panel and pins the cursor for the drag.
  document.body.classList.add('resizing');
  e.preventDefault();
});

divider.addEventListener('pointermove', (e) => {
  if (!divider.hasPointerCapture(e.pointerId)) {
    return;
  }

  // The divider is 6px wide and sits left of the panel, so the panel's width is
  // measured from the divider's centre — without this the bar drifts off the cursor.
  const width = Math.min(
    Math.max(window.innerWidth - e.clientX - divider.offsetWidth / 2, MIN_PANEL),
    window.innerWidth - MIN_GRAPH,
  );
  mainEl.style.setProperty('--panel-w', `${width}px`);

  // Pointer events outrun frames. Coalescing to one resize per frame keeps a fast
  // drag smooth — cytoscape re-renders the whole canvas on every resize() call.
  if (resizeQueued) {
    return;
  }
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    resizeGraph();
  });
});

const endDrag = (e: PointerEvent) => {
  if (!divider.hasPointerCapture(e.pointerId)) {
    return;
  }
  divider.releasePointerCapture(e.pointerId);
  divider.classList.remove('dragging');
  document.body.classList.remove('resizing');
  resizeGraph();
};

divider.addEventListener('pointerup', endDrag);
// Without this a cancelled gesture leaves the cursor pinned and text unselectable.
divider.addEventListener('pointercancel', endDrag);

// Double-click restores the automatic width for the current view.
divider.addEventListener('dblclick', () => {
  mainEl.style.removeProperty('--panel-w');
  resizeGraph();
});

/**
 * Names this function calls, keyed by the name as it appears at the call site. Taken
 * from the resolved call graph rather than guessed from the text, so `const` and
 * local variables never become links.
 */
const linkTargets = (id: string): Map<string, LinkTarget> => {
  const targets = new Map<string, LinkTarget>();

  for (const callee of [...(graph[id] ?? []), ...(removed[id] ?? [])]) {
    const name = label[callee] ?? callee;
    // A method label is "Class.method"; the call site says `method`.
    const bare = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
    targets.set(bare, { id: callee, change: changed[callee] });
  }

  // The function's own name is deliberately left plain: colouring it made the
  // signature look like a link to somewhere, when it is where you already are.
  return targets;
};

const diffTable = (rows: Extract<FileDiff, { ok: true }>['rows'], review = false): string => {
  // Highlight each side as one block, not line by line: a JSDoc comment or template
  // literal spanning several lines only colours correctly with its own context.
  const visible = rows.filter((r) => r.kind !== 'gap');
  const side = (pick: 'left' | 'right') =>
    highlightLines(
      visible
        .map((r) => (r.kind === 'context' ? r.text : (pick === 'left' ? r.left : r.right) ?? ''))
        .join('\n'),
    );
  const left = side('left');
  const right = side('right');

  const sides = sidesUsed(rows);
  const fade = fadeFor(visible);
  const ctx = (i: number) => `class="ctx" style="--fade:${fade[i]}"`;

  // Every numbered gutter cell says which line of which side it is: that is where an
  // existing comment hangs, and what a new one is sent with. `can` marks the ones
  // GitHub will take a comment on.
  const can = review ? commentable(visible) : [];
  const gutter = (n: number | null, pick: 'left' | 'right', i: number, offer = true) =>
    n === null
      ? '<td class="no"></td>'
      : `<td class="no${offer && can[i] ? ' can' : ''}" data-line="${n}" data-side="${pick === 'left' ? 'LEFT' : 'RIGHT'}">${n}</td>`;

  // One-sided slice (an added function, or a purely additive change): a single
  // column, not a column of blanks next to the code.
  if (!sides.left || !sides.right) {
    // Removals only means show the old side; anything else shows the compare side.
    const only: 'left' | 'right' = sides.left && !sides.right ? 'left' : 'right';
    const lines = only === 'right' ? right : left;
    const body = visible
      .map((row, i) => {
        const text = row.kind === 'context' ? row.text : only === 'right' ? row.right : row.left;
        if (text === null) {
          return '';
        }
        const no = only === 'right' ? row.rightNo : row.leftNo;
        const attrs = row.kind === 'context' ? ctx(i) : `class="${only === 'right' ? 'add' : 'del'}"`;
        return `<tr ${attrs}>${gutter(no, only, i)}<td class="code ${only}">${lines[i] ?? ''}</td></tr>`;
      })
      .join('');
    const cols = '<colgroup><col class="c-no" /><col class="c-code-full" /></colgroup>';
    return `<div class="diff-scroll"><table class="diff">${cols}${body}</table></div>`;
  }

  const cell = (no: number | null, html: string | null, side: 'left' | 'right', i: number, offer = true) =>
    html === null
      ? `<td class="no"></td><td class="code ${side} blank"></td>`
      : `${gutter(no, side, i, offer)}<td class="code ${side}">${html}</td>`;

  const body = visible
    .map((row, i) => {
      if (row.kind === 'context') {
        // An unchanged line is one line; offering it twice would be two ways to say
        // the same thing, so the comment goes on the compare side.
        return `<tr ${ctx(i)}>${cell(row.leftNo, left[i] ?? '', 'left', i, false)}${cell(row.rightNo, right[i] ?? '', 'right', i)}</tr>`;
      }
      const cls = [row.left !== null ? 'del' : '', row.right !== null ? 'add' : ''].join(' ').trim();
      return (
        `<tr class="${cls}">` +
        cell(row.leftNo, row.left === null ? null : left[i] ?? '', 'left', i) +
        cell(row.rightNo, row.right === null ? null : right[i] ?? '', 'right', i) +
        '</tr>'
      );
    })
    .join('');

  // table-layout:fixed reads column widths from the first row, which varies; a
  // colgroup pins them regardless of what that row happens to be.
  const cols =
    '<colgroup><col class="c-no" /><col class="c-code" /><col class="c-no" /><col class="c-code" /></colgroup>';
  return `<div class="diff-scroll"><table class="diff">${cols}${body}</table></div>`;
};

const LOADING = '<p class="path"><span class="spin"></span></p>';

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

/**
 * Hang comments under the lines they are about: what is already on the pull request,
 * then whatever is drafted and not yet sent. Rebuilt from state each time, so adding
 * or dropping a draft is one call rather than surgery on the table.
 */
const showThreads = (host: HTMLElement) => {
  for (const old of host.querySelectorAll('tr.thread')) {
    old.remove();
  }
  const path = host.dataset.path;
  if (!reviewing() || !path) {
    return;
  }

  const width = host.querySelector('col.c-code') ? 4 : 2;
  const posted = comments.filter((c) => c.path === path).sort((a, b) => a.at.localeCompare(b.at));

  for (const cell of host.querySelectorAll<HTMLElement>('td.no[data-line]')) {
    const at = (c: { line: number; side: Side }) =>
      String(c.line) === cell.dataset.line && c.side === cell.dataset.side;

    const items = [
      ...posted
        .filter(at)
        .map(
          (c) =>
            `<div class="comment"><div class="who"><strong>${esc(c.user)}</strong> ${esc(when(c.at))}</div>${esc(c.body)}</div>`,
        ),
      ...drafts().flatMap((d, i) =>
        d.path === path && at(d)
          ? [
              `<div class="comment pending"><div class="who"><span class="badge badge-sm badge-warning">pending</span>` +
                `<a class="drop" data-drop="${i}">remove</a></div>${esc(d.body)}</div>`,
            ]
          : [],
      ),
    ];

    if (items.length > 0) {
      cell.parentElement?.insertAdjacentHTML(
        'afterend',
        `<tr class="thread"><td colspan="${width}">${items.join('')}</td></tr>`,
      );
    }
  }
};

const showReviewButton = () => {
  reviewBtn.hidden = !reviewing();
  const n = drafts().length;
  reviewBtn.textContent = n > 0 ? `Review (${n})` : 'Review';
};

// Drafting a comment. Delegated for the same reason as the node links below: the
// table these clicks land on is rebuilt on every selection.
panel.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const host = document.getElementById('diff-body');
  if (!host || !reviewing()) {
    return;
  }

  const drop = el.closest<HTMLElement>('[data-drop]');
  if (drop) {
    drafts().splice(Number(drop.dataset.drop), 1);
    showThreads(host);
    showReviewButton();
    return;
  }

  const line = el.closest<HTMLElement>('td.no.can');
  if (line) {
    host.querySelector('tr.draft')?.remove();
    const width = host.querySelector('col.c-code') ? 4 : 2;
    line.parentElement?.insertAdjacentHTML(
      'afterend',
      `<tr class="draft" data-line="${line.dataset.line}" data-side="${line.dataset.side}"><td colspan="${width}">` +
        `<textarea class="textarea textarea-sm" rows="3" placeholder="Comment on line ${line.dataset.line}"></textarea>` +
        `<div class="actions"><button class="btn btn-xs btn-primary" data-add>Add to review</button>` +
        `<button class="btn btn-xs btn-ghost" data-cancel>Cancel</button></div></td></tr>`,
    );
    host.querySelector<HTMLTextAreaElement>('tr.draft textarea')?.focus();
    return;
  }

  const form = el.closest<HTMLElement>('tr.draft');
  if (!form) {
    return;
  }
  if (el.closest('[data-add]')) {
    const body = form.querySelector('textarea')?.value.trim() ?? '';
    if (!body || !host.dataset.path) {
      return;
    }
    drafts().push({
      path: host.dataset.path,
      line: Number(form.dataset.line),
      side: form.dataset.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      body,
    });
    form.remove();
    showThreads(host);
    showReviewButton();
  } else if (el.closest('[data-cancel]')) {
    form.remove();
  }
});

const showSource = async (id: string) => {
  const host = document.getElementById('diff-body');
  const range = span[id];
  if (!host || !range) {
    return;
  }

  host.innerHTML = LOADING;
  const result: Source = await window.mycelium
    .source({ compare: rev.compare, file: fileOf(id), range })
    .catch((e: Error) => ({ ok: false, error: `Could not read the source: ${e.message}` }));

  if (!result.ok) {
    host.innerHTML = `<div class="alert alert-error">${esc(result.error)}</div>`;
    return;
  }

  const highlighted = highlightLines(result.lines.map((l) => l.text).join('\n'));
  const body = result.lines
    .map(
      (l, i) =>
        `<tr><td class="no">${l.no}</td><td class="code">${highlighted[i] ?? ''}</td></tr>`,
    )
    .join('');
  const cols = '<colgroup><col class="c-no" /><col class="c-code-full" /></colgroup>';
  host.innerHTML = `<div class="diff-scroll"><table class="diff">${cols}${body}</table></div>`;
  linkifyElement(host, linkTargets(id));
};

const showDiff = async (id: string) => {
  const host = document.getElementById('diff-body');
  if (!host) {
    return;
  }

  host.innerHTML = LOADING;
  // A throw in main rejects this call; uncaught, the spinner would turn forever.
  const result: FileDiff = await window.mycelium
    .fileDiff({
      base: rev.base,
      compare: rev.compare,
      file: fileOf(id),
      // Scope to just this function's lines. Without a span (a node we never parsed)
      // fall back to the whole file rather than showing nothing. baseRange is absent
      // for a new function, which is what keeps its left column clean.
      range: span[id],
      baseRange: baseSpan[id],
      from: renamedFrom[fileOf(id)],
    })
    .catch((e: Error) => ({ ok: false, error: `Could not load the diff: ${e.message}` }));

  if (!result.ok) {
    host.innerHTML = `<div class="alert alert-error">${esc(result.error)}</div>`;
    return;
  }
  host.innerHTML =
    result.rows.length === 0
      ? '<p class="path">No changes inside this function between the selected branches.</p>'
      : diffTable(result.rows, reviewing());
  linkifyElement(host, linkTargets(id));
  // After linkify, which walks every text node: a function name in someone's comment
  // is prose, not a call site.
  host.dataset.path = fileOf(id);
  showThreads(host);
};

const showGhost = (id: string) => {
  const [parent, name] = id.slice(GHOST_PREFIX.length).split('|');
  const hidden = ghosts[parent] ?? [];

  panel.innerHTML =
    name === '+'
      ? `<h2>${hidden.length} more calls</h2>
         <p class="path">Called by <strong>${esc(label[parent] ?? parent)}</strong> but defined outside the ${HOPS}-hop window, so not drawn in full.</p>
         <ul class="list">${hidden.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : `<h2>${esc(name.includes('#') ? name.slice(name.indexOf('#') + 1) : name)}</h2>
         <p class="path">Defined in <strong>${esc(name.split('#')[0])}</strong>, outside the ${HOPS}-hop window. Called by ${esc(label[parent] ?? parent)}.</p>`;

  if (diffOpen) {
    setWide(false);
  }
};

const showFile = (id: string) => {
  // The panel is about to be rebuilt; a link removed from under the cursor never
  // gets a mouseout, so its tooltip would otherwise stay on screen.
  tip.hidden = true;
  if (id.startsWith(GHOST_PREFIX)) {
    return showGhost(id);
  }

  const state = changed[id]
    ? `<span class="badge badge-sm ${BADGE[changed[id]]}">${CHANGE_LABEL[changed[id]]}</span>`
    : '<span class="badge badge-sm badge-ghost">no changes</span>';

  const hasDiff = changed[id] !== undefined;
  // With no diff there is still a body worth reading, so the panel shows the source.
  const hasSource = !hasDiff && span[id] !== undefined;
  const pretty = (ids: string[], gone = false): Ref[] =>
    ids.map((i) => ({ id: i, name: label[i] ?? i, where: pathIfDupe(i), change: changed[i], gone }));

  // The function is the subject: status and name. Its file only appears when another
  // drawn function shares the name.
  const where = pathIfDupe(id);
  const head = `
    <div class="head">
      <strong>${esc(label[id] ?? id)}</strong>
      ${state}
      ${where ? `<span class="where">${esc(where)}</span>` : ''}
      ${
        hasDiff || hasSource
          ? `<span class="opacity-60">${hasDiff ? `${esc(rev.base)} … ${esc(rev.compare)}` : esc(rev.compare)}</span>`
          : ''
      }
    </div>`;

  panel.innerHTML = `
    ${head}
    <div class="card card-border refs">
      <div class="card-body">
        <div>${fileList('Calls Internally', [...pretty(graph[id] ?? []), ...pretty(removed[id] ?? [], true)])}</div>
        <div>${fileList('Callsites', [...pretty(callersIn(graph, id)), ...pretty(callersIn(removed, id), true)])}</div>
      </div>
    </div>
    <div id="diff-body"></div>
  `;

  // Clicking a changed node in the graph is the whole gesture — the diff opens
  // with it. Unchanged neighbours have nothing to show, so the panel stays narrow.
  if (hasDiff) {
    setWide(true);
    void showDiff(id);
  } else if (hasSource) {
    setWide(true);
    void showSource(id);
  } else if (diffOpen) {
    setWide(false);
  }
};

const summary = (): string => {
  const counts = Object.values(changed).reduce<Record<string, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  const legend = `<div class="legend">
      <span class="badge badge-sm badge-success">added ${counts.A ?? 0}</span>
      <span class="badge badge-sm badge-warning">modified ${(counts.M ?? 0) + (counts.R ?? 0)}</span>
      <span class="badge badge-sm badge-deleted">deleted ${counts.D ?? 0}</span>
      <span class="badge badge-sm badge-ghost">related</span>
    </div>`;

  return `${legend}<p class="path">Click a function for details.</p>`;
};

/** mulberry32 — a tiny deterministic PRNG, enough to make a layout repeatable. */
const seeded = (seed: number): () => number => {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Force-directed. Spreads the map out and copes with cycles, which a layered
 * layout cannot — it also has no roots to layer from once ghost stubs are in.
 */
const layoutFor = (): cytoscape.LayoutOptions => {
  // tradeoff: quality:'proof' is the slow setting and gets heavy past ~2000 nodes.
  // Upgrade path: drop to 'default' on large graphs, then collapse by folder.
  return {
    name: 'fcose',
    animate: false,
    randomize: true,
    // fcose handles hub-and-spoke properly, which built-in cose does not: it gives
    // the hub itself room rather than only fanning its leaves.
    quality: 'proof',
    nodeSeparation: 190,
    idealEdgeLength: 140,
    nodeRepulsion: 45000,
    edgeElasticity: 0.3,
    gravity: 0.2,
    gravityRange: 4.5,
    // Disconnected pieces get packed instead of flung out, so fit() stays close in.
    packComponents: true,
    // Labels are far wider than the dots; without this, packed loners sit a dot's
    // width apart and their names print over each other.
    nodeDimensionsIncludeLabels: true,
    numIter: 3500,
    padding: 40,
  } as cytoscape.LayoutOptions;
};

const render = (result: Extract<Analysis, { ok: true }>) => {
  graph = result.graph;
  removed = result.removed;
  changed = result.changed;
  hop = result.hop;
  ghosts = result.ghosts;
  label = result.label;
  owner = result.file;
  span = result.span;
  baseSpan = result.baseSpan;
  renamedFrom = result.from;

  const seen = new Set<string>();
  dupes = new Set<string>();
  for (const name of Object.values(label)) (seen.has(name) ? dupes : seen).add(name);

  const elements = toElements(graph);
  const edgeCount = elements.filter((e) => 'source' in e.data).length;
  const nodeCount = elements.length - edgeCount;

  stopAnts();
  cy?.destroy();
  // fcose has no seed option and draws its start positions from Math.random, so the
  // same diff laid out differently every run. Seeding it keeps the map where you left
  // it. The layout runs synchronously (animate: false), so the swap is scoped to it.
  // tradeoff: global Math.random swap; drop it if fcose ever grows a seed option.
  const random = Math.random;
  Math.random = seeded(1);
  try {
    cy = cytoscape({
      container: cyEl,
      elements,
      style: graphStyle(),
      layout: layoutFor(),
    });
  } finally {
    Math.random = random;
  }
  graphW = cyEl.clientWidth;

  cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    showFile(id);
    centreOn(id);
  });
  cy.on('select', 'node', startAnts);

  const changedCount = Object.keys(changed).length;
  const ghostCount = Object.values(ghosts).reduce((n, list) => n + list.length, 0);
  const real = Object.keys(graph).length;
  status.textContent =
    `${changedCount} changed, ${real - changedCount} related functions — ${edgeCount} calls` +
    (ghostCount > 0 ? ` · ${ghostCount} out of scope` : '');

  panel.innerHTML = summary();
  search.value = '';
};

/** Every theme DaisyUI ships, in the order its own site shows them. */
const THEMES = [
  'light', 'dark', 'cupcake', 'bumblebee', 'emerald',
  'corporate', 'synthwave', 'retro', 'cyberpunk', 'valentine',
  'halloween', 'garden', 'forest', 'aqua', 'lofi',
  'pastel', 'fantasy', 'wireframe', 'black', 'luxury',
  'dracula', 'cmyk', 'autumn', 'business', 'acid',
  'lemonade', 'night', 'coffee', 'winter', 'dim',
  'nord', 'sunset', 'caramellatte', 'abyss', 'silk',
];

const setTheme = (name: string) => {
  if (!THEMES.includes(name)) {
    return;
  }
  document.documentElement.dataset.theme = name;
  try {
    localStorage.setItem('theme', name);
  } catch {
    // Storage can be unavailable; the theme still applies for this session.
  }
  // The canvas holds colours, not variables: it has to be told the theme moved.
  cy?.style(graphStyle());
  for (const pick of themesEl.querySelectorAll<HTMLElement>('.theme-pick')) {
    pick.classList.toggle('on', pick.dataset.pick === name);
  }
};

// A painter's palette per theme: the board is the theme's page colour, the four blobs
// its primary, secondary, accent and neutral. Only the icon carries data-theme, so the
// name underneath stays in the colours of the theme you are actually in.
const DOTS: [string, number, number][] = [
  ['primary', 13.5, 6.5],
  ['secondary', 17.5, 10.5],
  ['accent', 8.5, 7.5],
  ['neutral', 6.5, 12.5],
];

themesEl.innerHTML = THEMES.map(
  (t) =>
    `<button type="button" class="theme-pick" data-pick="${t}">` +
    `<svg data-theme="${t}" viewBox="0 0 24 24" width="56" height="56" aria-hidden="true">` +
    '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />' +
    DOTS.map(([c, x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" style="fill:var(--color-${c})" />`).join('') +
    `</svg><span>${t}</span></button>`,
).join('');

themesEl.addEventListener('click', (e) => {
  const pick = (e.target as HTMLElement).closest<HTMLElement>('.theme-pick');
  if (pick?.dataset.pick) {
    setTheme(pick.dataset.pick);
  }
});

themeBtn.addEventListener('click', () => themeDialog.showModal());

let savedTheme: string | null = null;
try {
  savedTheme = localStorage.getItem('theme');
} catch {
  // No storage, no memory: start on the default.
}
setTheme(savedTheme && THEMES.includes(savedTheme) ? savedTheme : 'retro');

let analyseRun = 0;

// Main reports each stage of an analysis as it reaches it. Only the newest run speaks:
// an abandoned one is still finishing in the background and would otherwise argue.
window.mycelium?.onProgress((p) => {
  if (p.run === analyseRun) {
    busy(p.text, p.done, p.total);
  }
});

const analyse = async () => {
  // No branches means no repo — running git anyway is what dumped its usage screen.
  if (!rev.base || !rev.compare) {
    idle();
    return;
  }

  busy('Analysing…');
  const run = ++analyseRun;
  // A throw in main rejects this call. Without the catch the status sat on
  // "Analysing…" forever with no hint that anything had failed.
  const result: Analysis = await window.mycelium
    .analyse({ ...rev, run })
    .catch((e: Error) => ({ ok: false, error: `Analysis failed: ${e.message}` }));
  // A newer pick started while this one ran; its answer is the one to show.
  if (run !== analyseRun) {
    return;
  }

  if (!result.ok) {
    status.textContent = 'Nothing to show';
    panel.innerHTML = `<div class="alert alert-error">${esc(result.error)}</div>`;
    cy?.destroy();
    cy = null;
    graph = {};
    idle();
    return;
  }

  // The layout runs in one synchronous go and holds the window still while it does:
  // on a big diff that is most of the wait. Say so first, and give the words a frame
  // to reach the screen.
  busy('Drawing the graph…');
  await painted();
  if (run !== analyseRun) {
    return;
  }
  render(result);
  idle();
};

const fillBranches = (all: string[], base: string, current: string) => {
  const options = (selected: string) =>
    all
      .map((b) => `<option value="${esc(b)}"${b === selected ? ' selected' : ''}>${esc(b)}</option>`)
      .join('');

  baseSel.innerHTML = options(base);
  compareSel.innerHTML = options(current);
  baseSel.disabled = all.length === 0;
  compareSel.disabled = all.length === 0;
};

const showMode = () => {
  modeBranches.classList.toggle('tab-active', mode === 'branches');
  modePrs.classList.toggle('tab-active', mode === 'prs');
  byBranch.hidden = mode !== 'branches';
  byPr.hidden = mode !== 'prs';
  showReviewButton();
};

const analyseBranches = () => {
  rev = { base: baseSel.value, compare: compareSel.value };
  return analyse();
};

let prRun = 0;

const pickPr = async (number: number) => {
  const meta = prs.find((p) => p.number === number);
  if (!meta) {
    return;
  }

  busy(`Fetching #${number}…`);
  const run = ++prRun;
  const [picked, found] = await Promise.all([
    window.mycelium
      .pickPr({ number, base: meta.base })
      .catch((e: Error): PickedPr => ({ ok: false, error: `Could not fetch the pull request: ${e.message}` })),
    window.mycelium.prComments({ number }).catch((e: Error): Comments => ({ ok: false, error: e.message })),
  ]);
  // Another PR, or another mode, was picked while this one was on its way.
  if (run !== prRun) {
    return;
  }

  if (!picked.ok) {
    status.textContent = 'Nothing to show';
    panel.innerHTML = `<div class="alert alert-error">${esc(picked.error)}</div>`;
    idle();
    return;
  }

  pr = { number, sha: picked.sha, base: picked.base, compare: picked.compare };
  comments = found.ok ? found.comments : [];
  rev = { base: picked.base, compare: picked.compare };
  // A review without the existing conversation is still a review; say it is missing
  // rather than refuse to open the PR.
  prRevs.textContent = `${picked.base} ← ${meta.head}${found.ok ? '' : ' · comments unavailable'}`;
  prRevs.title = found.ok ? '' : found.error;
  showReviewButton();
  await analyse();
};

modeBranches.addEventListener('click', () => {
  mode = 'branches';
  prRun++;
  showMode();
  void analyseBranches();
});

modePrs.addEventListener('click', () => {
  mode = 'prs';
  showMode();
  if (pr) {
    // Back to the PR that was open, at the commit it was fetched at.
    rev = { base: pr.base, compare: pr.compare };
    void analyse();
  }
});

prSel.addEventListener('change', () => {
  if (prSel.value) {
    void pickPr(Number(prSel.value));
  }
});

let projectRun = 0;

/** Ask gh what is open. Never holds up the graph: branches work without GitHub. */
const loadPrs = async () => {
  const run = ++projectRun;
  modePrs.disabled = true;
  modePrs.title = 'Looking for pull requests…';
  const found: Prs = await window.mycelium.prs().catch((e: Error) => ({ ok: false, error: e.message }));
  if (run !== projectRun) {
    return;
  }

  prs = found.ok ? found.prs : [];
  modePrs.disabled = prs.length === 0;
  modePrs.title = found.ok ? (prs.length === 0 ? 'No open pull requests' : '') : found.error;
  prSel.innerHTML =
    '<option value="">Pick a pull request…</option>' +
    prs
      .map(
        (p) =>
          `<option value="${p.number}">#${p.number} ${esc(p.title)} · ${esc(p.author)}${p.draft ? ' (draft)' : ''}</option>`,
      )
      .join('');
};

reviewBtn.addEventListener('click', () => {
  if (!pr) {
    return;
  }
  const meta = prs.find((p) => p.number === pr?.number);
  const n = drafts().length;
  reviewWhat.textContent = `#${pr.number} ${meta?.title ?? ''} — ${n} line comment${n === 1 ? '' : 's'}`;
  reviewError.innerHTML = '';
  reviewDialog.showModal();
});

reviewDialog.addEventListener('click', async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-event]');
  const target = pr;
  if (!button || !target) {
    return;
  }

  const buttons = reviewDialog.querySelectorAll<HTMLButtonElement>('button');
  for (const b of buttons) {
    b.disabled = true;
  }
  reviewError.innerHTML = `<p class="path">${SPINNER} Sending to GitHub…</p>`;

  const sent: Submitted = await window.mycelium
    .submitReview({
      number: target.number,
      sha: target.sha,
      event: button.dataset.event as ReviewEvent,
      body: reviewBody.value,
      drafts: draftsByPr[target.number] ?? [],
    })
    .catch((e: Error) => ({ ok: false, error: e.message }));

  for (const b of buttons) {
    b.disabled = false;
  }

  if (!sent.ok) {
    // The drafts stay exactly as they were: a rejected review is not a lost one.
    reviewError.innerHTML = `<div class="alert alert-error">${esc(sent.error)}</div>`;
    return;
  }

  draftsByPr[target.number] = [];
  reviewBody.value = '';
  reviewError.innerHTML = '';
  reviewDialog.close();

  const found = await window.mycelium.prComments({ number: target.number }).catch(() => null);
  // Only if that PR is still the one on screen.
  if (found?.ok && pr?.number === target.number) {
    comments = found.comments;
  }
  showReviewButton();
  const host = document.getElementById('diff-body');
  if (host) {
    showThreads(host);
  }
});

openBtn.addEventListener('click', async () => {
  const before = status.innerHTML;
  // Covers the folder dialog too, but mostly the fetch behind it, which can take a
  // while on a slow remote and used to look like a hang.
  busy('Opening…');
  const project = await window.mycelium.pickProject().catch(() => null);
  if (project === null) {
    status.innerHTML = before;
    idle();
    return;
  }

  fillBranches(project.branches, project.base, project.current);

  // A new project: nothing about the last one's pull requests carries over.
  mode = 'branches';
  pr = null;
  prs = [];
  comments = [];
  prRun++;
  prRevs.textContent = '';
  prSel.innerHTML = '';
  modePrs.disabled = true;
  showMode();

  if ('error' in project) {
    // Nothing to diff without git, so stop here rather than run git on a non-repo.
    projectRun++;
    modePrs.title = project.error;
    status.textContent = 'Nothing to show';
    panel.innerHTML = `<div class="alert alert-error">${esc(project.error)}</div><p class="path">mycelium compares two branches, so it needs a git repository.</p>`;
    cy?.destroy();
    cy = null;
    graph = {};
    idle();
    return;
  }

  void loadPrs();
  await analyseBranches();
});

baseSel.addEventListener('change', analyseBranches);
compareSel.addEventListener('change', analyseBranches);

// Visual filter only — never re-runs the layout, so nodes keep their positions.
search.addEventListener('input', () => {
  if (!cy) {
    return;
  }
  const term = search.value.trim().toLowerCase();
  if (!term) {
    cy.elements().removeClass('dimmed');
    return;
  }
  // The name only — matching the id would light up every function in a file whose
  // path happens to contain the term.
  const matches = cy.nodes().filter((n) => (label[n.id()] ?? '').toLowerCase().includes(term));
  cy.elements().addClass('dimmed');
  matches.removeClass('dimmed');
  matches.connectedEdges().removeClass('dimmed');
});
