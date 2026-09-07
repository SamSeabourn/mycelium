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
export function parseUnified(stdout: string): DiffRow[] {
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
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      rows.push({ kind: 'gap', text: m[3].trim() });
      continue;
    }

    // Everything before the first @@ is header noise — and "--- a/x" / "+++ b/x"
    // would otherwise be mistaken for content.
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line === '') continue; // trailing artefact of the split; real blanks are " "

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
}

/**
 * Narrow a file's diff to one function's line range on the compare side.
 *
 * Deletions have no compare-side line number, so they inherit the position of the
 * last line that did — otherwise a removed line would be dropped from the very
 * function whose diff you asked to see. Hunk headers go: the panel already names
 * the function, so they are noise at this scale.
 */
export function sliceRows(rows: DiffRow[], from: number, to: number): DiffRow[] {
  let at = 0;
  const out: DiffRow[] = [];

  for (const row of rows) {
    if (row.kind === 'gap') continue;
    if (row.kind === 'context') at = row.rightNo;
    else if (row.rightNo !== null) at = row.rightNo;
    // else: pure deletion — keep `at` where it was.

    if (at >= from && at <= to) out.push(row);
  }

  return out;
}

export type UnifiedLine =
  | { kind: 'context'; no: number; text: string }
  | { kind: 'del'; no: number; text: string }
  | { kind: 'add'; no: number; text: string };

/**
 * Flatten side-by-side rows into a single column.
 *
 * `parseUnified` pairs a run of removals against a run of additions by position,
 * which is right for a small edit and meaningless for a rewritten function — old
 * line 94 ends up opposite new line 106 for no reason, and the left column then
 * runs blank for the rest of the additions. Unified drops the pairing: all removals
 * in a run, then all additions.
 */
export function toUnified(rows: DiffRow[]): UnifiedLine[] {
  const out: UnifiedLine[] = [];
  let dels: UnifiedLine[] = [];
  let adds: UnifiedLine[] = [];

  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.kind === 'gap') continue;

    if (row.kind === 'context') {
      flush();
      out.push({ kind: 'context', no: row.rightNo, text: row.text });
      continue;
    }

    if (row.left !== null) dels.push({ kind: 'del', no: row.leftNo ?? 0, text: row.left });
    if (row.right !== null) adds.push({ kind: 'add', no: row.rightNo ?? 0, text: row.right });
  }

  flush();
  return out;
}
