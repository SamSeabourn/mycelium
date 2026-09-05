import type { StylesheetJson } from 'cytoscape';

/**
 * A circle with jittered radii, as normalised polygon points.
 *
 * cytoscape draws perfect ellipses; a hand-drawn look needs the geometry itself to
 * wobble. Deterministic per `seed` so a node keeps the same outline across redraws
 * instead of shimmering on every layout.
 */
export function sketchCircle(seed: number, points = 18): string {
  let state = seed * 9301 + 49297;
  const rand = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };

  const coords: string[] = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const radius = 0.86 + rand() * 0.14;
    coords.push((Math.cos(angle) * radius).toFixed(3), (Math.sin(angle) * radius).toFixed(3));
  }
  return coords.join(' ');
}

/** Three outlines is enough variety to stop nodes looking stamped. */
export const OUTLINES = [sketchCircle(1), sketchCircle(2), sketchCircle(3)];

export const INK = '#24242a';
export const ADDED = '#2e8b45';
export const MODIFIED = '#e8a020';
export const RELATED = '#6b7fa8';
export const PAPER = '#fffdf6';

const HAND = '"Bradley Hand", "Chalkboard SE", "Marker Felt", cursive';

export function graphStyle(): StylesheetJson {
  const outlineRules: StylesheetJson = OUTLINES.map((points, i) => ({
    selector: `node[poly = "${i}"]`,
    style: { 'shape-polygon-points': points },
  })) as StylesheetJson;

  return [
    {
      selector: 'node',
      style: {
        shape: 'polygon',
        'background-color': PAPER,
        'border-color': RELATED,
        'border-width': 1.6,
        label: 'data(label)',
        color: INK,
        'font-family': HAND,
        'font-size': 11,
        // Labels sit back until you pick a node — at a glance the map is shape and
        // colour, and the name is there when you actually want it.
        'text-opacity': 0.33,
        'text-valign': 'bottom',
        'text-margin-y': 5,
        width: 16,
        height: 16,
      },
    },
    ...outlineRules,
    // Related files stay visible but recede — one step back per hop.
    { selector: 'node[hop = "1"]', style: { opacity: 0.75, width: 13, height: 13, 'font-size': 10 } },
    { selector: 'node[hop = "2"]', style: { opacity: 0.45, width: 11, height: 11, 'font-size': 9 } },
    // Third ring is context only — at this distance a label is noise, so it goes.
    { selector: 'node[hop = "3"]', style: { opacity: 0.22, width: 9, height: 9, label: '' } },
    {
      selector: 'node[change = "A"]',
      style: { 'background-color': ADDED, 'border-color': '#1d5c2c', 'border-width': 2, opacity: 1, width: 24, height: 24, 'font-size': 13 },
    },
    {
      selector: 'node[change = "M"], node[change = "R"]',
      style: { 'background-color': MODIFIED, 'border-color': '#8a5c00', 'border-width': 2, opacity: 1, width: 24, height: 24, 'font-size': 13 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.3,
        'line-color': '#8d8676',
        'target-arrow-color': '#8d8676',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.75,
        // A per-edge bend is what stops the lines reading as ruled and mechanical.
        'curve-style': 'unbundled-bezier',
        'control-point-distances': 'data(bend)',
        'control-point-weights': 0.5,
      },
    },
    // Ghosts: neighbours the hop cut removed. Deliberately faint and dashed so they
    // read as "there is more here" rather than as part of the diff.
    {
      selector: 'node[ghost = "1"]',
      style: {
        'background-opacity': 0,
        'border-color': '#a8a294',
        'border-width': 1.2,
        'border-style': 'dashed',
        width: 9,
        height: 9,
        'font-size': 9,
        color: '#9b9486',
        opacity: 0.85,
      },
    },
    {
      selector: 'edge[ghost = "1"]',
      style: {
        width: 1,
        'line-style': 'dashed',
        'line-color': '#bdb6a6',
        'target-arrow-shape': 'none',
        'curve-style': 'straight',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'background-color': '#2f5fd0',
        'border-color': '#1a3b8a',
        width: 26,
        height: 26,
        opacity: 1,
        // The selected node is the one you want to read, so its label comes forward.
        label: 'data(label)',
        'text-opacity': 1,
        'font-size': 14,
        color: INK,
        'z-index': 10,
      },
    },
    { selector: '.dimmed', style: { opacity: 0.1 } },
  ] as StylesheetJson;
}

/** Stable pseudo-random pick so a given file always draws the same way. */
export function hashPick(id: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % buckets;
}

/**
 * Bend amount for an edge, in pixels, derived from its id so it never jitters.
 * Wide enough that edges between the same pair of nodes fan apart rather than
 * stacking their arrowheads on top of each other.
 */
export function edgeBend(id: string): number {
  const pick = hashPick(id, 9);
  return (pick - 4) * 16; // -64 .. 64
}
