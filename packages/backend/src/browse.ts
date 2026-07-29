// Directory browsing for the repo picker — the sandboxed "find my checkout"
// half of repo selection, whose other half is `POST /api/repos` (repos.ts).
//
// This is the backend's only directory-listing capability, and it is
// deliberately the narrowest one that can support a picker:
//
//   - it never leaves the browse root (same `isWithinRoot` predicate repos.ts
//     uses, on realpathed operands);
//   - it returns DIRECTORY NAMES ONLY — never file names, and never any
//     content, size, or timestamp for anything.
//
// The second rule is the one to preserve. A picker needs to know which folders
// exist; it has no use for the names of a user's files, and reporting them
// would turn a convenience endpoint into a home-directory enumerator.

import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowseEntry, BrowseListing } from '@ctrlclickdiff/shared';
import { isWithinRoot } from './repos';

/**
 * The requested path is unusable: it does not exist, is not a directory, or
 * resolves outside the browse root. `server.ts` maps this to HTTP 400.
 */
export class BrowsePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowsePathError';
  }
}

/**
 * Enough for any real directory while bounding a pathological one (node_modules,
 * a maildir) so a single request can't build a multi-megabyte response.
 */
const MAX_ENTRIES = 2000;

/**
 * List the subdirectories of `requestedPath`, defaulting to the browse root.
 *
 * `requestedPath` comes from a query string, so it is resolved with `realpath`
 * and then checked against the realpathed root — resolving both sides is what
 * makes a symlink out of the root fail rather than succeed.
 */
export async function browseDirectory(
  browseRoot: string,
  requestedPath?: string,
): Promise<BrowseListing> {
  const target = requestedPath?.trim() ? requestedPath : browseRoot;

  let dir: string;
  try {
    dir = await realpath(target);
  } catch {
    throw new BrowsePathError(`path does not exist: ${target}`);
  }

  if (!isWithinRoot(browseRoot, dir)) {
    throw new BrowsePathError(`path is outside the browse root: ${dir} is not under ${browseRoot}`);
  }

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new BrowsePathError(`not a readable directory: ${dir}`);
  }

  const names = dirents
    // `Dirent.isDirectory()` is lstat-like, so a symlink POINTING AT a directory
    // reports false and is dropped. That is deliberate, not an oversight: a
    // symlink is the one entry whose real location need not be inside the browse
    // root, and excluding it here means the listing can never dangle a way out
    // of the sandbox in front of the user. (No repository on this machine sits
    // behind a symlink under $HOME, so nothing real is lost. Should that change,
    // the fix is to follow the link AND re-check containment on the resolved
    // target — never to relax this filter alone.)
    .filter((d) => d.isDirectory())
    // Dotfiles are noise in a repo picker; `.git` itself would be the loudest.
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => d.name)
    // Sorted before the cap so a truncated listing is a stable alphabetical
    // prefix rather than an arbitrary slice of filesystem order.
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .slice(0, MAX_ENTRIES);

  const entries: BrowseEntry[] = names.map((name) => ({
    name,
    path: join(dir, name),
    // A cheap `.git` probe, NOT `git rev-parse`, because this runs once per
    // entry: a 500-directory listing would otherwise fork 500 git processes to
    // decorate a list the user is only skimming. It is a display hint and may be
    // wrong at the edges (worktree files, bare repos); `POST /api/repos` runs
    // the real check and remains the only authority on what can be registered.
    isRepo: existsSync(join(dir, name, '.git')),
  }));

  return {
    path: dir,
    parent: dir === browseRoot ? null : dirname(dir),
    root: browseRoot,
    entries,
  };
}
