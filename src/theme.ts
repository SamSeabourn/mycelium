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

const probe = document.createElement('span');
probe.hidden = true;
document.body.appendChild(probe);

/**
 * Read a theme variable and return it in a form cytoscape understands.
 *
 * Through an element's `color`, not getPropertyValue: a custom property comes back as
 * the text it was written as, and `light-dark(…)` or a nested `var()` means nothing to
 * a canvas. As a real colour the browser resolves it against the current theme first.
 */
export const themeColor = (name: string): string => {
  probe.style.color = '';
  probe.style.color = `var(${name})`;
  const resolved = getComputedStyle(probe).color;
  return resolved ? toRgb(resolved) : '#888888';
};
