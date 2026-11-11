import { execFile } from 'node:child_process';
import type { GitResult } from './git';

/**
 * GitHub, by way of the `gh` CLI the user is already logged into. No token ever
 * passes through mycelium: gh keeps it, and gh works out owner/repo from the remotes.
 */

export type Pr = { number: number; title: string; author: string; base: string; head: string; draft: boolean };

export type Side = 'LEFT' | 'RIGHT';

export type PrComment = { id: number; path: string; line: number; side: Side; body: string; user: string; at: string };

export type Draft = { path: string; line: number; side: Side; body: string };

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export const REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

/**
 * What went wrong, in a line. gh puts its own summary on stderr ("gh: Validation
 * Failed (HTTP 422)") and GitHub's reasons in the JSON body on stdout, and the
 * reasons are the part worth reading: "Can not approve your own pull request".
 */
export const ghError = (stderr: string, stdout: string): string => {
  const summary = stderr.trim().split('\n')[0].replace(/^gh: /, '');
  let reasons: string[] = [];
  try {
    const errors: unknown[] = JSON.parse(stdout).errors ?? [];
    reasons = errors
      .map((e) => (typeof e === 'string' ? e : ((e as { message?: string }).message ?? '')))
      .filter(Boolean);
  } catch {
    // Not a JSON body — a network failure, or gh never reached GitHub at all.
  }
  return [summary, ...reasons].filter(Boolean).join(': ') || 'gh failed';
};

/** execFile, never exec, for the same reason as git.ts: arguments stay arguments. */
const gh = (root: string, args: string[], input = ''): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'GitHub CLI (gh) not found on PATH' : ghError(stderr || err.message, stdout)));
      },
    );
    child.stdin?.end(input);
  });
};

/** Parse `gh pr list --json number,title,author,headRefName,baseRefName,isDraft`. */
export const parsePrs = (stdout: string): Pr[] => {
  const list: {
    number: number;
    title: string;
    author?: { login?: string };
    headRefName: string;
    baseRefName: string;
    isDraft?: boolean;
  }[] = JSON.parse(stdout);

  return list.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.author?.login ?? '',
    base: p.baseRefName,
    head: p.headRefName,
    draft: p.isDraft === true,
  }));
};

/** One compact object per line, so pages of results concatenate without re-parsing. */
const COMMENT_FIELDS =
  '.[] | {id, path, line, side, body, user: .user.login, at: .created_at}';

/**
 * Parse the review comments of a pull request, one JSON object per line.
 *
 * A comment whose code has since changed comes back with `line: null` — GitHub calls
 * it outdated. There is nowhere on the current diff to hang it, so it is dropped.
 */
export const parseComments = (stdout: string): PrComment[] => {
  const out: PrComment[] = [];
  for (const row of stdout.split('\n')) {
    if (!row.trim()) {
      continue;
    }
    const c = JSON.parse(row);
    if (typeof c.line !== 'number' || typeof c.path !== 'string') {
      continue;
    }
    out.push({
      id: c.id,
      path: c.path,
      line: c.line,
      side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      body: c.body ?? '',
      user: c.user ?? '',
      at: c.at ?? '',
    });
  }
  return out;
};

/** The body of `POST /pulls/{n}/reviews`: every draft lands in one review. */
export const reviewPayload = (sha: string, event: ReviewEvent, body: string, drafts: Draft[]): string => {
  return JSON.stringify({
    commit_id: sha,
    event,
    // An empty string is not "no body" to GitHub; leave the key out instead.
    ...(body.trim() ? { body: body.trim() } : {}),
    comments: drafts.map((d) => ({ path: d.path, line: d.line, side: d.side, body: d.body })),
  });
};

const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: (e as Error).message });

export const listPrs = async (root: string): Promise<GitResult<{ prs: Pr[] }>> => {
  try {
    const stdout = await gh(root, [
      'pr',
      'list',
      // tradeoff: first 50 open PRs, newest first. Add a search box if a repo outgrows it.
      '--limit',
      '50',
      '--json',
      'number,title,author,headRefName,baseRefName,isDraft',
    ]);
    return { ok: true, prs: parsePrs(stdout) };
  } catch (e) {
    return fail(e);
  }
};

export const prComments = async (root: string, number: number): Promise<GitResult<{ comments: PrComment[] }>> => {
  try {
    const stdout = await gh(root, [
      'api',
      `repos/{owner}/{repo}/pulls/${number}/comments`,
      '--paginate',
      '--jq',
      COMMENT_FIELDS,
    ]);
    return { ok: true, comments: parseComments(stdout) };
  } catch (e) {
    return fail(e);
  }
};

export const submitReview = async (
  root: string,
  number: number,
  sha: string,
  event: ReviewEvent,
  body: string,
  drafts: Draft[],
): Promise<GitResult<object>> => {
  try {
    await gh(
      root,
      ['api', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'],
      reviewPayload(sha, event, body, drafts),
    );
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
};
