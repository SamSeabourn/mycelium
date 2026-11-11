/**
 * Diff parsing. Pure — no child_process, no fs — so the renderer can import it
 * without dragging node builtins into the browser bundle.
 */

export type DiffRow =
  | { kind: 'gap'; text: string }
  | { kind: 'context'; leftNo: number; rightNo: number; text: string }
  | { kind: 'change'; leftNo: number | null; left: string | null; rightNo: number | null; right: string | null };

/**
 * Convert git's unified diff into side-by-side rows.
 *
 * git already ran the diff algorithm, so this only has to pair the runs up:
 * consecutive removals line up against consecutive additions, and whichever run is
 * longer leaves blanks on the other side. Pure, so it is testable without a repo.
 */
export const parseUnified = (stdout: string): DiffRow[] => {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let dels: { no: number; text: string }[] = [];
  let adds: { no: number; text: string }[] = [];

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      rows.push({
        kind: 'change',
        leftNo: d ? d.no : null,
        left: d ? d.text : null,
        rightNo: a ? a.no : null,
        right: a ? a.text : null,
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      if (!m) {
        continue;
      }
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      rows.push({ kind: 'gap', text: m[3].trim() });
      continue;
    }

    // Everything before the first @@ is header noise — and "--- a/x" / "+++ b/x"
    // would otherwise be mistaken for content.
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
    if (line === '') {
      continue; // trailing artefact of the split; real blanks are " "
    }

    if (line.startsWith('-')) {
      dels.push({ no: oldNo++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith('+')) {
      adds.push({ no: newNo++, text: line.slice(1) });
      continue;
    }

    flush();
    rows.push({ kind: 'context', leftNo: oldNo++, rightNo: newNo++, text: line.slice(1) });
  }

  flush();
  return rows;
};

/**
 * Narrow a file's diff to one function, per side.
 *
 * `right` is the function's span on the compare branch; `left` its span at the merge
 * base, absent when the function is new. Each side is filtered by its own line
 * numbers, so a removal only appears if it came from this function's old body —
 * previously a deletion inherited the position of the last compare-side line, which
 * let a neighbouring rewrite's removals ride along into an added function's diff.
 *
 * Hunk headers go: the panel already names the function.
 */
export const sliceRows = (
  rows: DiffRow[],
  right: [number, number] | undefined,
  left?: [number, number],
): DiffRow[] => {
  const within = (n: number | null, range?: [number, number]) =>
    n !== null && range !== undefined && n >= range[0] && n <= range[1];

  const out: DiffRow[] = [];

  for (const row of rows) {
    if (row.kind === 'gap') {
      continue;
    }

    if (row.kind === 'context') {
      // A deleted function has no right-hand span; its unchanged lines are judged by
      // the left side instead.
      if (right ? within(row.rightNo, right) : within(row.leftNo, left)) {
        out.push(row);
      }
      continue;
    }

    const keepRight = within(row.rightNo, right);
    const keepLeft = within(row.leftNo, left);
    if (!keepRight && !keepLeft) {
      continue;
    }

    out.push({
      kind: 'change',
      leftNo: keepLeft ? row.leftNo : null,
      left: keepLeft ? row.left : null,
      rightNo: keepRight ? row.rightNo : null,
      right: keepRight ? row.right : null,
    });
  }

  return out;
};

const FADE_FLOOR = 0.3;
const FADE_STEP = 0.12;

/** Per row, how many rows away the nearest change is. Infinity when there is none. */
const changeDistance = (rows: DiffRow[]): number[] => {
  const dist = rows.map(() => Infinity);
  let last = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'change') {
      last = i;
    }
    dist[i] = i - last;
  }
  last = Infinity;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === 'change') {
      last = i;
    }
    dist[i] = Math.min(dist[i], last - i);
  }
  return dist;
};

/**
 * Per row, an opacity from its distance to the nearest change: 1 on or next to a
 * change, easing down to FADE_FLOOR. Draws the eye to the edit inside a whole
 * function. A slice with no changes at all stays fully lit.
 */
export const fadeFor = (rows: DiffRow[]): number[] => {
  return changeDistance(rows).map((d) =>
    d === Infinity ? 1 : Math.max(FADE_FLOOR, 1 - Math.max(0, d - 1) * FADE_STEP),
  );
};

/** Unchanged lines either side of a change that GitHub keeps in a pull request's diff. */
const GITHUB_CONTEXT = 3;

/**
 * Per row, whether GitHub will take a review comment there.
 *
 * It only accepts lines inside the pull request's own hunks — a change and the three
 * lines around it — while the panel shows the whole function. Rows between a context
 * line and its nearest change are all context, one line each, so distance in rows is
 * distance in lines.
 */
export const commentable = (rows: DiffRow[]): boolean[] => {
  return changeDistance(rows).map((d) => d <= GITHUB_CONTEXT);
};

export type SourceLine = { no: number; text: string };

/** Lines `from`..`to` of a file, 1-based and inclusive. */
export const sliceLines = (text: string, from: number, to: number): SourceLine[] => {
  const lines = text.split('\n');
  const out: SourceLine[] = [];
  for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++) {
    out.push({ no: n, text: lines[n - 1] });
  }
  return out;
};

/**
 * Which sides a slice actually uses.
 *
 * Only a removal proves there was a before-version of this function. Context lines
 * exist on both sides by definition, so counting them made an added function look
 * two-sided whenever a shared blank line or brace happened to fall inside its span —
 * which is most of the time.
 */
export const sidesUsed = (rows: DiffRow[]): { left: boolean; right: boolean } => {
  let left = false;
  let right = false;

  for (const row of rows) {
    if (row.kind !== 'change') {
      continue;
    }
    if (row.left !== null) {
      left = true;
    }
    if (row.right !== null) {
      right = true;
    }
  }

  return { left, right };
};
