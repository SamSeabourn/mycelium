import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Analysis, FileDiff, Project, Source } from './main';
import type { ChangeStatus } from './git';
import { edgeBend, graphStyle } from './graph-style';
import { HOPS } from './subgraph';
import { linkifyElement, statusClass, statusLabel, type LinkTarget } from './linkify';
import { highlightLines } from './highlight';
import { sidesUsed } from './diff';

cytoscape.use(fcose);

declare global {
  interface Window {
    diffish: {
      pickProject(): Promise<Project>;
      analyse(opts: { base: string; compare: string }): Promise<Analysis>;
      fileDiff(opts: {
        base: string;
        compare: string;
        file: string;
        range?: [number, number];
        baseRange?: [number, number];
      }): Promise<FileDiff>;
      source(opts: { compare: string; file: string; range: [number, number] }): Promise<Source>;
      openFile(relative: string): Promise<string>;
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

const CHANGE_LABEL: Record<ChangeStatus, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
};

let cy: Core | null = null;
let graph: Record<string, string[]> = {};
let changed: Record<string, ChangeStatus> = {};
let hop: Record<string, number> = {};
let ghosts: Record<string, string[]> = {};
let label: Record<string, string> = {};
let owner: Record<string, string> = {};
let span: Record<string, [number, number]> = {};
let baseSpan: Record<string, [number, number]> = {};

/** Node ids are "file#name"; the diff view needs the file half. */
const fileOf = (id: string) => owner[id] ?? id;

function importersOf(file: string): string[] {
  return Object.keys(graph).filter((k) => graph[k].includes(file));
}

const GHOST_PREFIX = 'ghost:';
// Past this many hidden neighbours a node would drown in stubs, so they collapse
// into one "+N more" marker instead.
// tradeoff: fixed cap. If a summary stub needs expanding on click, that is the
// upgrade — do it when a real repo makes the aggregate feel opaque.
const GHOST_MAX = 6;

function ghostElements(): ElementDefinition[] {
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
}

function toElements(g: Record<string, string[]>): ElementDefinition[] {
  // Build the node set from keys AND values: a dep that only ever appears as an
  // edge target still needs a node, or cytoscape silently drops the edge.
  const ids = new Set<string>();
  for (const [file, deps] of Object.entries(g)) {
    ids.add(file);
    for (const d of deps) ids.add(d);
  }

  const nodes: ElementDefinition[] = [...ids].map((id) => ({
    data: {
      id,
      label: label[id] ?? id.split('/').pop() ?? id,
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

  return [...nodes, ...edges, ...ghostElements()];
}

type Ref = { id: string; name: string; where?: string; change?: ChangeStatus };

function fileList(title: string, entries: Ref[]): string {
  const count = `<span class="badge badge-sm badge-ghost">${entries.length}</span>`;
  if (entries.length === 0) return `<h3>${title} ${count}</h3><p class="path">none</p>`;

  const items = entries
    .map(
      (e) =>
        `<li><a class="ref" data-node="${esc(e.id)}">` +
        `<span class="tag tag-${statusClass(e.change)}">${esc(statusLabel({ id: e.id, change: e.change }))}</span>` +
        `<span class="ref-name">${esc(e.name)}</span>` +
        (e.where ? `<span class="where">${esc(e.where)}</span>` : '') +
        `</a></li>`,
    )
    .join('');

  return `<h3>${title} ${count}</h3><ul class="list">${items}</ul>`;
}

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

function marchAnts() {
  const selected = cy?.$(':selected');
  if (!selected || selected.empty()) {
    antsFrame = 0;
    return;
  }
  antsOffset -= 0.22;
  selected.style('border-dash-offset', antsOffset);
  antsFrame = requestAnimationFrame(marchAnts);
}

function startAnts() {
  // Same courtesy the CSS pulse gets: the ring still shows, it just holds still.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (antsFrame === 0) antsFrame = requestAnimationFrame(marchAnts);
}

function stopAnts() {
  if (antsFrame !== 0) cancelAnimationFrame(antsFrame);
  antsFrame = 0;
}

function setWide(on: boolean) {
  diffOpen = on;
  mainEl.classList.toggle('wide', on);
  // The container just changed width; cytoscape only notices if told.
  cy?.resize();
}

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
  if (!link?.dataset.tip) return;
  tip.textContent = link.dataset.tip;
  // Border takes the status colour. Read from the link's own class rather than a
  // second data attribute — it already carries the status.
  tip.className = link.classList.contains('fn-added')
    ? 'tip-added'
    : link.classList.contains('fn-modified')
      ? 'tip-modified'
      : 'tip-plain';
  tip.hidden = false;
  placeTip(e);
});

panel.addEventListener('mousemove', (e) => {
  if (!tip.hidden) placeTip(e);
});

panel.addEventListener('mouseout', (e) => {
  const to = (e.relatedTarget as HTMLElement | null)?.closest?.('.fn-link');
  if (!to) tip.hidden = true;
});

// Delegated: the panel's innerHTML is rebuilt on every selection, so a listener bound
// to the links themselves would die with the markup that created it.
panel.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
  const target = link?.dataset.node;
  if (!target || !cy) return;

  const node = cy.$id(target);
  if (node.empty()) return;

  cy.elements().unselect();
  node.select();
  startAnts();
  // Centre it — the target is often off-screen, and without this the graph looks
  // like nothing happened.
  cy.animate({ center: { eles: node }, duration: 200 });
  showFile(target);
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
  if (!divider.hasPointerCapture(e.pointerId)) return;

  // The divider is 6px wide and sits left of the panel, so the panel's width is
  // measured from the divider's centre — without this the bar drifts off the cursor.
  const width = Math.min(
    Math.max(window.innerWidth - e.clientX - divider.offsetWidth / 2, MIN_PANEL),
    window.innerWidth - MIN_GRAPH,
  );
  mainEl.style.setProperty('--panel-w', `${width}px`);

  // Pointer events outrun frames. Coalescing to one resize per frame keeps a fast
  // drag smooth — cytoscape re-renders the whole canvas on every resize() call.
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    cy?.resize();
  });
});

