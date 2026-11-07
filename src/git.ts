import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUnified, sliceRows, type DiffRow } from './diff';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export type GitResult<T> = ({ ok: true } & T) | { ok: false; error: string };

// execFile, never exec: branch names reach git as argv entries, so nothing in them
// is ever interpreted by a shell.
const git = async (root: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

const message = (e: unknown): string => {
  const err = e as { stderr?: string; message?: string };
  const text = (err.stderr || err.message || String(e)).trim();
  // git prints its whole usage screen on a malformed invocation. The first line is
  // the actual complaint; the rest is a manual nobody wants pasted into a panel.
  const first = text.split('\n')[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
};

/**
 * Parse `git diff --name-status` output. Split from the exec call so it can be
 * tested without building a git fixture.
 */
export const parseNameStatus = (stdout: string): Record<string, ChangeStatus> => {
  const files: Record<string, ChangeStatus> = {};

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const code = parts[0]?.[0];
    if (!code) {
      continue;
    }

    // Renames and copies come through as "R100\told\tnew" — the new path is what
    // exists on the compare branch, so that is the one worth graphing.
    const renamed = code === 'R' || code === 'C';
    const file = renamed ? parts[2] : parts[1];
    if (!file) {
      continue;
    }

    if (code === 'A' || code === 'M' || code === 'D' || code === 'R') {
      files[file] = code;
    } else if (code === 'C') {
      files[file] = 'A';
    }
  }

  return files;
};

/** new path -> old path for every rename in `git diff --name-status` output. */
export const parseRenames = (stdout: string): Record<string, string> => {
  const from: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const [code, before, after] = line.split('\t');
    if (code?.startsWith('R') && before && after) {
      from[after] = before;
    }
  }
  return from;
};

/**
 * Parse `git diff -U0` into per-file line ranges on the compare side.
 * Split from the exec call so it can be tested without a git fixture.
 */
export const parseHunks = (stdout: string): Record<string, [number, number][]> => {
  const ranges: Record<string, [number, number][]> = {};
  let file: string | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }

    if (!file || !line.startsWith('@@')) {
      continue;
    }

    // "@@ -12,0 +13,4 @@" — the +side is what exists on the compare branch.
    const m = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!m) {
      continue;
    }

    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      continue; // pure deletion, nothing on this side to mark
    }

    (ranges[file] ??= []).push([start, start + count - 1]);
  }

  return ranges;
};

/**
 * What a diff runs over. A branch that is not checked out: its commits since it left
 * `base`. The checked-out branch: the working tree against the merge base, so
 * uncommitted edits are in the diff exactly as they are in the scan. Without this the
 * scan's line numbers were applied to the committed file, and the panel showed a
 * slice of whatever code used to sit on those lines.
 */
export const diffRevs = (base: string, compare: string, since: string, worktree: boolean): string[] => {
  if (worktree) {
    return [since];
  }
  return [`${base}...${compare}`];
};

export const changedLines = async (
  root: string,
  revs: string[],
): Promise<GitResult<{ lines: Record<string, [number, number][]> }>> => {
  try {
    const stdout = await git(root, ['diff', '-U0', '--no-color', ...revs]);
    return { ok: true, lines: parseHunks(stdout) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
};

export const fileDiff = async (
  root: string,
  revs: string[],
  file: string,
  range?: [number, number],
  baseRange?: [number, number],
  from?: string,
): Promise<GitResult<{ rows: DiffRow[] }>> => {
  try {
    // Whole file as context: one hunk, so a sliced function comes back complete
    // instead of as change fragments with the unchanged middle silently missing.
    // A renamed file needs both paths in the pathspec, or git cannot pair them and
    // reports the new path as wholly added.
    const paths = from ? [from, file] : [file];
    let stdout = await git(root, ['diff', '-M', '-U1000000', '--no-color', ...revs, '--', ...paths]);
    // An untracked file is invisible to `git diff <rev>`; diff it against nothing.
    if (!stdout && revs.length === 1) {
      stdout = await git(root, ['diff', '--no-index', '-U1000000', '--no-color', '--', '/dev/null', file]).catch(
        // --no-index exits 1 when the files differ, which they always do here.
        (e: { stdout?: string }) => e.stdout ?? '',
      );
    }
    const rows = parseUnified(stdout);
    return { ok: true, rows: range || baseRange ? sliceRows(rows, range, baseRange) : rows };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
};

/**
 * The commit the diff is actually measured from.
 *
 * `git diff base...compare` compares merge-base to compare, so anything landing on
 * `base` after the branch diverged is not in the diff. Reading the base side at the
 * branch tip instead would show functions the diff never mentioned.
 */
export const mergeBase = async (root: string, base: string, compare: string): Promise<string> => {
  try {
    return (await git(root, ['merge-base', base, compare])).trim();
  } catch {
    return base; // unrelated histories; the tip is the best answer available
  }
};

/** File contents at a ref, or null when the file does not exist there. */
export const showFile = async (root: string, ref: string, file: string): Promise<string | null> => {
  try {
    return await git(root, ['show', `${ref}:${file}`]);
  } catch {
    return null; // a file added on the compare branch is absent here, not an error
  }
};

export const branches = async (root: string): Promise<GitResult<{ all: string[]; current: string }>> => {
  try {
    const all = (await git(root, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);

    if (all.length === 0) {
      return { ok: false, error: 'Repository has no commits yet' };
    }

    const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return { ok: true, all, current };
  } catch (e) {
    const text = message(e);
    return {
      ok: false,
      error: /not a git repository/i.test(text) ? 'Not a git repository' : text,
    };
  }
};

export const changedFiles = async (
  root: string,
  revs: string[],
): Promise<GitResult<{ files: Record<string, ChangeStatus>; from: Record<string, string> }>> => {
  try {
    const stdout = await git(root, ['diff', '--name-status', ...revs]);
    return { ok: true, files: parseNameStatus(stdout), from: parseRenames(stdout) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
};

/** New files not yet added to git: part of the working tree, absent from every diff. */
export const untrackedFiles = async (root: string): Promise<string[]> => {
  try {
    return (await git(root, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Run `fn` against a throwaway checkout of `branch`.
 *
 * madge reads the filesystem, so scanning a branch that is not checked out would
 * otherwise graph whatever happens to be on disk.
 */
export const withBranchCheckout = async <T>(
  root: string,
  branch: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
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
};
