# mycelium — file-level dependency graph explorer

**Date:** 2026-09-05
**Status:** Approved for implementation

## Purpose

A standalone Electron app that opens any JavaScript or TypeScript repository and
renders its file-level import graph as an explorable, force-directed graph. You
pick a folder; the app shows which files import which.

This is v1 of a larger tool. Function-level call graphs are the next feature and
are explicitly out of scope here, but the design keeps a seam for them (see
"Extension seam").

## Non-goals

- Function-level or symbol-level call graphs (next feature)
- Editing, refactoring, or writing to the scanned repository — mycelium is read-only
- Watch mode / live rescan on file change
- Persisted sessions, saved layouts, or project history
- Folder collapse / expand-on-click aggregation
- Publishing, packaging, or code-signing a distributable binary

## Stack

| Concern | Choice | Why |
|---|---|---|
| Shell | Electron 44 | Requested. Gives filesystem access plus a browser renderer. |
| Scan | madge 8 | Resolves JS/TS/JSX imports and returns `{file: [deps]}` already. Writing an import resolver is strictly more code. |
| Render | cytoscape 3.34 | Graph rendering with pan/zoom/selection built in. Zero dependencies. |
| Layout | cytoscape built-in `cose` | Force-directed, handles cycles, ships inside cytoscape. |
| Build | esbuild 0.28 | Bundles and strips TS in two commands with no config file. |
| Types | typescript 7 | `tsc --noEmit` only; esbuild does the actual transform. |

Five dependencies. Package manager is **pnpm**.

### Rejected: cytoscape-fcose

Considered for nicer layout, rejected on supply-chain grounds: single maintainer,
last published 2023-01-17. Cytoscape's built-in `cose` covers v1. Revisit only if
`cose` visibly degrades on a real repo.

### Install-script policy

`package.json` declares:

```json
"pnpm": { "onlyBuiltDependencies": ["esbuild", "electron"] }
```

Both need install scripts for legitimate reasons — each downloads a prebuilt
platform binary. Every other package in the tree is blocked from running install
scripts by pnpm's default. `pnpm audit` runs once the lockfile exists.

## Architecture

Three processes, one direction of trust.

```
main.ts (Node)                preload.ts              renderer.ts (browser)
─────────────                 ──────────              ─────────────────────
dialog.showOpenDialog   <──   contextBridge     <──   "Open Project" click
madge(dir).obj()
  │
  └── {file: [deps]}    ──>   ipcRenderer       ──>   cytoscape elements
                                                       │
shell.openPath(file)    <──   contextBridge     <──   "Open file" click
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload
is the only bridge, and it exposes exactly two functions. The renderer never
touches `fs`, `path`, or `child_process`.

### Module responsibilities

**`src/main.ts`** — owns the window and all filesystem access.
- Creates the `BrowserWindow` with the security flags above
- `ipcMain.handle('pick-project')` → folder dialog → `scan(dir)` → returns the
  graph payload or an error object
- `ipcMain.handle('open-file', path)` → `shell.openPath`
- `scan(dir)` is exported so the test can call it without launching Electron

**`src/preload.ts`** — `contextBridge.exposeInMainWorld('mycelium', { pickProject, openFile })`.
No logic. Two `ipcRenderer.invoke` wrappers.

**`src/renderer.ts`** — owns the graph and the DOM.
- Converts `{file: [deps]}` into cytoscape `nodes` and `edges`
- Runs the `cose` layout
- Node click → populates the side panel
- Search input → highlights matches, dims non-matches

**`src/index.html`** — markup and CSS. Loads `dist/renderer.js`.

### Data contract

`scan()` returns one shape, always:

```ts
type ScanResult =
  | { ok: true; root: string; graph: Record<string, string[]> }
  | { ok: false; error: string }
```

`graph` keys are repo-relative POSIX paths, as madge produces them. madge
normally emits every scanned file as a key, including leaves with empty arrays.
The renderer does not rely on that: it builds its node set from keys *and*
values, so a dependency that appears only as an edge target still gets a node
instead of a dropped edge.

## Interactions (v1)

1. **Pan / zoom** — cytoscape defaults. Drag canvas, scroll to zoom.
2. **Click node → side panel** — shows repo-relative path, count and list of
   files it imports, count and list of files that import it.
3. **Search / filter** — text input, substring match on path, case-insensitive.
   Matching nodes stay at full opacity; non-matching drop to 0.15. Empty input
   restores everything. Filtering is visual only; it never re-runs the layout.
4. **Open file** — button in the side panel, `shell.openPath` to the system
   default editor.

Explicitly deferred: folder collapse (Q2). Add it when a real repo renders
unreadable.

## Error handling

Every failure surfaces as text in the side panel. No silent empty graph, because
"scan failed" and "repo has no imports" look identical otherwise.

| Condition | Behaviour |
|---|---|
| Dialog cancelled | No-op, graph unchanged |
| Directory unreadable | Panel: the OS error message |
| No JS/TS files found | Panel: "No JavaScript or TypeScript files found in `<dir>`" |
| madge throws | Panel: "Scan failed: `<message>`" |
| Zero edges but files exist | Graph renders as isolated nodes, panel notes it |
| `shell.openPath` fails | Panel: the returned error string |

## Testing

One runnable check: `test/scan.test.ts`, run with `node --test`.

Fixture is a three-file repo committed under `test/fixture/`:

```
a.js  →  b.js
b.js  →  a.js   (cycle)
c.js  →  a.js
```

Asserts:
- `scan()` returns `ok: true` with all three files as keys
- the `a → b → a` cycle survives in the output (this is what makes the layout
  choice matter, so it must be covered)
- `c.js` appears as an importer of `a.js`
- `scan()` on a directory with no JS returns `ok: false` with a non-empty error

Scanning is the only non-trivial logic in the app. The cytoscape wiring is
configuration, and it is verified by launching the app.

## Known ceilings

Marked in code with `tradeoff:` comments.

- **Layout above ~2000 nodes.** `cose` gets slow and the graph becomes hair.
  Upgrade path: folder collapse, then fcose if still needed.
- **madge misses dynamic imports** with computed specifiers
  (`require(someVar)`, `import(templateString)`). Static analysis cannot resolve
  these. Expect near-complete edges on normal ESM/CJS, gaps in plugin-loader code.
- **esbuild does not typecheck.** `pnpm check` (`tsc --noEmit`) is a separate,
  manual step. A build passing does not mean the types are sound.

## Extension seam

The function-level feature lands as a second scanner plus a node kind, not a
rewrite:

- `scan()` stays the file-level entry point; a sibling `scanFunctions()` returns
  the same discriminated-union shape
- cytoscape nodes gain a `kind: 'file' | 'function'` data field
- the side panel switches its content on `kind`

Nothing in v1 needs to change to accommodate this, which is why file-level is
worth shipping on its own.

## Build and run

```
pnpm install
pnpm build     # both esbuild commands
pnpm start     # electron dist/main.js
pnpm check     # tsc --noEmit
pnpm test      # node --test
```

`dist/` is gitignored.
