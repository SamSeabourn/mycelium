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
  /** local binding name -> the name it is exported under, for `import { a as b }` */
  imported: Record<string, string>;
  /** caller function id -> callee names used inside it */
  calls: { from: string; name: string }[];
  /** `obj.name()` where obj is not `this`; resolved later, by name, if unambiguous */
  methodCalls: { from: string; object: string; name: string }[];
};

type AnyNode = { type: string; [key: string]: unknown };

const EXT = /\.[cm]?[jt]sx?$/;

/** JS/TS source, i.e. something that can hold functions. */
export const isSource = (file: string) => EXT.test(file);

type Plugin = 'typescript' | 'jsx' | 'decorators' | 'decoratorAutoAccessors';

// Angular/NestJS/TypeORM put a decorator at the top of the file. Without these babel
// throws on line 1, parseFile swallows it, and the whole file contributes no functions
// — which reads as "it does not diff TS files".
const DECORATORS: Plugin[] = ['decorators', 'decoratorAutoAccessors'];

const pluginsFor = (file: string): Plugin[] => {
  // `jsx` on a .ts file misreads `<T>value` casts as JSX, so only .tsx gets both.
  if (file.endsWith('.tsx')) {
    return ['typescript', 'jsx', ...DECORATORS];
  }
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) {
    return ['typescript', ...DECORATORS];
  }
  return ['jsx', ...DECORATORS];
};

const nameOf = (node: AnyNode): string | null => {
  const key = node.key as AnyNode | undefined;
  const id = node.id as AnyNode | undefined;
  if (id?.type === 'Identifier') {
    return id.name as string;
  }
  if (key?.type === 'Identifier') {
    return key.name as string;
  }
  if (key?.type === 'StringLiteral') {
    return key.value as string;
  }
  return null;
};

const isFunctionNode = (type: string): boolean => {
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ArrowFunctionExpression' ||
    type === 'ClassMethod' ||
    type === 'ObjectMethod' ||
    type === 'ClassPrivateMethod'
  );
};

/**
 * `memo(fn)`, `React.forwardRef(fn)`, `memo(forwardRef(fn))` — the component is the
 * function passed in, not the call, so without this most React components produce no
 * node at all.
 *
 * Only wrapper-shaped callees are unwrapped: a bare identifier, a chained call
 * (`connect(map)(Component)`), or a member on a capitalised object (`React.memo`).
 * That keeps `const total = items.reduce((a, b) => a + b)` from becoming a function.
 */
const unwrapWrapper = (node: AnyNode | undefined): AnyNode | undefined => {
  if (!node) {
    return undefined;
  }
  if (isFunctionNode(node.type)) {
    return node;
  }
  if (node.type !== 'CallExpression') {
    return undefined;
  }

  const callee = node.callee as AnyNode | undefined;
  const object = callee?.object as AnyNode | undefined;
  const wrapperish =
    callee?.type === 'Identifier' ||
    callee?.type === 'CallExpression' ||
    (callee?.type === 'MemberExpression' &&
      object?.type === 'Identifier' &&
      /^[A-Z]/.test(object.name as string));
  if (!wrapperish) {
    return undefined;
  }

  for (const arg of (node.arguments ?? []) as AnyNode[]) {
    const found = unwrapWrapper(arg);
    if (found) {
      return found;
    }
  }
  return undefined;
};

/**
 * A readable name for an anonymous callback, from the call that registers it:
 * `ipcMain.handle('analyse')`, `panel.addEventListener('click')`.
 */
const describeCall = (callee: AnyNode, args: AnyNode[]): string => {
  const object = callee.object as AnyNode | undefined;
  const property = callee.property as AnyNode | undefined;
  let what = 'callback';
  if (callee.type === 'Identifier') {
    what = callee.name as string;
  } else if (callee.type === 'MemberExpression' && property?.type === 'Identifier') {
    what = object?.type === 'Identifier' ? `${object.name}.${property.name}` : (property.name as string);
  }
  const first = args[0];
  if (first?.type === 'StringLiteral') {
    return `${what}('${first.value}')`;
  }
  return what;
};

/**
 * Pull function definitions, imports, and call sites out of one file.
 *
 * tradeoff: name-based resolution, no type information. Calls through a variable
 * (`handlers[k]()`) or a callback passed as an argument will not produce an edge, and
 * `obj.m()` only does when one class alone defines `m`. Upgrade path is the TypeScript checker, which
 * in TS 7 lives behind the `typescript/unstable/*` API — not worth pinning to yet.
 */
/**
 * The id that a file's top-level code calls from: `app.whenReady().then(createWindow)`
 * and every `ipcMain.handle(…)` registration. Without it those functions sit on the
 * map with nothing pointing at them. Never a def, so it has no span and is never
 * itself marked changed.
 */
