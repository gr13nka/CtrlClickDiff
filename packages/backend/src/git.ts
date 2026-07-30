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
import { isSourcePath, type BranchInfo, type ChangedFile, type CommitInfo } from '@ctrlclickdiff/shared';

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
 * `git rev-parse --path-format=absolute --git-common-dir` — the directory that
 * actually holds this repository's `refs/`, `HEAD`, and `packed-refs`.
 *
 * The *common* dir, not `--git-dir`, because they differ in a linked worktree:
 * `--git-dir` there is `.git/worktrees/<name>`, which has its own `HEAD` but no
 * `refs/heads` at all — watching it would miss every branch update in the
 * repository. `--path-format=absolute` (git ≥ 2.31) is what makes the result
 * usable as a path regardless of the process's cwd; without it git may answer
 * with a relative path.
 */
export async function gitCommonDir(repoRoot: string): Promise<string> {
  const stdout = await run(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return stdout.trim();
}

/**
 * How many commits a single `listCommits` walk returns.
 *
 * Exported because it is not only this function's business: it is also the
 * ceiling on what a *selection* can name, since a selection is assembled from
 * commits the picker listed. server.ts's /api/preview enforces that, and the
 * two must not be able to drift apart into two different hundreds.
 */
export const COMMIT_LOG_LIMIT = 100;

/**
 * `git log --format=%H%x00%s%x00%an%x00%aI -n <COMMIT_LOG_LIMIT> <ref>`, split
 * on NUL per record.
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
    String(COMMIT_LOG_LIMIT),
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
 * `git rev-parse <rev>`. Used by `listBranches` for the synthetic detached-HEAD
 * entry's tip, and by `watch.ts` to report where HEAD moved to.
 *
 * Not on the request path any more: a preview's SHAs arrive already full and
 * schema-checked, and `orderCommits` is what proves they name real commits.
 */
export async function resolveSha(repoRoot: string, rev: string): Promise<string> {
  const stdout = await run(repoRoot, ['rev-parse', rev]);
  return stdout.trim();
}

/** One commit of a span: its first parent, and the `.kt` files it touched. */
export interface CommitChanges {
  /**
   * First parent's SHA, or the empty-tree SHA for a root commit. First parent
   * and not all of them: on a merge that is the "what did this bring onto the
   * branch" side, which is the question a reviewer is asking.
   */
  parentSha: string;
  files: ChangedFile[];
}

/**
 * Sorts `shas` newest-first, and proves every one of them exists.
 *
 * `git log --no-walk` reads its arguments as a *set* of commits to show rather
 * than as tips to walk from, so this is a sort, not a history traversal — and
 * `--no-walk=sorted` (the default) is what makes it reverse-chronological
 * regardless of the order they arrive in. `log` rather than `rev-list` on
 * purpose: the two are the same plumbing, and `log` is already in this
 * backend's permitted subcommand set (see CLAUDE.md).
 *
 * Existence checking is the second job and is not incidental: git fails the
 * whole invocation with `fatal: bad object` on the first unknown SHA, which is
 * how a selection naming a commit this repository does not have — a stale tab
 * after a force-push, most often — becomes one clean rejection rather than a
 * preview quietly computed from whichever commits happened to survive.
 */
export async function orderCommits(repoRoot: string, shas: string[]): Promise<string[]> {
  const stdout = await run(repoRoot, ['log', '--no-walk', '--format=%H', '--end-of-options', ...shas, '--']);
  return stdout.split('\n').filter(Boolean);
}

/**
 * Every commit the selection `orderedShas` spans — the selected commits
 * themselves plus everything between them — with each one's first parent and
 * changed `.kt` files, keyed by full SHA and iterating newest-first.
 *
 * `orderedShas` must be newest-first; `orderCommits` is what establishes that.
 * The commits in between are as load-bearing as the selected ones: they are the
 * only way to discover that an *unselected* commit also touched a file, which
 * is what `PreviewFile.skippedShas` reports.
 *
 * ONE `git log` invocation, deliberately, where the obvious implementation is a
 * `rev-parse` plus a `diff-tree` per commit. A span can be as long as the 100
 * commits the picker lists, and that would be 200 git processes to answer a
 * single question — the parse cost is nothing next to the spawn cost. `%P` is
 * what removes the `rev-parse` calls: the parents are already in the record.
 *
 * Every selected commit is passed as its own walk tip rather than just the
 * newest one, so a selection is never quietly missing a commit the caller
 * named: a commit is always reachable from itself. `^<oldest>` then bounds the
 * walk from below. The bound is a *date*-ordered oldest, so a commit with a
 * misleading date widens the walk rather than truncating it — slower, never
 * wrong. A root `oldest` has no `^`, git rejects the revision outright, and the
 * fallback drops the bound: for a selection reaching back to the root, the
 * whole history IS the span.
 *
 * Three flags carry weight:
 *
 *   1. `--diff-merges=first-parent` (git >= 2.31). Without it `git log
 *      --name-status` prints NO file list at all for a merge commit — a
 *      selected merge would silently contribute nothing, and an unselected one
 *      would never be spotted as a source of leaked edits. Defaulting to
 *      "invisible" is the wrong failure for a review tool.
 *   2. `--no-renames`: this codebase's FileStatus is 'A' | 'M' | 'D' only, and a
 *      rename is read as the add/delete pair it decomposes into rather than as
 *      an R-status the contract cannot express.
 *   3. `--end-of-options` and the trailing `--`, for the reasons spelled out on
 *      `listCommits` — these revs arrive from a request too. Note `^<sha>` still
 *      excludes correctly after `--end-of-options`: it is revision syntax, not
 *      an option, which `--not` is not (that form is rejected there).
 */
export async function commitSpan(
  repoRoot: string,
  orderedShas: string[],
): Promise<Map<string, CommitChanges>> {
  const oldest = orderedShas[orderedShas.length - 1];
  if (oldest === undefined) return new Map();

  const walk = [
    'log',
    '--format=%x00%H %P',
    '--name-status',
    '--no-renames',
    '--diff-merges=first-parent',
    '--end-of-options',
    ...orderedShas,
  ];
  const stdout = await run(repoRoot, [...walk, `^${oldest}^`, '--']).catch(() => run(repoRoot, [...walk, '--']));

  const span = new Map<string, CommitChanges>();
  // NUL starts each commit record (see the %x00 in the format), so splitting on
  // it yields one chunk per commit whose first line is "<sha> <parents...>" and
  // whose remaining lines are the name-status rows. The leading chunk before
  // the first NUL is empty.
  for (const record of stdout.split('\x00')) {
    const [header, ...statusLines] = record.split('\n');
    if (!header) continue;
    const [sha, ...parents] = header.trim().split(' ');
    if (!sha) continue;

    const files: ChangedFile[] = [];
    for (const line of statusLines) {
      const file = parseNameStatus(line);
      if (file) files.push(file);
    }
    // A root commit's %P is empty, so there is no parent to diff against and
    // the empty tree is the base — the same substitution resolveBaseSha makes.
    span.set(sha, { parentSha: parents[0] ?? EMPTY_TREE_SHA, files });
  }
  return span;
}

/**
 * One `<status>\t<path>` row, or null when it is not a source file this
 * contract can describe.
 *
 * Rename/copy statuses (R100, C100, ...) are dropped rather than mapped: the
 * wire contract's FileStatus is 'A' | 'M' | 'D' only, and `--no-renames` on the
 * caller's side already asks git to decompose a rename into the add/delete pair
 * that contract can express. A row that still arrives as anything else is a
 * status this app has no UI for, and inventing one would be worse than omitting
 * it.
 */
function parseNameStatus(line: string): ChangedFile | null {
  if (!line) return null;
  const [statusField, ...pathParts] = line.split('\t');
  const status = statusField?.[0];
  if (status !== 'A' && status !== 'M' && status !== 'D') return null;
  const path = pathParts[pathParts.length - 1];
  if (!path || !isSourcePath(path)) return null;
  return { path, status };
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
