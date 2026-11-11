import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { scanOffThread } from './scan';
import {
  branches,
  fetchRemotes,
  fetchPr,
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
import {
  listPrs,
  prComments,
  submitReview,
  REVIEW_EVENTS,
  type Draft,
  type Pr,
  type PrComment,
  type ReviewEvent,
} from './github';
import { sliceLines, type DiffRow, type SourceLine } from './diff';
import { HOPS, withinHops } from './subgraph';
import {
  buildFunctionGraph,
  functionStatus,
  isSource,
  markChangedFunctions,
  parseFile,
  removedCalls,
  type FileFacts,
  type FnDef,
} from './functions';

/** Calls away from a changed function that still get drawn: its direct callers and callees. */
const CALL_HOPS = 1;

/** One step of an analysis in flight. `done`/`total` only when there is a real count. */
export type Progress = { run?: number; text: string; done?: number; total?: number };

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
    // Retro's base-100, so the window does not flash a different colour before the CSS lands.
    backgroundColor: '#ece3ca',
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
  await fetchRemotes(projectRoot);
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
  async (event, opts: { base: string; compare: string; run?: number }): Promise<Analysis> => {
    if (!projectRoot) {
      return { ok: false, error: 'No project open' };
    }
    if (!opts.base || !opts.compare) {
      return { ok: false, error: 'Pick a base and a compare branch' };
    }

    // Where the wait is, as it happens. `run` goes back with every message so the
    // window can drop news about an analysis it has already moved on from.
    const say = (text: string, done?: number, total?: number) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('progress', { run: opts.run, text, done, total } satisfies Progress);
      }
    };
    say('Reading the diff…');

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
      say('Mapping imports…');
      const scanned = await scanOffThread(path.join(__dirname, 'scan.js'), projectRoot, dir);
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

      // The same call graph is wanted at the merge base too. Changed files read from
      // git; everything else is identical on both sides, so the compare copy stands in.
      const changedSources = [...seeds, ...deletedFiles];
      const baseText = new Map<string, string | null>();
      for (const f of changedSources) baseText.set(f, await showFile(projectRoot, since, diff.from[f] ?? f));
      const readBase = (f: string) => (baseText.has(f) ? (baseText.get(f) ?? null) : read(f));

      // Parse everything up front, one file at a time, handing the thread back between
      // files. Babel is the slow part of what is left, and done in one loop it froze
      // the app for as long as it ran. This way the window stays live, and there is a
      // count to show: a real "how far along", not just "busy".
      // Keyed by path and content, so a file that is the same on both sides, which is
      // nearly all of them, is parsed once and answered from here the second time.
      const parsed = new Map<string, FileFacts>();
      const parseOnce = (f: string, code: string): FileFacts => {
        const key = `${f}\n${code}`;
        let facts = parsed.get(key);
        if (!facts) {
          facts = parseFile(f, code);
          parsed.set(key, facts);
        }
        return facts;
      };

      const queue: [string, (f: string) => string | null][] = [
        ...[...files].map((f): [string, typeof read] => [f, read]),
        ...changedSources.map((f): [string, typeof read] => [f, readBase]),
      ];
      let told = 0;
      for (const [i, [f, from]] of queue.entries()) {
        const code = from(f);
        if (code !== null) {
          parseOnce(f, code);
        }
        // Often enough to look alive, not so often the messages are the work.
        if (Date.now() - told > 60 || i === queue.length - 1) {
          told = Date.now();
          say('Reading functions…', i + 1, queue.length);
        }
        await new Promise((next) => setImmediate(next));
      }
      say('Connecting calls…');

      const fns = buildFunctionGraph([...files], scanned.graph, read, parseOnce);

      // The changed files' line spans, intersected with the diff hunks. Without this
      // every function in a touched file would look changed.
      const defs: FnDef[] = [];
      for (const f of seeds) {
        const code = read(f);
        if (code !== null) {
          defs.push(...parseOnce(f, code).defs);
        }
      }
      const touched = new Set(markChangedFunctions(defs, lines.lines));

      const everyFile = [...files, ...deletedFiles];
      // No madge graph exists for the base side; resolving against every known file
      // is enough for relative imports, which is all resolveImport handles anyway.
      const anyDep = Object.fromEntries(everyFile.map((f) => [f, everyFile]));
      const base = buildFunctionGraph(everyFile, anyDep, readBase, parseOnce);

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
    if (opts.compare === currentBranch) {
      return work(projectRoot);
    }
    say(`Checking out ${opts.compare}…`);
    return withBranchCheckout(projectRoot, opts.compare, work);
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

