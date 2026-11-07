/**
 * Bridge between DaisyUI's CSS custom properties and the graph canvas.
 *
 * DaisyUI 5 states its theme colours in `oklch()`. The canvas itself accepts that,
 * but cytoscape parses colour strings with its own parser, which does not — hand it
 * an oklch string and every node silently renders grey. So each value is resolved to
 * rgb by painting one pixel and reading it back, which uses the browser's own colour
 * conversion rather than reimplementing oklch.
 */
const pad = document.createElement('canvas');
pad.width = pad.height = 1;
const ctx = pad.getContext('2d', { willReadFrequently: true })!;

export const toRgb = (css: string): string => {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r},${g},${b})`;
};

/** Read a DaisyUI theme variable and return it in a form cytoscape understands. */
export const themeColor = (name: string): string => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? toRgb(raw) : '#888888';
};
