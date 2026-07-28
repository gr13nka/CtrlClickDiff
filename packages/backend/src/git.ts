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
import type { BranchInfo, ChangedFile, CommitInfo, FileStatus } from '@ctrlclickdiff/shared';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024; // 64MB — generous ceiling for `git log`/`git show` stdout.

/**
 * SHA of the empty tree (`git hash-object -t tree /dev/null`) — a git constant,
 * identical in every repository. Used as the synthetic base side for root
 * commits, which have no parent to `rev-parse`.
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Every function here takes the repository to operate on as its first argument.
 * There is deliberately no module-level "current repo" and no REPO_ROOT lookup:
 * one process serves many repositories (see repos.ts), and the caller — which
 * has the request in hand — is the only party that knows which one a given call
 * is for. Reintroducing a cached default here would silently answer some
 * requests from the wrong repository.
 */

/** execFile('git', args, {cwd: repoRoot, ...}) — see the safety rule above. */
async function run(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * `git rev-parse --show-toplevel` with `cwd` = `dir` — the absolute path of the
 * working tree `dir` belongs to, whether `dir` is the repository root or any
 * directory beneath it. Rejects when `dir` is not inside a working tree at all
 * (including a bare repository, which has none), which is how `repos.ts`
 * distinguishes "a directory" from "a repository it can serve".
 *
 * Note the argument here is a plain cwd, not necessarily a repo root — that is
 * the whole point: callers use this to *find* the root.
 */
export async function revParseToplevel(dir: string): Promise<string> {
  const stdout = await run(dir, ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

/**
 * `git log --format=%H%x00%s%x00%an%x00%aI -n 100 <ref>`, split on NUL per record.
 *
 * `ref` defaults to `HEAD` so callers that predate branch selection are
 * unaffected. It is expected to be a full refname from `listBranches()`, and is
 * fenced off three ways *in addition to* the route's schema whitelist. The
 * redundancy is deliberate: `run()` uses execFile, so there is no shell to
 * inject into, but `ref` still lands in git's own argv where git — not a shell —
 * is the thing that can be talked into doing something else.
 *
 *   1. A leading `-` is rejected here rather than only at the route, so a future
 *      caller that reaches this function by some other path (a CLI, a test, a
 *      new endpoint) cannot pass `--output=/tmp/x` and have git write a file.
 *   2. `--end-of-options` is the airtight form of the same rule: everything
 *      after it is a revision or path, never an option, whatever it starts with.
 *   3. The trailing `--` closes the other end. Without it, a ref whose name also
 *      matches a file in the tree is ambiguous, and git may read the argument as
 *      a pathspec — silently logging that file's history instead of the branch.
 */
export async function listCommits(repoRoot: string, ref = 'HEAD'): Promise<CommitInfo[]> {
  if (ref.startsWith('-')) {
    throw new Error(`refusing to treat an option-like ref as a revision: ${ref}`);
  }
  const stdout = await run(repoRoot, [
    'log',
    '--format=%H%x00%s%x00%an%x00%aI',
    '-n',
    '100',
    '--end-of-options',
    ref,
    '--',
  ]);
  const commits: CommitInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue; // trailing newline from git log
    const [sha, subject, author, date] = line.split('\x00');
    commits.push({ sha, subject: subject ?? '', author: author ?? '', date: date ?? '' });
  }
  return commits;
}

/**
 * Every local and remote-tracking branch, as `git for-each-ref` reports them.
 *
 * The format asks for `%(refname)` — the **full** refname — rather than the
 * shorter `%(refname:short)`, for two reasons. It is unambiguous (a local branch
 * may legitimately be named `origin/main`, which `:short` renders identically to
 * remote `refs/remotes/origin/main`), and it is exactly the form `git log` is
 * later handed, so the value the picker sends back needs no re-expansion and
 * cannot re-expand to a different ref than the one listed here.
 *
 * `%(HEAD)` yields `*` for the ref HEAD points at and a space otherwise, which
 * is why no separate `symbolic-ref` call is needed to find the current branch.
 */
export async function listBranches(repoRoot: string): Promise<BranchInfo[]> {
  const stdout = await run(repoRoot, [
    'for-each-ref',
    '--format=%(HEAD)%00%(refname)%00%(objectname)',
    'refs/heads',
    'refs/remotes',
  ]);

  const branches: BranchInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [head, ref, tipSha] = line.split('\x00');
    if (!ref || !tipSha) continue;

    // `refs/remotes/<remote>/HEAD` is a symref pointing at another ref in this
    // very list, not a branch of its own — listing it would show the remote's
    // default branch twice under two names.
    if (ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD')) continue;

    const kind = ref.startsWith('refs/remotes/') ? 'remote' : 'local';
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    branches.push({ ref, name, kind, isHead: head === '*', tipSha });
  }

  // Detached HEAD: no ref carries `*`, so without this the picker would show a
  // list in which nothing is current — or, in a repo checked out at a bare
  // commit with no branches at all, an empty list. The synthetic entry is a
  // real, `git log`-able rev ('HEAD'), so selecting it works like any other.
  if (!branches.some((b) => b.isHead)) {
    branches.unshift({
      ref: 'HEAD',
      name: 'HEAD (detached)',
      kind: 'local',
      isHead: true,
      tipSha: await resolveSha(repoRoot, 'HEAD'),
    });
  }

  return branches;
}

/**
 * Resolve a ref (sha, abbreviated sha, `HEAD`, ...) to its full 40-char SHA via
 * `git rev-parse <rev>`. Used so `CommitFiles.headSha` is always a concrete,
 * collision-free identifier for model URIs (`file:///<sha>/<path>`) regardless
 * of what the caller passed in the URL.
 */
export async function resolveSha(repoRoot: string, rev: string): Promise<string> {
  const stdout = await run(repoRoot, ['rev-parse', rev]);
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
export async function changedKtFiles(repoRoot: string, sha: string): Promise<ChangedFile[]> {
  const stdout = await run(repoRoot, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', sha]);
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
export async function listKtFilesAtRev(repoRoot: string, rev: string): Promise<string[]> {
  const stdout = await run(repoRoot, ['ls-tree', '-r', '--name-only', rev]);
  return stdout.split('\n').filter((path) => path.endsWith('.kt'));
}

/**
 * Resolve the base (pre-commit) side to a concrete SHA: `git rev-parse <sha>^`,
 * or the empty-tree hash for a root commit (which has no parent — rev-parse
 * exits non-zero and we catch that as "no parent" rather than a real error).
 */
export async function resolveBaseSha(repoRoot: string, sha: string): Promise<string> {
  try {
    const stdout = await run(repoRoot, ['rev-parse', `${sha}^`]);
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
export async function showFile(repoRoot: string, rev: string, path: string): Promise<string> {
  try {
    return await run(repoRoot, ['show', `${rev}:${path}`]);
  } catch {
    return '';
  }
}
