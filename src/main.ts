import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { scan } from './scan';
import { branches, changedFiles, changedLines, withBranchCheckout, type ChangeStatus } from './git';
import { restrict, withinHops } from './subgraph';
import { buildFunctionGraph, markChangedFunctions, parseFile, type FnDef } from './functions';

const HOPS = 2;

export type Mode = 'diff' | 'repo' | 'functions';

export type Project =
  | { ok: true; root: string; branches: string[]; current: string; base: string }
  | { ok: true; root: string; branches: []; current: ''; base: ''; error: string }
  | null;

export type Analysis =
  | {
      ok: true;
      graph: Record<string, string[]>;
      changed: Record<string, ChangeStatus>;
      hop: Record<string, number>;
      missing: string[];
      /** function mode only: node id -> display name, and node id -> owning file */
      label: Record<string, string>;
      file: Record<string, string>;
    }
  | { ok: false; error: string };

let projectRoot = '';
let currentBranch = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#14161a',
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

  // A non-git folder is still worth opening — Repo mode does not need git.
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
  async (_event, opts: { mode: Mode; base: string; compare: string }): Promise<Analysis> => {
    if (!projectRoot) return { ok: false, error: 'No project open' };

    if (opts.mode === 'repo') {
      const result = await scan(projectRoot);
      if (!result.ok) return result;
      return { ok: true, graph: result.graph, changed: {}, hop: {}, missing: [], label: {}, file: {} };
    }

    const diff = await changedFiles(projectRoot, opts.base, opts.compare);
    if (!diff.ok) return diff;

    const changed = diff.files;
    if (Object.keys(changed).length === 0) {
      return { ok: false, error: `No changes between ${opts.base} and ${opts.compare}` };
    }

    const lines =
      opts.mode === 'functions' ? await changedLines(projectRoot, opts.base, opts.compare) : null;
    if (lines && !lines.ok) return lines;

    // Everything that needs the compare branch on disk happens in here, so the
    // throwaway worktree is still around when the function parser reads files.
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

      const { files, distance } = withinHops(scanned.graph, seeds, HOPS);

      if (opts.mode === 'diff') {
        return {
          ok: true,
          graph: restrict(scanned.graph, files),
          changed,
          hop: Object.fromEntries(distance),
          missing,
          label: {},
          file: {},
        };
      }

      const inScope = [...files];
      const read = (f: string): string | null => {
        try {
          return fs.readFileSync(path.join(dir, f), 'utf8');
        } catch {
          return null;
        }
      };

      const fns = buildFunctionGraph(inScope, scanned.graph, read);

      // Re-parse only the changed files to get spans, then intersect with the diff
      // hunks — otherwise every function in a touched file would look changed.
      const defs: FnDef[] = [];
      for (const f of seeds) {
        const code = read(f);
        if (code !== null) defs.push(...parseFile(f, code).defs);
      }
      const touched = new Set(markChangedFunctions(defs, lines?.ok ? lines.lines : {}));

      const fnChanged: Record<string, ChangeStatus> = {};
      const fnHop: Record<string, number> = {};
      for (const id of Object.keys(fns.graph)) {
        const owner = fns.file[id];
        if (touched.has(id)) fnChanged[id] = changed[owner] === 'A' ? 'A' : 'M';
        fnHop[id] = distance.get(owner) ?? HOPS;
      }

      if (Object.keys(fns.graph).length === 0) {
        return { ok: false, error: 'No named functions found in the changed files or their neighbours.' };
      }

      return { ok: true, graph: fns.graph, changed: fnChanged, hop: fnHop, missing, label: fns.label, file: fns.file };
    };

    // tradeoff: scanning the working directory is the fast path and picks up
    // uncommitted work; any other branch needs a real checkout to graph honestly.
    return opts.compare === currentBranch
      ? work(projectRoot)
      : withBranchCheckout(projectRoot, opts.compare, work);
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
