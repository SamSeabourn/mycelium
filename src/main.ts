import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { scan } from './scan';
import {
  branches,
  changedFiles,
  changedLines,
  fileDiff,
  mergeBase,
  showFile,
  withBranchCheckout,
  type ChangeStatus,
} from './git';
import type { DiffRow } from './diff';
import { HOPS, withinHops } from './subgraph';
import {
  buildFunctionGraph,
  functionStatus,
  markChangedFunctions,
  parseFile,
  type FnDef,
} from './functions';

export type Project =
  | { ok: true; root: string; branches: string[]; current: string; base: string }
  | { ok: true; root: string; branches: []; current: ''; base: ''; error: string }
  | null;

/**
 * Nodes are functions, keyed "file#name". `label` and `file` let the renderer show
 * a short name on the graph while still knowing which file to diff on click.
 */
export type Analysis =
  | {
      ok: true;
      graph: Record<string, string[]>;
      changed: Record<string, ChangeStatus>;
      hop: Record<string, number>;
      missing: string[];
      /** caller id -> call targets whose file fell outside the hop window */
      ghosts: Record<string, string[]>;
      label: Record<string, string>;
      file: Record<string, string>;
      /** fn id -> [firstLine, lastLine] on the compare branch */
      span: Record<string, [number, number]>;
    }
  | { ok: false; error: string };

let projectRoot = '';
let currentBranch = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

/** First of develop/main/master that the repo actually has. */
function defaultBase(all: string[], current: string): string {
  return all.find((b) => b === 'develop') ?? all.find((b) => b === 'main') ?? all.find((b) => b === 'master') ?? current;
}

ipcMain.handle('pick-project', async (): Promise<Project> => {
  const picked = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return null;

  projectRoot = picked.filePaths[0];
  const found = await branches(projectRoot);

  if (!found.ok) {
    currentBranch = '';
    return { ok: true, root: projectRoot, branches: [], current: '', base: '', error: found.error };
  }

  currentBranch = found.current;
  return {
    ok: true,
    root: projectRoot,
    branches: found.all,
    current: found.current,
    base: defaultBase(found.all, found.current),
  };
});

ipcMain.handle(
  'analyse',
  async (_event, opts: { base: string; compare: string }): Promise<Analysis> => {
    if (!projectRoot) return { ok: false, error: 'No project open' };
    if (!opts.base || !opts.compare) return { ok: false, error: 'Pick a base and a compare branch' };

    const diff = await changedFiles(projectRoot, opts.base, opts.compare);
    if (!diff.ok) return diff;

    const changed = diff.files;
    if (Object.keys(changed).length === 0) {
      return { ok: false, error: `No changes between ${opts.base} and ${opts.compare}` };
    }

    const lines = await changedLines(projectRoot, opts.base, opts.compare);
    if (!lines.ok) return lines;

    const since = await mergeBase(projectRoot, opts.base, opts.compare);

    // Everything needing the compare branch on disk happens in here, so the throwaway
    // worktree is still around when the parser reads files.
    const work = async (dir: string): Promise<Analysis> => {
      const scanned = await scan(projectRoot, dir);
      if (!scanned.ok) return scanned;

      // Deleted files do not exist on the compare branch, so they never became nodes.
      const seeds = Object.keys(changed).filter((f) => f in scanned.graph);
      const missing = Object.keys(changed).filter((f) => !(f in scanned.graph));

      if (seeds.length === 0) {
        return {
          ok: false,
          error: `The diff touches ${Object.keys(changed).length} file(s), none of them JavaScript or TypeScript.`,
        };
      }

      // Hops still run over the file graph: it is what bounds how much source gets
      // parsed. The functions inside those files are what actually gets drawn.
      const { files, distance } = withinHops(scanned.graph, seeds, HOPS);

      const read = (f: string): string | null => {
        try {
          return fs.readFileSync(path.join(dir, f), 'utf8');
        } catch {
          return null;
        }
      };

      const fns = buildFunctionGraph([...files], scanned.graph, read);
      if (Object.keys(fns.graph).length === 0) {
        return { ok: false, error: 'No named functions found in the changed files or their neighbours.' };
      }

      // Re-parse the changed files for line spans and intersect with the diff hunks.
      // Without this every function in a touched file would look changed.
      const defs: FnDef[] = [];
      for (const f of seeds) {
        const code = read(f);
        if (code !== null) defs.push(...parseFile(f, code).defs);
      }
      const touched = new Set(markChangedFunctions(defs, lines.lines));

      // Which functions existed before, so a new function inside an edited file is
      // reported as added rather than inheriting the file's "modified".
      const baseNames: Record<string, Set<string>> = {};
      for (const f of seeds) {
        const before = await showFile(projectRoot, since, f);
        if (before !== null) baseNames[f] = new Set(parseFile(f, before).defs.map((d) => d.name));
      }

      const fnChanged: Record<string, ChangeStatus> = {};
      const fnHop: Record<string, number> = {};
      for (const id of Object.keys(fns.graph)) {
        const owner = fns.file[id];
        if (touched.has(id)) {
          fnChanged[id] = functionStatus(fns.label[id], changed[owner], baseNames[owner]);
        }
        fnHop[id] = distance.get(owner) ?? HOPS;
      }

      return {
        ok: true,
        graph: fns.graph,
        changed: fnChanged,
        hop: fnHop,
        missing,
        ghosts: fns.ghosts,
        label: fns.label,
        file: fns.file,
        span: fns.span,
      };
    };

    // tradeoff: scanning the working directory is the fast path and picks up
    // uncommitted work; any other branch needs a real checkout to graph honestly.
    return opts.compare === currentBranch
      ? work(projectRoot)
      : withBranchCheckout(projectRoot, opts.compare, work);
  },
);

export type FileDiff = { ok: true; rows: DiffRow[] } | { ok: false; error: string };

ipcMain.handle(
  'file-diff',
  async (
    _event,
    opts: { base: string; compare: string; file: string; range?: [number, number] },
  ): Promise<FileDiff> => {
    if (!projectRoot) return { ok: false, error: 'No project open' };
    return fileDiff(projectRoot, opts.base, opts.compare, opts.file, opts.range);
  },
);

// Renderer only ever holds repo-relative paths, so main rejoins against the root.
ipcMain.handle('open-file', async (_event, relative: string): Promise<string> => {
  if (!projectRoot) return 'No project open';
  return shell.openPath(path.join(projectRoot, relative));
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