export type Prs = { ok: true; prs: Pr[] } | { ok: false; error: string };

ipcMain.handle('prs', async (): Promise<Prs> => {
  if (!projectRoot) {
    return { ok: false, error: 'No project open' };
  }
  return listPrs(projectRoot);
});

export type PickedPr = { ok: true; base: string; compare: string; sha: string } | { ok: false; error: string };

/** A PR number ends up in a ref name and a URL path, so it is checked, not trusted. */
const isPrNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/**
 * Turn a pull request into the two revisions the rest of the app already compares.
 * The base is read from origin when it is there: a local `main` is only as fresh as
 * the last pull, and a stale one drags unrelated commits into the diff.
 */
ipcMain.handle('pick-pr', async (_event, opts: { number: number; base: string }): Promise<PickedPr> => {
  if (!projectRoot) {
    return { ok: false, error: 'No project open' };
  }
  if (!isPrNumber(opts.number)) {
    return { ok: false, error: 'Not a pull request number' };
  }
  const fetched = await fetchPr(projectRoot, opts.number);
  if (!fetched.ok) {
    return fetched;
  }
  const found = await branches(projectRoot);
  const remote = `origin/${opts.base}`;
  const base = found.ok && found.all.includes(remote) ? remote : opts.base;
  return { ok: true, base, compare: fetched.ref, sha: fetched.sha };
});

export type Comments = { ok: true; comments: PrComment[] } | { ok: false; error: string };

ipcMain.handle('pr-comments', async (_event, opts: { number: number }): Promise<Comments> => {
  if (!projectRoot) {
    return { ok: false, error: 'No project open' };
  }
  if (!isPrNumber(opts.number)) {
    return { ok: false, error: 'Not a pull request number' };
  }
  return prComments(projectRoot, opts.number);
});

export type Submitted = { ok: true } | { ok: false; error: string };

ipcMain.handle(
  'submit-review',
  async (
    _event,
    opts: { number: number; sha: string; event: ReviewEvent; body: string; drafts: Draft[] },
  ): Promise<Submitted> => {
    if (!projectRoot) {
      return { ok: false, error: 'No project open' };
    }
    if (!isPrNumber(opts.number) || !REVIEW_EVENTS.includes(opts.event)) {
      return { ok: false, error: 'Not a valid review' };
    }
    return submitReview(projectRoot, opts.number, opts.sha, opts.event, opts.body, opts.drafts);
  },
);

app.whenReady().then(() => {
  // macOS only, and only matters unpackaged: a packaged app takes its icon from the
  // bundle, but `electron .` would otherwise sit in the dock as Electron's atom.
  app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'mycelium-icon.png'));
  app.setAboutPanelOptions({
    applicationName: 'mycelium 🍄',
    applicationVersion: app.getVersion(),
    // macOS prints this in brackets after the version, where a build number goes.
    version: '🍄‍🟫',
    credits: [
      '🍄  🍄‍🟫  🍄',
      'The threads under your diff.',
      'Functions are the fruit. Calls are the mycelium.',
      'No mushrooms were harmed in the making of this graph.',
    ].join('\n'),
    copyright: 'Grown, not built. 🌱',
  });
  createWindow();
});

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
