import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { scan } from './scan';
import {
  branches,
  changedFiles,
  fileDiff,
  withBranchCheckout,
  type ChangeStatus,
  type DiffRow,
} from './git';
import { HOPS, hiddenNeighbours, restrict, withinHops } from './subgraph';

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
      /** kept file -> neighbours the hop cut removed, drawn as ghosts */
      ghosts: Record<string, string[]>;
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

      return {
        ok: true,
        graph: restrict(scanned.graph, files),
        changed,
        hop: Object.fromEntries(distance),
        missing,
        ghosts: hiddenNeighbours(scanned.graph, files),
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
  async (_event, opts: { base: string; compare: string; file: string }): Promise<FileDiff> => {
    if (!projectRoot) return { ok: false, error: 'No project open' };
    return fileDiff(projectRoot, opts.base, opts.compare, opts.file);
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
