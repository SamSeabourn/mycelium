import { parse } from '@babel/parser';
import path from 'node:path';

export type FnDef = {
  id: string; // "src/auth.ts#login"
  file: string;
  name: string;
  start: number; // 1-based line
  end: number;
};

export type FileFacts = {
  defs: FnDef[];
  /** local binding name -> import source string, e.g. { scan: './scan' } */
  imports: Record<string, string>;
  /** caller function id -> callee names used inside it */
  calls: { from: string; name: string }[];
};

type AnyNode = { type: string; [key: string]: unknown };

const EXT = /\.[cm]?[jt]sx?$/;

function pluginsFor(file: string): ('typescript' | 'jsx')[] {
  // `jsx` on a .ts file misreads `<T>value` casts as JSX, so only .tsx gets both.
  if (file.endsWith('.tsx')) return ['typescript', 'jsx'];
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return ['typescript'];
  return ['jsx'];
}

function nameOf(node: AnyNode): string | null {
  const key = node.key as AnyNode | undefined;
  const id = node.id as AnyNode | undefined;
  if (id?.type === 'Identifier') return id.name as string;
  if (key?.type === 'Identifier') return key.name as string;
  if (key?.type === 'StringLiteral') return key.value as string;
  return null;
}

function isFunctionNode(type: string): boolean {
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ArrowFunctionExpression' ||
    type === 'ClassMethod' ||
    type === 'ObjectMethod' ||
    type === 'ClassPrivateMethod'
  );
}

/**
 * Pull function definitions, imports, and call sites out of one file.
 *
 * tradeoff: name-based resolution, no type information. Calls through a variable
 * (`handlers[k]()`), a callback passed as an argument, or a method on anything other
 * than `this` will not produce an edge. Upgrade path is the TypeScript checker, which
 * in TS 7 lives behind the `typescript/unstable/*` API — not worth pinning to yet.
 */
export function parseFile(file: string, code: string): FileFacts {
  const facts: FileFacts = { defs: [], imports: {}, calls: [] };

  let ast: AnyNode;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: pluginsFor(file),
      errorRecovery: true,
    }) as unknown as AnyNode;
  } catch {
    return facts; // a file we cannot parse simply contributes nothing
  }

  const stack: string[] = [];
  let className: string | null = null;

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const n = node as AnyNode;
    if (typeof n.type !== 'string') return;

    if (n.type === 'ImportDeclaration') {
      const source = (n.source as AnyNode)?.value as string;
      for (const spec of (n.specifiers ?? []) as AnyNode[]) {
        const local = (spec.local as AnyNode)?.name as string;
        if (local && source) facts.imports[local] = source;
      }
      return;
    }

    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const callee = n.callee as AnyNode | undefined;
      const from = stack[stack.length - 1];
      if (from && callee) {
        if (callee.type === 'Identifier') {
          facts.calls.push({ from, name: callee.name as string });
        } else if (
          callee.type === 'MemberExpression' &&
          (callee.object as AnyNode)?.type === 'ThisExpression' &&
          (callee.property as AnyNode)?.type === 'Identifier'
        ) {
          facts.calls.push({ from, name: (callee.property as AnyNode).name as string });
        }
      }
    }

    const prevClass = className;
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      className = nameOf(n) ?? className;
    }

    let pushed = false;
    if (isFunctionNode(n.type)) {
      // Arrow and function expressions are anonymous; the useful name is on the
      // variable or property they were assigned to, captured by the parent below.
      const bare = nameOf(n);
      const name = bare && className && (n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod')
        ? `${className}.${bare}`
        : bare;
      if (name) {
        const loc = n.loc as { start: { line: number }; end: { line: number } } | undefined;
        const id = `${file}#${name}`;
        facts.defs.push({ id, file, name, start: loc?.start.line ?? 0, end: loc?.end.line ?? 0 });
        stack.push(id);
        pushed = true;
      }
    }

    // `const foo = () => {}` — name the function after the binding.
    if (n.type === 'VariableDeclarator') {
      const init = n.init as AnyNode | undefined;
      const name = nameOf(n);
      if (name && init && isFunctionNode(init.type)) {
        const loc = init.loc as { start: { line: number }; end: { line: number } } | undefined;
        const id = `${file}#${name}`;
        facts.defs.push({ id, file, name, start: loc?.start.line ?? 0, end: loc?.end.line ?? 0 });
        stack.push(id);
        pushed = true;
      }
    }

    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      walk(n[key]);
    }

    if (pushed) stack.pop();
    className = prevClass;
  };

  walk(ast);
  return facts;
}

