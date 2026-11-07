import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { scan } from './scan';
import {
  branches,
  changedFiles,
  changedLines,
  diffRevs,
  fileDiff,
  mergeBase,
  showFile,
  untrackedFiles,
  withBranchCheckout,
  type ChangeStatus,
} from './git';
import { sliceLines, type DiffRow, type SourceLine } from './diff';
import { HOPS, withinHops } from './subgraph';
import {
  buildFunctionGraph,
  functionStatus,
  isSource,
  markChangedFunctions,
  parseFile,
  removedCalls,
  type FnDef,
} from './functions';

/** Calls away from a changed function that still get drawn: its direct callers and callees. */
const CALL_HOPS = 1;

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
      /** caller id -> callees it called at the merge base but no longer does */
      removed: Record<string, string[]>;
      /** caller id -> call targets whose file fell outside the hop window */
      ghosts: Record<string, string[]>;
      label: Record<string, string>;
      file: Record<string, string>;
      /** fn id -> [firstLine, lastLine] on the compare branch */
      span: Record<string, [number, number]>;
      /** same, at the merge base — absent for a function that is new; the only span a deleted one has */
      baseSpan: Record<string, [number, number]>;
      /** renamed file -> its path at the merge base */
      from: Record<string, string>;
    }
  | { ok: false; error: string };

let projectRoot = '';
let currentBranch = '';

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
};

/** First of develop/main/master that the repo actually has. */
const defaultBase = (all: string[], current: string): string => {
  return all.find((b) => b === 'develop') ?? all.find((b) => b === 'main') ?? all.find((b) => b === 'master') ?? current;
};

