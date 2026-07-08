// Git backend for Milestone 2 — see peekdiff-mvp-iterative-wind.md,
// "Milestone 2 — Git backend (Fastify)".
//
// SAFETY RULE (do not violate): every git invocation goes through `run()`, which
// calls `execFile('git', args, ...)` with an **argument array**, never a shell
// string. execFile does not spawn a shell, so there is no shell metacharacter
// injection surface even though `path`/`sha` here originate from request
// query/params — a `sha` or `path` containing `; rm -rf /` etc. is just an inert
// argv element to git, never interpreted by a shell.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangedFile, CommitInfo, FileStatus } from '@ctrlclickdiff/shared';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024; // 64MB — generous ceiling for `git log`/`git show` stdout.

/**
 * SHA of the empty tree (`git hash-object -t tree /dev/null`) — a git constant,
 * identical in every repository. Used as the synthetic base side for root
 * commits, which have no parent to `rev-parse`.
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

let cachedRepoRoot: string | undefined;

/**
 * Resolve REPO_ROOT from the environment, memoized after the first successful
 * read. This backend serves exactly one git repository (see the M2 API
 * contract) — a missing REPO_ROOT is a misconfiguration, not a per-request
 * condition, so this throws a clear, actionable error rather than letting git
 * fail later with a confusing ENOENT/cwd error.
 */
export function getRepoRoot(): string {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  const root = process.env.REPO_ROOT;
  if (!root) {
    throw new Error(
      'REPO_ROOT environment variable is not set. CtrlClickDiff serves a single ' +
        'git repository whose path must be supplied via REPO_ROOT, e.g.\n' +
        '  REPO_ROOT=/path/to/repo pnpm --filter @ctrlclickdiff/backend dev',
    );
  }
  cachedRepoRoot = root;
  return cachedRepoRoot;
}

/** execFile('git', args, {cwd: REPO_ROOT, ...}) — see the safety rule above. */
async function run(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: getRepoRoot(),
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

/** `git log --format=%H%x00%s%x00%an -n 100`, split on NUL per record. */
export async function listCommits(): Promise<CommitInfo[]> {
  const stdout = await run(['log', '--format=%H%x00%s%x00%an', '-n', '100']);
  const commits: CommitInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue; // trailing newline from git log
    const [sha, subject, author] = line.split('\x00');
    commits.push({ sha, subject: subject ?? '', author: author ?? '' });
  }
  return commits;
}

/**
 * Resolve a ref (sha, abbreviated sha, `HEAD`, ...) to its full 40-char SHA via
 * `git rev-parse <rev>`. Used so `CommitFiles.headSha` is always a concrete,
 * collision-free identifier for model URIs (`file:///<sha>/<path>`) regardless
 * of what the caller passed in the URL.
 */
export async function resolveSha(rev: string): Promise<string> {
  const stdout = await run(['rev-parse', rev]);
  return stdout.trim();
}

/**
 * `git diff-tree --root --no-commit-id --name-status -r <sha>`, filtered to
 * `.kt` paths only, mapped to {path, status}. `--root` is what makes this work
 * for a repo's very first commit (diff against the empty tree instead of
 * erroring for lack of a parent).
 *
 * Rename/copy statuses (R100, C100, ...) are deliberately dropped — the M2
 * contract's FileStatus is only 'A' | 'M' | 'D'; treating a rename as a plain
 * add+delete pair is out of scope for the MVP (no rename-aware UI).
 */
export async function changedKtFiles(sha: string): Promise<ChangedFile[]> {
  const stdout = await run(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', sha]);
  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [statusField, ...pathParts] = line.split('\t');
    const status = statusField?.[0];
    if (status !== 'A' && status !== 'M' && status !== 'D') continue;
    const path = pathParts[pathParts.length - 1];
    if (!path || !path.endsWith('.kt')) continue;
    files.push({ path, status: status as FileStatus });
  }
  return files;
}

/**
 * `git ls-tree -r --name-only <rev>`, filtered to `.kt` paths — the file
 * list `TreeSitterResolver.buildIndex` parses to build a revision's symbol
 * index (Milestone 3).
 */
export async function listKtFilesAtRev(rev: string): Promise<string[]> {
  const stdout = await run(['ls-tree', '-r', '--name-only', rev]);
  return stdout.split('\n').filter((path) => path.endsWith('.kt'));
}

/**
 * Resolve the base (pre-commit) side to a concrete SHA: `git rev-parse <sha>^`,
 * or the empty-tree hash for a root commit (which has no parent — rev-parse
 * exits non-zero and we catch that as "no parent" rather than a real error).
 */
export async function resolveBaseSha(sha: string): Promise<string> {
  try {
    const stdout = await run(['rev-parse', `${sha}^`]);
    return stdout.trim();
  } catch {
    return EMPTY_TREE_SHA;
  }
}

/**
 * `git show <rev>:<path>`. On any non-zero exit (path added at this rev so it
 * doesn't exist at the base side, path deleted so it doesn't exist at the head
 * side, or rev is the empty-tree hash so nothing exists at all) returns '' —
 * required so one-sided diffs (added/deleted files, root-commit base side)
 * render as an empty original/modified model instead of erroring.
 */
export async function showFile(rev: string, path: string): Promise<string> {
  try {
    return await run(['show', `${rev}:${path}`]);
  } catch {
    return '';
  }
}
