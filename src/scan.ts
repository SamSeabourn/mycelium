import madge from 'madge';
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * JSON with comments and trailing commas, which is what tsconfig files are. A string
 * walk rather than a regex: `"@/*": ["./src/*"]` holds a `/*` that is not a comment.
 */
export const parseJsonc = (text: string): unknown => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) {
        break;
      }
      i++;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      // trailing comma: drop it
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
};

/**
 * Path aliases (`@/components/Button`) for madge, from the first config that has any.
 * `tsconfig.app.json` is where Vite's React template keeps them.
 *
 * Handed over pre-parsed: given a file path, madge reads it with whatever
 * `typescript` it finds, and TypeScript 7 has no JS API to read it with.
 * tradeoff: `extends` is not followed; add when a repo keeps its paths in a base config.
 */
export const aliasConfig = (dir: string): { compilerOptions: { baseUrl: string; paths: Record<string, string[]> } } | undefined => {
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    try {
      const options = (parseJsonc(fs.readFileSync(path.join(dir, name), 'utf8')) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
      if (options?.paths) {
        // Absolute, or filing-cabinet resolves it against the process cwd.
        return { compilerOptions: { baseUrl: path.resolve(dir, options.baseUrl ?? '.'), paths: options.paths } };
      }
    } catch {
      // Missing or unreadable: try the next one.
    }
  }
  return undefined;
};

export type ScanResult =
  | { ok: true; root: string; graph: Record<string, string[]> }
  | { ok: false; error: string };

/**
 * Read a repo and return its file-level import graph.
 * Kept free of electron imports so the test can call it directly.
 *
 * `dir` exists so a throwaway worktree can be scanned while `root` stays the real
 * repo — paths are relative either way, so "open file" still resolves correctly.
 */
export const scan = async (root: string, dir: string = root): Promise<ScanResult> => {
  try {
    const res = await madge(dir, {
      fileExtensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
      // madge yields repo-relative paths ("dist/main.js"), so these must anchor
      // on start-or-slash — a leading `/` would never match anything.
      excludeRegExp: [
        /(^|\/)node_modules\//,
        /(^|\/)dist\//,
        /\.min\.js$/,
        // Tests call into the app but are not part of it; on the map they are noise.
        /(^|\/)(test|tests|__tests__)\//,
        /\.(test|spec)\.[cm]?[jt]sx?$/,
      ],
      tsConfig: aliasConfig(dir),
    });
    const graph = res.obj() as Record<string, string[]>;
    if (Object.keys(graph).length === 0) {
      return { ok: false, error: `No JavaScript or TypeScript files found in ${root}` };
    }
    return { ok: true, root, graph };
  } catch (e) {
    return { ok: false, error: `Scan failed: ${(e as Error).message}` };
  }
};

/**
 * The same scan, on another thread.
 *
 * madge walks the whole repo in one synchronous go — seconds on a large one — and on
 * the main thread that is seconds of an app that does not answer the mouse, which
 * macOS reports with the spinning wait cursor. Nothing inside it can be paused from
 * out here, so the whole thing goes where blocking costs nothing.
 *
 * `script` is this module as built (dist/scan.js): the worker is that file run again,
 * taking the branch at the bottom.
 */
export const scanOffThread = (script: string, root: string, dir: string = root): Promise<ScanResult> => {
  return new Promise((resolve) => {
    const worker = new Worker(script, { workerData: { scan: { root, dir } } });
    worker.once('message', (result: ScanResult) => {
      resolve(result);
      void worker.terminate();
    });
    worker.once('error', (e) => resolve({ ok: false, error: `Scan failed: ${e.message}` }));
  });
};

if (!isMainThread && parentPort && workerData?.scan) {
  const port = parentPort;
  void scan(workerData.scan.root, workerData.scan.dir).then((result) => port.postMessage(result));
}