export const moduleId = (file: string): string => `${file}#${path.basename(file)}`;

export const parseFile = (file: string, code: string): FileFacts => {
  // Null prototype: names are looked up by whatever a file calls, and a call to
  // `constructor()` must not find Object.prototype.constructor.
  const facts: FileFacts = { defs: [], imports: Object.create(null), imported: Object.create(null), calls: [], methodCalls: [] };

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
  const handlerNames = new WeakMap<AnyNode, string>();
  const registrations = new WeakSet<AnyNode>();
  const seen = new Map<string, number>();
  // Two `panel.addEventListener('click')` in one file still need two nodes.
  const handlerName = (callee: AnyNode, args: AnyNode[]): string => {
    const base = describeCall(callee, args);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count === 1) {
      return base;
    }
    return `${base} #${count}`;
  };
  let className: string | null = null;
  // Methods of a named object literal are named after it, the way class methods are:
  // `const awaitVisitor = { AwaitExpression() {} }` and `Program: { exit() {} }`.
  // Babel visitors are full of `enter`/`exit`/`Identifier`; this keeps them apart.
  let objectName: string | null = null;
  const objectNames = new WeakMap<AnyNode, string>();

  // Ids are provisional while walking: two `enter()` visitors in one file must not
  // share a node. Final names are settled once every def is known (see below).
  const nameById = new Map<string, string>();
  const addDef = (name: string, node: AnyNode): true => {
    const loc = node.loc as { start: { line: number }; end: { line: number } } | undefined;
    const id = `${file}#\0${facts.defs.length}`;
    nameById.set(id, name);
    facts.defs.push({ id, file, name, start: loc?.start.line ?? 0, end: loc?.end.line ?? 0 });
    stack.push(id);
    return true;
  };

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const n = node as AnyNode;
    if (typeof n.type !== 'string') {
      return;
    }

    if (n.type === 'ImportDeclaration') {
      const source = (n.source as AnyNode)?.value as string;
      for (const spec of (n.specifiers ?? []) as AnyNode[]) {
        const local = (spec.local as AnyNode)?.name as string;
        if (local && source) {
          facts.imports[local] = source;
          const name = (spec.imported as AnyNode)?.name ?? (spec.imported as AnyNode)?.value;
          if (typeof name === 'string') {
            facts.imported[local] = name;
          }
        }
      }
      return;
    }

    // `<Button />` is how a React component is "called". Without this a TSX repo
    // graphs as a pile of nodes with no edges between them. Lowercase names are host
    // elements (`div`, `span`), not components.
    if (n.type === 'JSXOpeningElement') {
      const jsxName = n.name as AnyNode | undefined;
      const from = stack[stack.length - 1];
      if (from && jsxName?.type === 'JSXIdentifier' && /^[A-Z]/.test(jsxName.name as string)) {
        facts.calls.push({ from, name: jsxName.name as string });
      }
    }

    if (n.type === 'ExpressionStatement' && (n.expression as AnyNode)?.type === 'CallExpression') {
      registrations.add(n.expression as AnyNode);
    }

    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const callee = n.callee as AnyNode | undefined;
      const topLevel = stack.length === 0;
      const from = stack[stack.length - 1] ?? moduleId(file);
      if (from && callee) {
        if (callee.type === 'Identifier') {
          facts.calls.push({ from, name: callee.name as string });
        } else if (
          callee.type === 'MemberExpression' &&
          (callee.object as AnyNode)?.type === 'ThisExpression' &&
          (callee.property as AnyNode)?.type === 'Identifier'
        ) {
          facts.calls.push({ from, name: (callee.property as AnyNode).name as string });
        } else if (
          callee.type === 'MemberExpression' &&
          (callee.object as AnyNode)?.type === 'Identifier' &&
          (callee.property as AnyNode)?.type === 'Identifier'
        ) {
          facts.methodCalls.push({
            from,
            object: (callee.object as AnyNode).name as string,
            name: (callee.property as AnyNode).name as string,
          });
        }
      }

      for (const arg of (n.arguments ?? []) as AnyNode[]) {
        // `requestAnimationFrame(tick)` hands `tick` over rather than calling it, but
        // it still runs because of this function, so it counts as a call.
        if (from && arg.type === 'Identifier') {
          facts.calls.push({ from, name: arg.name as string });
        }
        // `ipcMain.handle('analyse', async () => {…})` at the top of a file: the
        // callback has no name, so without one every call inside it is dropped.
        // Only a call standing as its own statement is a registration; a callback in
        // `const total = items.reduce((a, b) => a + b)` is just part of a value.
        if (topLevel && callee && registrations.has(n) && isFunctionNode(arg.type) && !nameOf(arg)) {
          const name = handlerName(callee, n.arguments as AnyNode[]);
          handlerNames.set(arg, name);
          facts.calls.push({ from, name });
        }
      }
    }

    const prevClass = className;
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      className = nameOf(n) ?? className;
    }
    const prevObject = objectName;
    const value = (n.type === 'VariableDeclarator' ? n.init : n.type === 'ObjectProperty' ? n.value : null) as AnyNode | null;
    if (value?.type === 'ObjectExpression' && nameOf(n)) {
      objectNames.set(value, nameOf(n)!);
    }
    if (n.type === 'ObjectExpression') {
      objectName = objectNames.get(n) ?? null;
    }

    let pushed = false;
    if (isFunctionNode(n.type)) {
      // Arrow and function expressions are anonymous; the useful name is on the
      // variable or property they were assigned to, captured by the parent below.
      const bare = nameOf(n) ?? handlerNames.get(n) ?? null;
      const parent = stack[stack.length - 1];
      let name = bare;
      if (bare && className && (n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod')) {
        name = `${className}.${bare}`;
      } else if (bare && n.type === 'ObjectMethod' && objectName) {
        name = `${objectName}.${bare}`;
      } else if (bare && n.type === 'ObjectMethod' && parent) {
        // An unnamed object, e.g. `path.traverse({ enter() {} })`: its function is the
        // only thing that tells one `enter` from another.
        name = `${bare} (in ${nameById.get(parent)})`;
      }
      if (name) {
        pushed = addDef(name, n);
      }
    }

    // `const foo = () => {}` — name the function after the binding. Also reaches
    // through `memo`/`forwardRef`, which is how most React components are written.
    if (n.type === 'VariableDeclarator') {
      const init = unwrapWrapper(n.init as AnyNode | undefined);
      const name = nameOf(n);
      if (name && init) {
        pushed = addDef(name, init);
      }
    }

    // `export default function () {}` / `export default memo(() => {})` — anonymous,
    // so fall back to the file's basename, which is what the component is called at
    // every import site anyway.
    if (n.type === 'ExportDefaultDeclaration') {
      const decl = unwrapWrapper(n.declaration as AnyNode | undefined);
      if (decl && !nameOf(decl)) {
        const name = path.basename(file).replace(EXT, '');
        pushed = addDef(name, decl);
      }
    }

    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') {
        continue;
      }
      walk(n[key]);
    }

    if (pushed) {
      stack.pop();
    }
    className = prevClass;
    objectName = prevObject;
  };

  walk(ast);

  // Whatever still clashes after the naming above gets a counter, so no two functions
  // ever share a node. tradeoff: the counter follows source order, so a same-named
  // sibling inserted above renumbers the rest; the naming above keeps that rare.
  const finalId = new Map<string, string>();
  const taken = new Map<string, number>();
  for (const def of facts.defs) {
    let name = def.name;
    const n = (taken.get(name) ?? 0) + 1;
    taken.set(name, n);
    if (n > 1) {
      name = `${name} #${n}`;
    }
    finalId.set(def.id, `${file}#${name}`);
    def.id = `${file}#${name}`;
    def.name = name;
  }
  for (const call of [...facts.calls, ...facts.methodCalls]) call.from = finalId.get(call.from) ?? call.from;

  return facts;
};

