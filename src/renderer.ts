import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Analysis, FileDiff, Project } from './main';
import type { ChangeStatus } from './git';
import { edgeBend, graphStyle, hashPick, OUTLINES } from './graph-style';
import { HOPS } from './subgraph';

cytoscape.use(fcose);

declare global {
  interface Window {
    diffish: {
      pickProject(): Promise<Project>;
      analyse(opts: { base: string; compare: string }): Promise<Analysis>;
      fileDiff(opts: { base: string; compare: string; file: string }): Promise<FileDiff>;
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
        ? hidden.map((h) => ({ id: `${GHOST_PREFIX}${parent}|${h}`, label: h.split('/').pop() ?? h }))
        : [{ id: `${GHOST_PREFIX}${parent}|+`, label: `+${hidden.length} more` }];

    for (const stub of stubs) {
      out.push({ data: { id: stub.id, label: stub.label, ghost: '1', poly: '0' } });
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
      label: id.split('/').pop() ?? id,
      change: changed[id] ?? '',
      hop: String(hop[id] ?? 0),
      // Which hand-drawn outline this node wears, fixed by path so it is stable.
      poly: String(hashPick(id, OUTLINES.length)),
    },
  }));

  const edges: ElementDefinition[] = Object.entries(g).flatMap(([file, deps]) =>
    deps.map((dep) => {
      const id = `${file}->${dep}`;
      return { data: { id, source: file, target: dep, bend: edgeBend(id) } };
    }),
  );

  return [...nodes, ...edges, ...ghostElements()];
}

function fileList(title: string, files: string[]): string {
  if (files.length === 0) return `<h3>${title} <span class="count">0</span></h3><p class="dim">none</p>`;
  const items = files.map((f) => `<li>${esc(f)}</li>`).join('');
  return `<h3>${title} <span class="count">${files.length}</span></h3><ul>${items}</ul>`;
}

let diffOpen = false;

function setWide(on: boolean) {
  diffOpen = on;
  mainEl.classList.toggle('wide', on);
  // The container just changed width; cytoscape only notices if told.
  cy?.resize();
}

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

function diffTable(rows: Extract<FileDiff, { ok: true }>['rows']): string {
  const cell = (no: number | null, text: string | null, side: 'left' | 'right') =>
    text === null
      ? `<td class="no"></td><td class="code ${side} blank"></td>`
      : `<td class="no">${no ?? ''}</td><td class="code ${side}">${esc(text)}</td>`;

  const body = rows
    .map((row) => {
      if (row.kind === 'gap') {
        // An empty gutter cell first, so the enclosing-declaration text git puts in
        // the @@ header lines up with the code rather than starting in the numbers.
        return `<tr class="gap"><td class="no"></td><td colspan="3">${esc(row.text) || '…'}</td></tr>`;
      }
      if (row.kind === 'context') {
        return `<tr>${cell(row.leftNo, row.text, 'left')}${cell(row.rightNo, row.text, 'right')}</tr>`;
      }
      const cls = [row.left !== null ? 'del' : '', row.right !== null ? 'add' : ''].join(' ').trim();
      return `<tr class="${cls}">${cell(row.leftNo, row.left, 'left')}${cell(row.rightNo, row.right, 'right')}</tr>`;
    })
    .join('');

  // table-layout:fixed takes column widths from the first row — and the first row
  // is usually a colspan=4 hunk header, which would split the table into four equal
  // columns and leave a gutter as wide as the code. A colgroup pins them instead.
  const cols =
    '<colgroup><col class="c-no" /><col class="c-code" /><col class="c-no" /><col class="c-code" /></colgroup>';

  return `<div class="diff-scroll"><table class="diff">${cols}${body}</table></div>`;
}

async function showDiff(file: string) {
  const host = document.getElementById('diff-body');
  if (!host) return;

  host.innerHTML = '<p class="dim">Loading…</p>';
  const result = await window.diffish.fileDiff({
    base: baseSel.value,
    compare: compareSel.value,
    file,
  });

  if (!result.ok) {
    host.innerHTML = `<p class="error">${esc(result.error)}</p>`;
    return;
  }
  host.innerHTML =
    result.rows.length === 0
      ? '<p class="dim">No changes in this file between the selected branches.</p>'
      : diffTable(result.rows);
}

