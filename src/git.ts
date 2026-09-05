import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export type GitResult<T> = ({ ok: true } & T) | { ok: false; error: string };

// execFile, never exec: branch names reach git as argv entries, so nothing in them
// is ever interpreted by a shell.
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function message(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const text = (err.stderr || err.message || String(e)).trim();
  // git prints its whole usage screen on a malformed invocation. The first line is
  // the actual complaint; the rest is a manual nobody wants pasted into a panel.
  const first = text.split('\n')[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

/**
 * Parse `git diff --name-status` output. Split from the exec call so it can be
 * tested without building a git fixture.
 */
export function parseNameStatus(stdout: string): Record<string, ChangeStatus> {
  const files: Record<string, ChangeStatus> = {};

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.[0];
    if (!code) continue;

    // Renames and copies come through as "R100\told\tnew" — the new path is what
    // exists on the compare branch, so that is the one worth graphing.
    const renamed = code === 'R' || code === 'C';
    const file = renamed ? parts[2] : parts[1];
    if (!file) continue;

    if (code === 'A' || code === 'M' || code === 'D' || code === 'R') files[file] = code;
    else if (code === 'C') files[file] = 'A';
  }

  return files;
}

/**
 * Parse `git diff -U0` into per-file line ranges on the compare side.
 * Split from the exec call so it can be tested without a git fixture.
 */
export function parseHunks(stdout: string): Record<string, [number, number][]> {
  const ranges: Record<string, [number, number][]> = {};
  let file: string | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }

    if (!file || !line.startsWith('@@')) continue;

    // "@@ -12,0 +13,4 @@" — the +side is what exists on the compare branch.
    const m = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!m) continue;

    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue; // pure deletion, nothing on this side to mark

    (ranges[file] ??= []).push([start, start + count - 1]);
  }

  return ranges;
}

export async function changedLines(
  root: string,
  base: string,
  compare: string,
): Promise<GitResult<{ lines: Record<string, [number, number][]> }>> {
  try {
    const stdout = await git(root, ['diff', '-U0', '--no-color', `${base}...${compare}`]);
    return { ok: true, lines: parseHunks(stdout) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

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

export async function fileDiff(
  root: string,
  base: string,
  compare: string,
  file: string,
): Promise<GitResult<{ rows: DiffRow[] }>> {
  try {
    const stdout = await git(root, ['diff', '--no-color', `${base}...${compare}`, '--', file]);
    return { ok: true, rows: parseUnified(stdout) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function branches(root: string): Promise<GitResult<{ all: string[]; current: string }>> {
  try {
    const all = (await git(root, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);

    if (all.length === 0) return { ok: false, error: 'Repository has no commits yet' };

    const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return { ok: true, all, current };
  } catch (e) {
    const text = message(e);
    return {
      ok: false,
      error: /not a git repository/i.test(text) ? 'Not a git repository' : text,
    };
  }
}

export async function changedFiles(
  root: string,
  base: string,
  compare: string,
): Promise<GitResult<{ files: Record<string, ChangeStatus> }>> {
  try {
    // Three dots: only what happened on `compare` since it diverged from `base`.
    const stdout = await git(root, ['diff', '--name-status', `${base}...${compare}`]);
    return { ok: true, files: parseNameStatus(stdout) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Run `fn` against a throwaway checkout of `branch`.
 *
 * madge reads the filesystem, so scanning a branch that is not checked out would
 * otherwise graph whatever happens to be on disk.
 */
export async function withBranchCheckout<T>(
  root: string,
  branch: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'diffish-'));
  // `git worktree add` refuses a path that already exists, so point it at a child
  // of the temp dir rather than the temp dir itself.
  const dir = path.join(parent, 'tree');
  try {
    await git(root, ['worktree', 'add', '--detach', dir, branch]);
    return await fn(dir);
  } finally {
    await git(root, ['worktree', 'remove', '--force', dir]).catch(() => {});
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  }
}
