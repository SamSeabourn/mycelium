# mycelium

A desktop app for reading a change as a map. Point it at a JavaScript or TypeScript
repository, pick two branches or an open pull request, and it draws the functions that
changed together with the functions that call them or are called by them.

## What it shows

- **Changed functions**: added (green), modified (amber), and deleted (red, dashed outline).
- **Their neighbours**: callers and callees one hop out. Unrelated functions in the same file stay off the map.
- **Removed calls**: drawn as dashed red edges.
- **Calls that leave the map**: faint stubs, so a call into code outside the window is never silently dropped.

Click a function to see the diff for that function alone, with call sites linked to the
functions they reach. In pull request mode you can leave line comments and submit a
review without leaving the app.

Works with plain JS, TypeScript, JSX and TSX, including React components called as
`<Button />`, tsconfig path aliases (`@/components/...`) and barrel `index.ts` files.

## Run it

Needs Node 22+, [pnpm](https://pnpm.io), and git. Pull request mode also needs the
[GitHub CLI](https://cli.github.com) (`gh auth login`).

```sh
pnpm install
pnpm start
```

```sh
pnpm test    # build, then run the node:test suite
pnpm check   # typecheck
```

## Docs

- [Design](docs/design.md): the original design, its stack choices and known ceilings.

Shortcuts taken on purpose are marked in the code with `tradeoff:` comments that name
the limit and the upgrade path.