const endDrag = (e: PointerEvent) => {
  if (!divider.hasPointerCapture(e.pointerId)) return;
  divider.releasePointerCapture(e.pointerId);
  divider.classList.remove('dragging');
  document.body.classList.remove('resizing');
  cy?.resize();
};

divider.addEventListener('pointerup', endDrag);
// Without this a cancelled gesture leaves the cursor pinned and text unselectable.
divider.addEventListener('pointercancel', endDrag);

// Double-click restores the automatic width for the current view.
divider.addEventListener('dblclick', () => {
  mainEl.style.removeProperty('--panel-w');
  cy?.resize();
});

/**
 * Names this function calls, keyed by the name as it appears at the call site. Taken
 * from the resolved call graph rather than guessed from the text, so `const` and
 * local variables never become links.
 */
function linkTargets(id: string): Map<string, LinkTarget> {
  const targets = new Map<string, LinkTarget>();

  for (const callee of graph[id] ?? []) {
    const name = label[callee] ?? callee;
    // A method label is "Class.method"; the call site says `method`.
    const bare = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
    targets.set(bare, { id: callee, change: changed[callee] });
  }

  // The function's own name is deliberately left plain: colouring it made the
  // signature look like a link to somewhere, when it is where you already are.
  return targets;
}

function diffTable(rows: Extract<FileDiff, { ok: true }>['rows']): string {
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

  // One-sided slice (an added function, or a purely additive change): a single
  // column, not a column of blanks next to the code.
  if (!sides.left || !sides.right) {
    // Removals only means show the old side; anything else shows the compare side.
    const only: 'left' | 'right' = sides.left && !sides.right ? 'left' : 'right';
    const lines = only === 'right' ? right : left;
    const body = visible
      .map((row, i) => {
        const text = row.kind === 'context' ? row.text : only === 'right' ? row.right : row.left;
        if (text === null) return '';
        const no = only === 'right' ? row.rightNo : row.leftNo;
        const cls = row.kind === 'context' ? '' : only === 'right' ? 'add' : 'del';
        return `<tr class="${cls}"><td class="no">${no ?? ''}</td><td class="code ${only}">${lines[i] ?? ''}</td></tr>`;
      })
      .join('');
    const cols = '<colgroup><col class="c-no" /><col class="c-code-full" /></colgroup>';
    return `<div class="diff-scroll"><table class="diff">${cols}${body}</table></div>`;
  }

  const cell = (no: number | null, html: string | null, side: 'left' | 'right') =>
    html === null
      ? `<td class="no"></td><td class="code ${side} blank"></td>`
      : `<td class="no">${no ?? ''}</td><td class="code ${side}">${html}</td>`;

  const body = visible
    .map((row, i) => {
      if (row.kind === 'context') {
        return `<tr>${cell(row.leftNo, left[i] ?? '', 'left')}${cell(row.rightNo, right[i] ?? '', 'right')}</tr>`;
      }
      const cls = [row.left !== null ? 'del' : '', row.right !== null ? 'add' : ''].join(' ').trim();
      return (
        `<tr class="${cls}">` +
        cell(row.leftNo, row.left === null ? null : left[i] ?? '', 'left') +
        cell(row.rightNo, row.right === null ? null : right[i] ?? '', 'right') +
        '</tr>'
      );
    })
    .join('');

  // table-layout:fixed reads column widths from the first row, which varies; a
  // colgroup pins them regardless of what that row happens to be.
  const cols =
    '<colgroup><col class="c-no" /><col class="c-code" /><col class="c-no" /><col class="c-code" /></colgroup>';
  return `<div class="diff-scroll"><table class="diff">${cols}${body}</table></div>`;
}