/**
 * Turn an import source ("./scan") into one of the file keys madge produced,
 * reusing the already-resolved dependency list rather than re-implementing
 * node resolution.
 */
export const resolveImport = (fromFile: string, source: string, deps: string[]): string | null => {
  if (!source.startsWith('.')) {
    return null; // package import — outside the graph
  }

  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), source));
  const strip = (p: string) => p.replace(EXT, '');

  return (
    deps.find((d) => strip(d) === target) ??
    deps.find((d) => strip(d) === `${target}/index`) ??
    null
  );
};

/**
 * Method names the language already has: `items.map()` or `seen.add()` is almost
 * always an array or set, not the one class that happens to define `map`.
 */
const BUILTIN_METHODS = new Set(
  [Array, String, Map, Set, Promise, Object, Number, Date, RegExp, Function].flatMap((c) =>
    Object.getOwnPropertyNames(c.prototype),
  ),
);

/**
 * `cart.add()` still reaches `Cart.add` when the variable is named after the class.
 * tradeoff: naming guess; the TypeScript checker would know the receiver's type.
 */
const receiverNames = (object: string, methodId: string): boolean => {
  const cls = methodId.slice(methodId.indexOf('#') + 1).split('.')[0];
  return object.toLowerCase().includes(cls.toLowerCase());
};

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
export const buildFunctionGraph = (
  files: string[],
  fileGraph: Record<string, string[]>,
  read: (file: string) => string | null,
  // A caller that has already parsed these files hands its results back in here
  // rather than paying for Babel twice.
  parse: (file: string, code: string) => FileFacts = parseFile,
): FnGraph => {
  const facts = new Map<string, FileFacts>();
  const byName = new Map<string, Map<string, string>>(); // file -> name -> fn id

  for (const file of files) {
    const code = read(file);
    if (code === null) {
      continue;
    }
    const f = parse(file, code);
    facts.set(file, f);

    const names = new Map<string, string>();
    for (const def of f.defs) {
      names.set(def.name, def.id);
      // `Foo.bar` should also answer to `bar` for `this.bar()` calls.
      const dot = def.name.indexOf('.');
      if (dot > 0 && !names.has(def.name.slice(dot + 1))) {
        names.set(def.name.slice(dot + 1), def.id);
      }
    }
    byName.set(file, names);
  }

  // method name -> every class method by that name, across all parsed files.
  const methods = new Map<string, string[]>();
  for (const f of facts.values()) {
    for (const def of f.defs) {
      const dot = def.name.indexOf('.');
      if (dot > 0) {
        methods.set(def.name.slice(dot + 1), [...(methods.get(def.name.slice(dot + 1)) ?? []), def.id]);
      }
    }
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
        // `import { install as installMap }`: the target file knows it as `install`.
        const exported = facts_.imported[call.name] ?? call.name;
        const resolved = source ? resolveImport(f, source, fileGraph[f] ?? []) : null;

        if (resolved && !byName.has(resolved)) {
          // Resolves to a real file we deliberately did not parse — it fell outside
          // the hop window. Recording it keeps the graph honest about the edge
          // rather than silently dropping it.
          const id = `${resolved}#${exported}`;
          ghosts[call.from] ??= [];
          if (!ghosts[call.from].includes(id)) {
            ghosts[call.from].push(id);
          }
          continue;
        }

        if (resolved) {
          target = byName.get(resolved)?.get(exported);
        }
      }

      if (!target || target === call.from) {
        continue;
      }
      graph[call.from] ??= [];
      if (!graph[call.from].includes(target)) {
        graph[call.from].push(target);
      }
    }

    for (const call of facts_.methodCalls) {
      // `utils.format()` off `import * as utils` — the import says exactly which file.
      const source = facts_.imports[call.object];
      const resolved = source ? resolveImport(f, source, fileGraph[f] ?? []) : null;
      let target = resolved ? byName.get(resolved)?.get(call.name) : undefined;
      // `cart.total()` — no types, so only trust it when exactly one class has `total`.
      // `console.log()` / `Math.max()` are globals, never ours.
      if (!target && !source && !(call.object in globalThis)) {
        const owners = methods.get(call.name) ?? [];
        if (owners.length === 1 && (!BUILTIN_METHODS.has(call.name) || receiverNames(call.object, owners[0]))) {
          target = owners[0];
        }
      }
      if (!target || target === call.from) {
        continue;
      }
      graph[call.from] ??= [];
      if (!graph[call.from].includes(target)) {
        graph[call.from].push(target);
      }
    }
  }

  // A file's top-level code only becomes a node once it calls something of ours.
  for (const f of facts.keys()) {
    const top = moduleId(f);
    if (graph[top]) {
      label[top] = path.basename(f);
      file[top] = f;
    }
  }

  return { graph, label, file, ghosts, span };
};