/**
 * Turn an import source ("./scan") into one of the file keys madge produced,
 * reusing the already-resolved dependency list rather than re-implementing
 * node resolution.
 */
export function resolveImport(fromFile: string, source: string, deps: string[]): string | null {
  if (!source.startsWith('.')) return null; // package import — outside the graph

  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), source));
  const strip = (p: string) => p.replace(EXT, '');

  return (
    deps.find((d) => strip(d) === target) ??
    deps.find((d) => strip(d) === `${target}/index`) ??
    null
  );
}

export type FnGraph = {
  graph: Record<string, string[]>;
  label: Record<string, string>;
  file: Record<string, string>;
  /** caller id -> call targets in files outside the hop window */
  ghosts: Record<string, string[]>;
  /** fn id -> [firstLine, lastLine] on the compare branch, for slicing its diff */
  span: Record<string, [number, number]>;
};

/**
 * Build the function-level call graph for a set of files.
 * `graph` is the same {node: [targets]} shape the file view uses, so the renderer
 * needs no new drawing code.
 */
export function buildFunctionGraph(
  files: string[],
  fileGraph: Record<string, string[]>,
  read: (file: string) => string | null,
): FnGraph {
  const facts = new Map<string, FileFacts>();
  const byName = new Map<string, Map<string, string>>(); // file -> name -> fn id

  for (const file of files) {
    const code = read(file);
    if (code === null) continue;
    const f = parseFile(file, code);
    facts.set(file, f);

    const names = new Map<string, string>();
    for (const def of f.defs) {
      names.set(def.name, def.id);
      // `Foo.bar` should also answer to `bar` for `this.bar()` calls.
      const dot = def.name.indexOf('.');
      if (dot > 0 && !names.has(def.name.slice(dot + 1))) names.set(def.name.slice(dot + 1), def.id);
    }
    byName.set(file, names);
  }

  const graph: Record<string, string[]> = {};
  const label: Record<string, string> = {};
  const file: Record<string, string> = {};
  const ghosts: Record<string, string[]> = {};
  const span: Record<string, [number, number]> = {};

  for (const [f, facts_] of facts) {
    for (const def of facts_.defs) {
      graph[def.id] ??= [];
      label[def.id] = def.name;
      file[def.id] = def.file;
      span[def.id] = [def.start, def.end];
    }

    for (const call of facts_.calls) {
      const local = byName.get(f)?.get(call.name);
      let target = local;

      if (!target) {
        const source = facts_.imports[call.name];
        const resolved = source ? resolveImport(f, source, fileGraph[f] ?? []) : null;

        if (resolved && !byName.has(resolved)) {
          // Resolves to a real file we deliberately did not parse — it fell outside
          // the hop window. Recording it keeps the graph honest about the edge
          // rather than silently dropping it.
          const id = `${resolved}#${call.name}`;
          ghosts[call.from] ??= [];
          if (!ghosts[call.from].includes(id)) ghosts[call.from].push(id);
          continue;
        }

        if (resolved) target = byName.get(resolved)?.get(call.name);
      }

      if (!target || target === call.from) continue;
      graph[call.from] ??= [];
      if (!graph[call.from].includes(target)) graph[call.from].push(target);
    }
  }

  return { graph, label, file, ghosts, span };
}

/** A function counts as changed when a changed line falls inside its span. */
export function markChangedFunctions(
  defs: FnDef[],
  changedLines: Record<string, [number, number][]>,
): string[] {
  return defs
    .filter((def) =>
      (changedLines[def.file] ?? []).some(([from, to]) => from <= def.end && to >= def.start),
    )
    .map((def) => def.id);
}
