import type { StylesheetJson } from 'cytoscape';
import { themeColor } from './theme';

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

/**
 * Colours come from the live DaisyUI theme, so the graph follows whatever
 * `data-theme` is set on <html> instead of keeping its own palette in sync by hand.
 */
export function graphStyle(): StylesheetJson {
  // Standard git/diff convention: green added, amber modified, red deleted. Using
  // the semantic theme slots rather than accent/secondary keeps that meaning intact
  // whichever DaisyUI theme is set.
  // Same two vars app.css uses, so badges, diff rows, links and nodes stay in step.
  const added = themeColor('--diff-added');
  const modified = themeColor('--diff-modified');
  const selected = themeColor('--pick');
  const ink = themeColor('--color-base-content');
  const idle = themeColor('--node-idle');
  const muted = themeColor('--edge-idle');

  return [
    {
      selector: 'node',
      style: {
        shape: 'ellipse',
        // Unchanged functions are context, so they sit back as plain grey discs.
        // --color-neutral is near-black in most themes, which made them read as
        // loudly as the changed ones.
        'background-color': idle,
        'border-color': ink,
        'border-opacity': 0.25,
        'border-width': 1.2,
        label: 'data(label)',
        color: ink,
        'font-family': SANS,
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
    // Related functions stay visible but recede — one step back per hop.
    { selector: 'node[hop = "1"]', style: { opacity: 0.75, width: 13, height: 13, 'font-size': 10 } },
    { selector: 'node[hop = "2"]', style: { opacity: 0.45, width: 11, height: 11, 'font-size': 9 } },
    // Third ring is context only — at this distance a label is noise, so it goes.
    { selector: 'node[hop = "3"]', style: { opacity: 0.22, width: 9, height: 9, label: '' } },
    {
      selector: 'node[change = "A"]',
      style: { 'background-color': added, 'border-color': ink, 'border-opacity': 1, 'border-width': 2, opacity: 1, width: 24, height: 24, 'font-size': 13 },
    },
    {
      selector: 'node[change = "M"], node[change = "R"]',
      style: { 'background-color': modified, 'border-color': ink, 'border-opacity': 1, 'border-width': 2, opacity: 1, width: 24, height: 24, 'font-size': 13 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.3,
        'line-color': muted,
        'target-arrow-color': muted,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.75,
        // A per-edge bend keeps edges between the same pair from stacking their
        // arrowheads on top of each other.
        'curve-style': 'unbundled-bezier',
        'control-point-distances': 'data(bend)',
        'control-point-weights': 0.5,
      },
    },
    // Declared before the ghost rules so a ghost stub stays faint even when its
    // caller changed — a ghost is by definition something we are not showing.
    {
      selector: 'edge[direct = "1"]',
      style: { 'line-color': ink, 'target-arrow-color': ink, width: 1.8, 'arrow-scale': 0.9 },
    },
    // Ghosts: calls into files outside the hop window. Deliberately faint and dashed
    // so they read as "there is more here" rather than as part of the diff.
    {
      selector: 'node[ghost = "1"]',
      style: {
        'background-opacity': 0,
        'border-color': muted,
        'border-width': 1.2,
        'border-style': 'dashed',
        width: 9,
        height: 9,
        'font-size': 9,
        color: ink,
        opacity: 0.6,
      },
    },
    {
      selector: 'edge[ghost = "1"]',
      style: {
        width: 1,
        'line-style': 'dashed',
        'line-color': muted,
        'target-arrow-shape': 'none',
        'curve-style': 'straight',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'background-color': selected,
        'border-color': ink,
        'border-opacity': 1,
        'border-width': 2,
        width: 26,
        height: 26,
        opacity: 1,
        // The selected node is the one you want to read, so its label comes forward.
        label: 'data(label)',
        'text-opacity': 1,
        'font-size': 14,
        color: ink,
        'z-index': 10,
      },
    },
    { selector: '.dimmed', style: { opacity: 0.1 } },
  ] as StylesheetJson;
}

/** Stable pseudo-random pick so a given node always draws the same way. */
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
