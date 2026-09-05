import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import type { Analysis, FileDiff, Project } from './main';
import type { ChangeStatus } from './git';

declare global {
  interface Window {
    diffish: {
      pickProject(): Promise<Project>;
      analyse(opts: { mode: 'diff' | 'repo' | 'functions'; base: string; compare: string }): Promise<Analysis>;
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
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
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
let label: Record<string, string> = {};
let owner: Record<string, string> = {};

const mode = () => (modeInputs.find((i) => i.checked)?.value ?? 'diff') as 'diff' | 'repo' | 'functions';

/** File nodes are their own path; function nodes carry theirs separately. */
const fileOf = (id: string) => owner[id] ?? id;

function importersOf(file: string): string[] {
  return Object.keys(graph).filter((k) => graph[k].includes(file));
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
    deps.map((dep) => ({ data: { id: `${file}->${dep}`, source: file, target: dep } })),
  );

  return [...nodes, ...edges];
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
  setTimeout(() => cy?.resize(), 160);
}

function diffTable(rows: Extract<FileDiff, { ok: true }>['rows']): string {
  const cell = (no: number | null, text: string | null, side: 'left' | 'right') =>
    text === null
      ? `<td class="no"></td><td class="code ${side} blank"></td>`
      : `<td class="no">${no ?? ''}</td><td class="code ${side}">${esc(text)}</td>`;

  const body = rows
    .map((row) => {
      if (row.kind === 'gap') {
        return `<tr class="gap"><td colspan="4">${esc(row.text) || '…'}</td></tr>`;
      }
      if (row.kind === 'context') {
        return `<tr>${cell(row.leftNo, row.text, 'left')}${cell(row.rightNo, row.text, 'right')}</tr>`;
      }
      const cls = [row.left !== null ? 'del' : '', row.right !== null ? 'add' : ''].join(' ').trim();
      return `<tr class="${cls}">${cell(row.leftNo, row.left, 'left')}${cell(row.rightNo, row.right, 'right')}</tr>`;
    })
    .join('');

  return `<div class="diff-scroll"><table class="diff">${body}</table></div>`;
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

function showFile(id: string) {
  const state = changed[id]
    ? `<p><span class="swatch" style="background:${changed[id] === 'A' ? '#3fb950' : '#d29922'}"></span> ${CHANGE_LABEL[changed[id]]} in this diff</p>`
    : `<p class="dim">unchanged — ${hop[id] ?? 0} hop(s) from a change</p>`;

  const fn = mode() === 'functions';
  const file = fileOf(id);
  const pretty = (ids: string[]) => ids.map((i) => (fn ? `${label[i] ?? i}  ${owner[i] ?? ''}` : i));
  const hasDiff = mode() !== 'repo' && changed[id] !== undefined;

  panel.innerHTML = `
    <h2>${esc(label[id] ?? id)}</h2>
    ${fn ? `<p class="dim">${esc(owner[id] ?? '')}</p>` : ''}
    ${state}
    <button id="open-file">Open file</button>
    ${hasDiff ? '<button id="hide-diff">Hide diff</button>' : ''}
    ${hasDiff ? `<div class="diff-head"><strong>${esc(file)}</strong><span class="dim">${esc(baseSel.value)} … ${esc(compareSel.value)}</span></div>` : ''}
    <div id="diff-body"></div>
    ${fileList(fn ? 'Calls' : 'Imports', pretty(graph[id] ?? []))}
    ${fileList(fn ? 'Called by' : 'Imported by', pretty(importersOf(id)))}
  `;

  document.getElementById('open-file')?.addEventListener('click', async () => {
    const err = await window.diffish.openFile(file);
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
    void showDiff(file);
  } else if (diffOpen) {
    setWide(false);
  }
}

function summary(missing: string[]): string {
  const counts = Object.values(changed).reduce<Record<string, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  const legend =
    mode() === 'repo'
      ? ''
      : `<ul class="legend">
          <li><span class="swatch" style="background:#3fb950"></span>added ${counts.A ?? 0}</li>
          <li><span class="swatch" style="background:#d29922"></span>modified ${(counts.M ?? 0) + (counts.R ?? 0)}</li>
          <li><span class="swatch" style="background:#5b8def;opacity:.55"></span>related</li>
        </ul>`;

  const deleted =
    missing.length > 0
      ? `<h3>Deleted <span class="count">${missing.length}</span></h3>
         <p class="dim">Not on the compare branch, so not drawn.</p>
         <ul>${missing.map((f) => `<li>${f}</li>`).join('')}</ul>`
      : '';

  return `${legend}<p class="dim">Click a node for details.</p>${deleted}`;
}

/**
 * Layered top-down from whatever changed, so the graph reads as a cascade.
 * With no roots (Repo mode) there is nothing to layer from, so fall back to force.
 */
function layoutFor(roots: string[]): cytoscape.LayoutOptions {
  if (roots.length === 0) {
    // tradeoff: cose gets slow and hairy past ~2000 nodes.
    // Upgrade path: collapse by folder, then cytoscape-fcose if still needed.
    return { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 60 } as cytoscape.LayoutOptions;
  }
  return {
    name: 'breadthfirst',
    animate: false,
    directed: false,
    roots: roots.map((r) => `#${CSS.escape(r)}`).join(', '),
    spacingFactor: 1.1,
    padding: 30,
  } as cytoscape.LayoutOptions;
}

function render(result: Extract<Analysis, { ok: true }>) {
  graph = result.graph;
  changed = result.changed;
  hop = result.hop;
  label = result.label;
  owner = result.file;

  const elements = toElements(graph);
  const edgeCount = elements.filter((e) => 'source' in e.data).length;
  const nodeCount = elements.length - edgeCount;

  cy?.destroy();
  cy = cytoscape({
    container: cyEl,
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'background-color': '#5b8def',
          label: 'data(label)',
          color: '#c9d1d9',
          'font-size': 9,
          'text-valign': 'bottom',
          'text-margin-y': 3,
          width: 14,
          height: 14,
        },
      },
      // Related files stay visible but recede — one step back per hop.
      { selector: 'node[hop = "1"]', style: { opacity: 0.55, width: 10, height: 10, 'font-size': 8 } },
      { selector: 'node[hop = "2"]', style: { opacity: 0.3, width: 8, height: 8, 'font-size': 7 } },
      { selector: 'node[change = "A"]', style: { 'background-color': '#3fb950', opacity: 1, width: 18, height: 18, 'font-size': 10 } },
      { selector: 'node[change = "M"]', style: { 'background-color': '#d29922', opacity: 1, width: 18, height: 18, 'font-size': 10 } },
      { selector: 'node[change = "R"]', style: { 'background-color': '#d29922', opacity: 1, width: 18, height: 18, 'font-size': 10 } },
      {
        selector: 'edge',
        style: {
          width: 1,
          'line-color': '#39404d',
          'target-arrow-color': '#39404d',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.6,
          'curve-style': 'bezier',
        },
      },
      { selector: 'node:selected', style: { 'background-color': '#f0883e', width: 20, height: 20, opacity: 1 } },
      { selector: '.dimmed', style: { opacity: 0.08 } },
    ],
    layout: layoutFor(Object.keys(changed)),
  });

  cy.on('tap', 'node', (evt) => showFile(evt.target.id()));

  const changedCount = Object.keys(changed).length;
  const unit = mode() === 'functions' ? 'functions' : 'files';
  const link = mode() === 'functions' ? 'calls' : 'imports';
  status.textContent =
    mode() === 'repo'
      ? `Repo — ${nodeCount} files, ${edgeCount} imports`
      : `${changedCount} changed, ${nodeCount - changedCount} related ${unit} — ${edgeCount} ${link}`;

  panel.innerHTML = summary(result.missing);
  search.value = '';
}

async function analyse() {
  if (mode() === 'diff' && (!baseSel.value || !compareSel.value)) return;

  status.textContent = 'Analysing…';
  const result = await window.diffish.analyse({
    mode: mode(),
    base: baseSel.value,
    compare: compareSel.value,
  });

  if (!result.ok) {
    status.textContent = 'Nothing to show';
    panel.innerHTML = `<p class="error">${result.error}</p>`;
    cy?.destroy();
    cy = null;
    graph = {};
    return;
  }
  render(result);
}

function fillBranches(all: string[], base: string, current: string) {
  const options = (selected: string) =>
    all.map((b) => `<option value="${b}"${b === selected ? ' selected' : ''}>${b}</option>`).join('');

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
    // Not a git repo: Diff mode has nothing to work with, but Repo mode does.
    modeInputs.find((i) => i.value === 'repo')!.checked = true;
    panel.innerHTML = `<p class="error">${project.error}</p><p class="dim">Showing the whole repo instead.</p>`;
  }

  status.textContent = project.root;
  await analyse();
});

for (const input of modeInputs) input.addEventListener('change', analyse);
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