async function showSource(id: string) {
  const host = document.getElementById('diff-body');
  const range = span[id];
  if (!host || !range) return;

  host.innerHTML = '<p class="path">Loading…</p>';
  const result = await window.diffish.source({
    compare: compareSel.value,
    file: fileOf(id),
    range,
  });

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
}

async function showDiff(id: string) {
  const host = document.getElementById('diff-body');
  if (!host) return;

  host.innerHTML = '<p class="path">Loading…</p>';
  const result = await window.diffish.fileDiff({
    base: baseSel.value,
    compare: compareSel.value,
    file: fileOf(id),
    // Scope to just this function's lines. Without a span (a node we never parsed)
    // fall back to the whole file rather than showing nothing. baseRange is absent
    // for a new function, which is what keeps its left column clean.
    range: span[id],
    baseRange: baseSpan[id],
  });

  if (!result.ok) {
    host.innerHTML = `<div class="alert alert-error">${esc(result.error)}</div>`;
    return;
  }
  host.innerHTML =
    result.rows.length === 0
      ? '<p class="path">No changes inside this function between the selected branches.</p>'
      : diffTable(result.rows);
  linkifyElement(host, linkTargets(id));
}

function showGhost(id: string) {
  const [parent, name] = id.slice(GHOST_PREFIX.length).split('|');
  const hidden = ghosts[parent] ?? [];

  panel.innerHTML =
    name === '+'
      ? `<h2>${hidden.length} more calls</h2>
         <p class="path">Called by <strong>${esc(label[parent] ?? parent)}</strong> but defined outside the ${HOPS}-hop window, so not drawn in full.</p>
         <ul class="list">${hidden.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : `<h2>${esc(name.includes('#') ? name.slice(name.indexOf('#') + 1) : name)}</h2>
         <p class="path">Defined in <strong>${esc(name.split('#')[0])}</strong>, outside the ${HOPS}-hop window. Called by ${esc(label[parent] ?? parent)}.</p>`;

  if (diffOpen) setWide(false);
}

function showFile(id: string) {
  if (id.startsWith(GHOST_PREFIX)) return showGhost(id);

  const state = changed[id]
    ? `<span class="badge badge-sm ${changed[id] === 'A' ? 'badge-success' : 'badge-warning'}">${CHANGE_LABEL[changed[id]]}</span>`
    : '<span class="badge badge-sm badge-ghost">no changes</span>';

  const hasDiff = changed[id] !== undefined;
  // With no diff there is still a body worth reading, so the panel shows the source.
  const hasSource = !hasDiff && span[id] !== undefined;
  const file = fileOf(id);

  const pretty = (ids: string[]): Ref[] =>
    ids.map((i) => ({ id: i, name: label[i] ?? i, where: owner[i], change: changed[i] }));

  // Header first, on one line: status, file, and what is being compared. The diff
  // follows, and the call relationships sit under it in their own card.
  const head = `
    <div class="head">
      ${state}
      <strong>${esc(file)}</strong>
      ${
        hasDiff || hasSource
          ? `<span class="opacity-60">${hasDiff ? `${esc(baseSel.value)} … ${esc(compareSel.value)}` : esc(compareSel.value)}${span[id] ? ` · lines ${span[id][0]}-${span[id][1]}` : ''}</span>`
          : ''
      }
    </div>`;

  panel.innerHTML = `
    ${head}
    <div id="diff-body"></div>
    <div class="card card-border refs">
      <div class="card-body">
        ${fileList('Calls Internally', pretty(graph[id] ?? []))}
        ${fileList('Callsites', pretty(importersOf(id)))}
      </div>
    </div>
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
}