/**
 * Added or modified, judged by the function rather than by its file.
 *
 * Inheriting the file's status labels every new function inside an edited file as
 * "modified", which promises a before/after that never existed — the diff comes back
 * all additions and looks broken.
 */
export const functionStatus = (
  fnName: string,
  fileStatus: 'A' | 'M' | 'D' | 'R' | undefined,
  baseNames: Set<string> | undefined,
): 'A' | 'M' => {
  if (fileStatus === 'A') {
    return 'A'; // the whole file is new
  }
  // Base side unreadable: assume an edit rather than relabelling everything as new.
  if (!baseNames) {
    return 'M';
  }
  return baseNames.has(fnName) ? 'M' : 'A';
};

/** A function counts as changed when a changed line falls inside its span. */
export const markChangedFunctions = (
  defs: FnDef[],
  changedLines: Record<string, [number, number][]>,
): string[] => {
  return defs
    .filter((def) =>
      (changedLines[def.file] ?? []).some(([from, to]) => from <= def.end && to >= def.start),
    )
    .map((def) => def.id);
};

/**
 * Calls present in `before` but gone from `after`, keyed by caller.
 * Only callers in `changedFiles` can have dropped a call — everything else is the
 * same source on both sides.
 */
export const removedCalls = (
  before: FnGraph,
  after: Record<string, string[]>,
  changedFiles: Set<string>,
): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [caller, callees] of Object.entries(before.graph)) {
    if (!changedFiles.has(before.file[caller])) {
      continue;
    }
    const gone = callees.filter((c) => !(after[caller] ?? []).includes(c));
    if (gone.length > 0) {
      out[caller] = gone;
    }
  }
  return out;
};