function showGhost(id: string) {
  const [parent, name] = id.slice(GHOST_PREFIX.length).split('|');
  const hidden = ghosts[parent] ?? [];

  panel.innerHTML =
    name === '+'
      ? `<h2>${hidden.length} more connections</h2>
         <p class="dim">Connected to <strong>${esc(parent)}</strong> but outside the ${HOPS}-hop window, so not drawn in full.</p>
         <ul>${hidden.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : `<h2>${esc(name)}</h2>
         <p class="dim">Outside the ${HOPS}-hop window. Connected to <strong>${esc(parent)}</strong>.</p>`;

  if (diffOpen) setWide(false);
}

function showFile(id: string) {
  if (id.startsWith(GHOST_PREFIX)) return showGhost(id);

  const state = changed[id]
    ? `<p><span class="swatch" style="background:${changed[id] === 'A' ? '#2e8b45' : '#e8a020'}"></span> ${CHANGE_LABEL[changed[id]]} in this diff</p>`
    : `<p class="dim">unchanged — ${hop[id] ?? 0} hop(s) from a change</p>`;

  const hasDiff = changed[id] !== undefined;

  panel.innerHTML = `
    <h2>${esc(id)}</h2>
    ${state}
    <button id="open-file">Open file</button>
    ${hasDiff ? '<button id="hide-diff">Hide diff</button>' : ''}
    ${hasDiff ? `<div class="diff-head"><strong>${esc(id)}</strong><span class="dim">${esc(baseSel.value)} … ${esc(compareSel.value)}</span></div>` : ''}
    <div id="diff-body"></div>
    ${fileList('Imports', graph[id] ?? [])}
    ${fileList('Imported by', importersOf(id))}
  `;

  document.getElementById('open-file')?.addEventListener('click', async () => {
    const err = await window.diffish.openFile(id);
    if (err) panel.insertAdjacentHTML('afterbegin', `<p class="error">${esc(err)}</p>`);
  });

  document.getElementById('hide-diff')?.addEventListener('click', () => {
    setWide(false);
    document.getElementById('diff-body')!.innerHTML = '';
    document.querySelector('.diff-head')?.remove();
    (document.getElementById('hide-diff') as HTMLButtonElement).remove();
  });

  // Clicking a changed node in the graph is the whole gesture — the diff opens
  // with it. Unchanged neighbours have nothing to show, so the panel stays narrow.
  if (hasDiff) {
    setWide(true);
    void showDiff(id);
  } else if (diffOpen) {
    setWide(false);
  }
}

function summary(missing: string[]): string {
  const counts = Object.values(changed).reduce<Record<string, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  const legend = `<ul class="legend">
      <li><span class="swatch" style="background:#2e8b45"></span>added ${counts.A ?? 0}</li>
      <li><span class="swatch" style="background:#e8a020"></span>modified ${(counts.M ?? 0) + (counts.R ?? 0)}</li>
      <li><span class="swatch" style="background:#6b7fa8;opacity:.7"></span>related</li>
    </ul>`;

  const deleted =
    missing.length > 0
      ? `<h3>Deleted files <span class="count">${missing.length}</span></h3>
         <p class="dim">Not on the compare branch, so not drawn.</p>
         <ul>${missing.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : '';

  return `${legend}<p class="dim">Click a node for details.</p>${deleted}`;
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

  const elements = toElements(graph);
  const edgeCount = elements.filter((e) => 'source' in e.data).length;
  const nodeCount = elements.length - edgeCount;

  cy?.destroy();
  cy = cytoscape({
    container: cyEl,
    elements,
    style: graphStyle(),
    layout: layoutFor(),
  });

  cy.on('tap', 'node', (evt) => showFile(evt.target.id()));

  const changedCount = Object.keys(changed).length;
  const ghostCount = Object.values(ghosts).reduce((n, list) => n + list.length, 0);
  const real = Object.keys(graph).length;
  status.textContent =
    `${changedCount} changed, ${real - changedCount} related — ${edgeCount} imports` +
    (ghostCount > 0 ? ` · ${ghostCount} hidden` : '');

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
    panel.innerHTML = `<p class="error">${esc(result.error)}</p>`;
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
    panel.innerHTML = `<p class="error">${esc(project.error)}</p><p class="dim">diffish compares two branches, so it needs a git repository.</p>`;
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