function summary(missing: string[]): string {
  const counts = Object.values(changed).reduce<Record<string, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  const legend = `<div class="legend">
      <span class="badge badge-sm badge-success">added ${counts.A ?? 0}</span>
      <span class="badge badge-sm badge-warning">modified ${(counts.M ?? 0) + (counts.R ?? 0)}</span>
      <span class="badge badge-sm badge-ghost">related</span>
    </div>`;

  const deleted =
    missing.length > 0
      ? `<h3>Deleted files <span class="badge badge-sm badge-ghost">${missing.length}</span></h3>
         <p class="path">Not on the compare branch, so they have no functions to draw.</p>
         <ul class="list">${missing.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : '';

  return `${legend}<p class="path">Click a node for details.</p>${deleted}`;
}

/**
 * Force-directed. Spreads the map out and copes with cycles, which a layered
 * layout cannot — it also has no roots to layer from once ghost stubs are in.
 */
function layoutFor(): cytoscape.LayoutOptions {
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
    numIter: 3500,
    padding: 40,
  } as cytoscape.LayoutOptions;
}

function render(result: Extract<Analysis, { ok: true }>) {
  graph = result.graph;
  changed = result.changed;
  hop = result.hop;
  ghosts = result.ghosts;
  label = result.label;
  owner = result.file;
  span = result.span;
  baseSpan = result.baseSpan;

  const elements = toElements(graph);
  const edgeCount = elements.filter((e) => 'source' in e.data).length;
  const nodeCount = elements.length - edgeCount;

  stopAnts();
  cy?.destroy();
  cy = cytoscape({
    container: cyEl,
    elements,
    style: graphStyle(),
    layout: layoutFor(),
  });

  cy.on('tap', 'node', (evt) => showFile(evt.target.id()));
  cy.on('select', 'node', startAnts);

  const changedCount = Object.keys(changed).length;
  const ghostCount = Object.values(ghosts).reduce((n, list) => n + list.length, 0);
  const real = Object.keys(graph).length;
  status.textContent =
    `${changedCount} changed, ${real - changedCount} related functions — ${edgeCount} calls` +
    (ghostCount > 0 ? ` · ${ghostCount} out of scope` : '');

  panel.innerHTML = summary(result.missing);
  search.value = '';
}

async function analyse() {
  // No branches means no repo — running git anyway is what dumped its usage screen.
  if (!baseSel.value || !compareSel.value) return;

  status.textContent = 'Analysing…';
  const result = await window.diffish.analyse({
    base: baseSel.value,
    compare: compareSel.value,
  });

  if (!result.ok) {
    status.textContent = 'Nothing to show';
    panel.innerHTML = `<div class="alert alert-error">${esc(result.error)}</div>`;
    cy?.destroy();
    cy = null;
    graph = {};
    return;
  }
  render(result);
}

function fillBranches(all: string[], base: string, current: string) {
  const options = (selected: string) =>
    all
      .map((b) => `<option value="${esc(b)}"${b === selected ? ' selected' : ''}>${esc(b)}</option>`)
      .join('');

  baseSel.innerHTML = options(base);
  compareSel.innerHTML = options(current);
  baseSel.disabled = all.length === 0;
  compareSel.disabled = all.length === 0;
}

openBtn.addEventListener('click', async () => {
  const project = await window.diffish.pickProject();
  if (project === null) return;

  fillBranches(project.branches, project.base, project.current);

  if ('error' in project) {
    // Nothing to diff without git, so stop here rather than run git on a non-repo.
    status.textContent = 'Nothing to show';
    panel.innerHTML = `<div class="alert alert-error">${esc(project.error)}</div><p class="path">diffish compares two branches, so it needs a git repository.</p>`;
    cy?.destroy();
    cy = null;
    graph = {};
    return;
  }

  status.textContent = project.root;
  await analyse();
});

baseSel.addEventListener('change', analyse);
compareSel.addEventListener('change', analyse);

// Visual filter only — never re-runs the layout, so nodes keep their positions.
search.addEventListener('input', () => {
  if (!cy) return;
  const term = search.value.trim().toLowerCase();
  if (!term) {
    cy.elements().removeClass('dimmed');
    return;
  }
  const matches = cy.nodes().filter((n) => n.id().toLowerCase().includes(term));
  cy.elements().addClass('dimmed');
  matches.removeClass('dimmed');
  matches.connectedEdges().removeClass('dimmed');
});
