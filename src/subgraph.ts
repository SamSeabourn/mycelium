/** How far out from a changed file still counts as related. */
export const HOPS = 5;

/**
 * Pick the changed files plus everything within `hops` of them.
 *
 * Traversal is undirected on purpose: a changed file's importers matter (they may
 * break) and so do its imports (they explain what it now depends on). Kept free of
 * dependencies so the test can require it without a bundler or a DOM.
 */
export const withinHops = (
  graph: Record<string, string[]>,
  seeds: string[],
  hops: number,
): { files: Set<string>; distance: Map<string, number> } => {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) {
      neighbours.set(a, new Set());
    }
    neighbours.get(a)!.add(b);
  };

  for (const [file, deps] of Object.entries(graph)) {
    for (const dep of deps) {
      link(file, dep);
      link(dep, file);
    }
  }

  const distance = new Map<string, number>();
  let frontier: string[] = [];

  for (const seed of seeds) {
    if (!distance.has(seed)) {
      distance.set(seed, 0);
      frontier.push(seed);
    }
  }

  for (let depth = 1; depth <= hops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const n of neighbours.get(file) ?? []) {
        if (distance.has(n)) {
          continue;
        }
        distance.set(n, depth);
        next.push(n);
      }
    }
    frontier = next;
  }

  return { files: new Set(distance.keys()), distance };
};

