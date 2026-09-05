import madge from 'madge';

export type ScanResult =
  | { ok: true; root: string; graph: Record<string, string[]> }
  | { ok: false; error: string };

/**
 * Read a repo and return its file-level import graph.
 * Kept free of electron imports so the test can call it directly.
 */
export async function scan(root: string): Promise<ScanResult> {
  try {
    const res = await madge(root, {
      fileExtensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
      // madge yields repo-relative paths ("dist/main.js"), so these must anchor
      // on start-or-slash — a leading `/` would never match anything.
      excludeRegExp: [/(^|\/)node_modules\//, /(^|\/)dist\//, /\.min\.js$/],
    });
    const graph = res.obj() as Record<string, string[]>;
    if (Object.keys(graph).length === 0) {
      return { ok: false, error: `No JavaScript or TypeScript files found in ${root}` };
    }
    return { ok: true, root, graph };
  } catch (e) {
    return { ok: false, error: `Scan failed: ${(e as Error).message}` };
  }
}