ipcMain.handle('pick-project', async (): Promise<Project> => {
  const picked = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) {
    return null;
  }

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
    if (!projectRoot) {
      return { ok: false, error: 'No project open' };
    }
    if (!opts.base || !opts.compare) {
      return { ok: false, error: 'Pick a base and a compare branch' };
    }

    // Re-read every time: a `git checkout` in a terminal since opening would otherwise
    // have us scan the working tree as if it were the old branch.
    const now = await branches(projectRoot);
    if (now.ok) {
      currentBranch = now.current;
    }

    const since = await mergeBase(projectRoot, opts.base, opts.compare);
    const worktree = opts.compare === currentBranch;
    const revs = diffRevs(opts.base, opts.compare, since, worktree);

    const diff = await changedFiles(projectRoot, revs);
    if (!diff.ok) {
      return diff;
    }
    const lines = await changedLines(projectRoot, revs);
    if (!lines.ok) {
      return lines;
    }

    const changed = diff.files;
    if (worktree) {
      // A brand-new file nobody has `git add`ed yet: every line of it is new.
      for (const f of await untrackedFiles(projectRoot)) {
        if (isSource(f)) {
          changed[f] = 'A';
          lines.lines[f] = [[1, Number.MAX_SAFE_INTEGER]];
        }
      }
    }
    if (Object.keys(changed).length === 0) {
      return { ok: false, error: `No changes between ${opts.base} and ${opts.compare}` };
    }

    // Everything needing the compare branch on disk happens in here, so the throwaway
    // worktree is still around when the parser reads files.
    const work = async (dir: string): Promise<Analysis> => {
      const scanned = await scan(projectRoot, dir);
      if (!scanned.ok) {
        return scanned;
      }

      const seeds = Object.keys(changed).filter((f) => f in scanned.graph);
      // Gone from the compare branch, so madge never saw them — their functions come
      // back as deleted nodes from the base-side parse below.
      const deletedFiles = Object.keys(changed).filter((f) => changed[f] === 'D' && isSource(f));

      if (seeds.length === 0 && deletedFiles.length === 0) {
        return {
          ok: false,
          error: `The diff touches ${Object.keys(changed).length} file(s), none of them JavaScript or TypeScript.`,
        };
      }

      // Hops still run over the file graph: it is what bounds how much source gets
      // parsed. The functions inside those files are what actually gets drawn.
      const { files } = withinHops(scanned.graph, seeds, HOPS);

      const read = (f: string): string | null => {
        try {
          return fs.readFileSync(path.join(dir, f), 'utf8');
        } catch {
          return null;
        }
      };

      const fns = buildFunctionGraph([...files], scanned.graph, read);

      // Re-parse the changed files for line spans and intersect with the diff hunks.
      // Without this every function in a touched file would look changed.
      const defs: FnDef[] = [];
      for (const f of seeds) {
        const code = read(f);
        if (code !== null) {
          defs.push(...parseFile(f, code).defs);
        }
      }
      const touched = new Set(markChangedFunctions(defs, lines.lines));

      // The same call graph at the merge base. Changed files read from git; everything
      // else is identical on both sides, so the compare copy stands in for it.
      const changedSources = [...seeds, ...deletedFiles];
      const baseText = new Map<string, string | null>();
      for (const f of changedSources) baseText.set(f, await showFile(projectRoot, since, diff.from[f] ?? f));
      const everyFile = [...files, ...deletedFiles];
      // No madge graph exists for the base side; resolving against every known file
      // is enough for relative imports, which is all resolveImport handles anyway.
      const anyDep = Object.fromEntries(everyFile.map((f) => [f, everyFile]));
      const base = buildFunctionGraph(everyFile, anyDep, (f) =>
        baseText.has(f) ? (baseText.get(f) ?? null) : read(f),
      );

      // Which functions existed before, so a new function inside an edited file is
      // reported as added rather than inheriting the file's "modified".
      const baseNames: Record<string, Set<string>> = {};
      for (const id of Object.keys(base.label)) {
        (baseNames[base.file[id]] ??= new Set()).add(base.label[id]);
      }

      const fnChanged: Record<string, ChangeStatus> = {};
      for (const id of touched) {
        const owner = fns.file[id];
        fnChanged[id] = functionStatus(fns.label[id], changed[owner], baseNames[owner]);
      }
      const changedSet = new Set(changedSources);
      for (const id of Object.keys(base.label)) {
        // No span means a file's top level, not a function: it cannot be deleted.
        if (changedSet.has(base.file[id]) && base.span[id] && !(id in fns.label)) {
          fnChanged[id] = 'D';
        }
      }

      const removed = removedCalls(base, fns.graph, changedSet);

      // Neighbours by call, not by file: a function is drawn when it calls, or is
      // called by, something that changed. Removed calls count — that is how a
      // deleted function finds its old callers and callees.
      const linked: Record<string, string[]> = { ...fns.graph };
      for (const [caller, gone] of Object.entries(removed)) linked[caller] = [...(linked[caller] ?? []), ...gone];
      const { files: kept, distance: callHop } = withinHops(linked, Object.keys(fnChanged), CALL_HOPS);

      if (kept.size === 0) {
        return { ok: false, error: 'No named functions found in the changed files or their neighbours.' };
      }

      const keep = (ids: string[]) => ids.filter((t) => kept.has(t));
      const graph: Record<string, string[]> = {};
      const removedKept: Record<string, string[]> = {};
      const label: Record<string, string> = {};
      const file: Record<string, string> = {};
      const span: Record<string, [number, number]> = {};
      const baseSpan: Record<string, [number, number]> = {};
      const hop: Record<string, number> = {};
      for (const id of kept) {
        graph[id] = keep(fns.graph[id] ?? []);
        if (removed[id]) {
          removedKept[id] = keep(removed[id]);
        }
        label[id] = fns.label[id] ?? base.label[id];
        file[id] = fns.file[id] ?? base.file[id];
        if (fns.span[id]) {
          span[id] = fns.span[id];
        }
        if (base.span[id]) {
          baseSpan[id] = base.span[id];
        }
        hop[id] = callHop.get(id) ?? CALL_HOPS;
      }

      // Stubs only off changed functions; off a neighbour they would just be noise.
      const ghosts = Object.fromEntries(Object.entries(fns.ghosts).filter(([id]) => fnChanged[id]));

      return {
        ok: true,
        graph,
        removed: removedKept,
        changed: fnChanged,
        hop,
        ghosts,
        label,
        file,
        span,
        baseSpan,
        from: diff.from,
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
    opts: {
      base: string;
      compare: string;
      file: string;
      range?: [number, number];
      baseRange?: [number, number];
      from?: string;
    },
  ): Promise<FileDiff> => {
    if (!projectRoot) {
      return { ok: false, error: 'No project open' };
    }
    const since = await mergeBase(projectRoot, opts.base, opts.compare);
    const revs = diffRevs(opts.base, opts.compare, since, opts.compare === currentBranch);
    return fileDiff(projectRoot, revs, opts.file, opts.range, opts.baseRange, opts.from);
  },
);

export type Source = { ok: true; lines: SourceLine[] } | { ok: false; error: string };

/**
 * The body of a function that has no diff to show. Read from the same place the scan
 * came from: the working tree when compare is checked out (so uncommitted edits match
 * what was graphed), otherwise the committed copy.
 */
ipcMain.handle(
  'source',
  async (
    _event,
    opts: { compare: string; file: string; range: [number, number] },
  ): Promise<Source> => {
    if (!projectRoot) {
      return { ok: false, error: 'No project open' };
    }
    try {
      const text =
        opts.compare === currentBranch
          ? fs.readFileSync(path.join(projectRoot, opts.file), 'utf8')
          : await showFile(projectRoot, opts.compare, opts.file);
      if (text === null) {
        return { ok: false, error: `${opts.file} not found on ${opts.compare}` };
      }
      return { ok: true, lines: sliceLines(text, opts.range[0], opts.range[1]) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
