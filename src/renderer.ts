import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import type { ScanResult } from './scan';

declare global {
  interface Window {
    diffish: {
      pickProject(): Promise<ScanResult | null>;
      openFile(relative: string): Promise<string>;
    };
  }
}

const openBtn = document.getElementById('open-project') as HTMLButtonElement;
const search = document.getElementById('search') as HTMLInputElement;
const status = document.getElementById('status') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const cyEl = document.getElementById('cy') as HTMLElement;

let cy: Core | null = null;
let graph: Record<string, string[]> = {};

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
    data: { id, label: id.split('/').pop() ?? id, kind: 'file' },
  }));

  const edges: ElementDefinition[] = Object.entries(g).flatMap(([file, deps]) =>
    deps.map((dep) => ({ data: { id: `${file}->${dep}`, source: file, target: dep } })),
  );

  return [...nodes, ...edges];
}

function fileList(title: string, files: string[]): string {
  if (files.length === 0) return `<h3>${title} <span class="count">0</span></h3><p class="dim">none</p>`;
  const items = files.map((f) => `<li>${f}</li>`).join('');
  return `<h3>${title} <span class="count">${files.length}</span></h3><ul>${items}</ul>`;
}

function showFile(id: string) {
  panel.innerHTML = `
    <h2>${id}</h2>
    <button id="open-file">Open file</button>
    ${fileList('Imports', graph[id] ?? [])}
    ${fileList('Imported by', importersOf(id))}
  `;
  document.getElementById('open-file')?.addEventListener('click', async () => {
    const err = await window.diffish.openFile(id);
    if (err) panel.insertAdjacentHTML('afterbegin', `<p class="error">${err}</p>`);
  });
}

function render(result: Extract<ScanResult, { ok: true }>) {
  graph = result.graph;
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
      { selector: 'node:selected', style: { 'background-color': '#f0883e', width: 20, height: 20 } },
      { selector: '.dimmed', style: { opacity: 0.15 } },
    ],
    // tradeoff: cose gets slow and hairy past ~2000 nodes.
    // Upgrade path: collapse by folder, then cytoscape-fcose if still needed.
    layout: { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 60 },
  });

  cy.on('tap', 'node', (evt) => showFile(evt.target.id()));

  status.textContent = `${result.root} — ${nodeCount} files, ${edgeCount} imports`;
  panel.innerHTML =
    edgeCount === 0
      ? `<p class="dim">${nodeCount} files, no imports between them. Click a node for details.</p>`
      : `<p class="dim">Click a node for details.</p>`;
}

openBtn.addEventListener('click', async () => {
  status.textContent = 'Scanning…';
  const result = await window.diffish.pickProject();

  if (result === null) {
    status.textContent = graph && Object.keys(graph).length ? status.textContent : 'Ready';
    return;
  }
  if (!result.ok) {
    status.textContent = 'Scan failed';
    panel.innerHTML = `<p class="error">${result.error}</p>`;
    return;
  }
  render(result);
});

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
