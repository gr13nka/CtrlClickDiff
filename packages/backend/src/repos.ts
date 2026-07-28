// Repo registry — the set of git repositories this backend is willing to serve,
// and the sandbox that bounds which ones a browser may add.
//
// Before this module the backend served exactly one repo, read from REPO_ROOT at
// boot and memoized. Now any repository *under the browse root* can be registered
// at runtime and addressed by id, so one backend process can serve several repos
// without a restart and without a mutable "current repo".
//
// SECURITY: `register()` takes a path straight from an HTTP body, so it is the
// only place a browser can influence which directory git runs in. Everything it
// does is in service of one invariant: the registered path is a git repository
// whose real, symlink-resolved toplevel lies inside the real, symlink-resolved
// browse root. See the step-by-step comment in `register()` — the *order* of
// those steps is the security property, not just their presence.

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, sep } from 'node:path';
import { revParseToplevel } from './git';

/** A repository this backend will serve, addressed over HTTP by `id`. */
export interface RepoEntry {
  /** Deterministic, URL- and Monaco-safe handle — see `repoId()`. */
  id: string;
  /** Absolute, symlink-resolved path to the repository's toplevel. */
  path: string;
  /** `basename(path)` — a display label only; never used to identify the repo. */
  name: string;
}

/**
 * A path the caller supplied cannot be registered: it does not exist, is not a
 * directory, is not a git repository, or resolves outside the browse root.
 * Every one of those is the client's mistake, so `server.ts` maps this (and only
 * this) to HTTP 400 — anything else escaping the registry is a real fault and
 * should surface as a 500.
 */
export class InvalidRepoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepoPathError';
  }
}

/**
 * The one containment predicate in the backend. Both arguments MUST already be
 * symlink-resolved (`fs.realpath`) by the caller: comparing a resolved candidate
 * against an unresolved root — or vice versa — is exactly the hole a symlink
 * escape walks through, and no amount of string work here can close it.
 *
 * The `root + sep` prefix (rather than a bare `startsWith(root)`) is what stops
 * `/home/user-evil` from counting as inside `/home/user`.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Ids are embedded in URLs and in Monaco model URIs — see `repoId()`. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Keeps ids readable without letting a deep directory name dominate them. */
const MAX_SLUG_LENGTH = 24;

/** Lowercase, non-alphanumerics collapsed to `-`, trimmed, capped, never empty. */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return s || 'repo';
}

/**
 * `slug(basename(path))-<sha256(path)[0..8]>`, e.g. `ccd-sample-repo-1f2a3b4c`.
 *
 * DETERMINISTIC BY DESIGN. The id is a pure function of the resolved path, with
 * no counter, timestamp, or random component, which is what makes
 * `POST /api/repos` idempotent: the frontend can re-register its repos on every
 * page load, and can re-register after the backend restarts and loses the
 * registry, and every id it already holds — in its own state, in a URL, in a
 * Monaco model URI — keeps pointing at the same repository. The slug half is
 * for humans reading a URL; the hash half is what actually distinguishes two
 * repos that share a basename (`~/a/api` vs `~/b/api`).
 *
 * MUST BE LOWERCASE, and that is not cosmetic. The id is placed in the
 * *authority* segment of a Monaco model URI, and Monaco lowercases the authority
 * in `Uri.toString()` (vs/base/common/uri.js:546) — which is what its model
 * registry keys on. An id with an uppercase character would therefore be stored
 * under one string and looked up under another, and the model would silently
 * fail to round-trip. The assertion below is the guard: it fails loudly here
 * rather than as an unexplainable missing model in the editor.
 */
function repoId(resolvedPath: string): string {
  const hash = createHash('sha256').update(resolvedPath).digest('hex').slice(0, 8);
  const id = `${slug(basename(resolvedPath))}-${hash}`;
  if (!ID_PATTERN.test(id)) {
    throw new Error(`repoId produced an id outside ${ID_PATTERN} for ${resolvedPath}: ${id}`);
  }
  return id;
}

/**
 * `CCD_BROWSE_ROOT ?? os.homedir()`, symlink-resolved once at boot.
 *
 * `$HOME` rather than something narrower because real checkouts sit at varying
 * depths beneath it (`~/lets-plot` and `~/Documents/AvitoStats` on this
 * machine), and a root that excludes half of them would just be worked around.
 */
export function resolveBrowseRoot(): Promise<string> {
  return realpath(process.env.CCD_BROWSE_ROOT ?? homedir());
}

export class RepoRegistry {
  private readonly byId = new Map<string, RepoEntry>();
  private readonly byPath = new Map<string, RepoEntry>();
  private defaultId: string | null = null;

  /** `browseRoot` must already be symlink-resolved — see `resolveBrowseRoot()`. */
  constructor(readonly browseRoot: string) {}

  /**
   * Register a **browser-supplied** path, or return the entry it already maps to.
   *
   * The validation order below is load-bearing:
   *
   *   1. `realpath` — resolves symlinks and rejects nonexistent paths, so every
   *      later step reasons about a real location rather than a name.
   *   2. must be a directory.
   *   3. `git rev-parse --show-toplevel` with cwd = the resolved path, and
   *      **canonicalize to that toplevel**. Pointing at `repo/src/main` registers
   *      `repo`, so the same repository can never enter the registry twice under
   *      different ids. (Bare repos fail this step naturally, which is fine —
   *      there is nothing to diff in one.)
   *   4. containment, checked on the *canonicalized toplevel*, not on the input.
   *
   * Step 4 must come after step 3. Checking containment on the input would let a
   * caller name an allowed subdirectory of a repository whose toplevel lives
   * *outside* the browse root, and walk out of the sandbox one `..`-free path at
   * a time. Both sides of the comparison are realpathed (see `isWithinRoot`),
   * which is what defeats a symlink pointing out of the root.
   */
  async register(inputPath: string): Promise<RepoEntry> {
    const resolved = await this.realpathOrReject(inputPath);
    await this.assertDirectory(resolved);
    const toplevel = await this.gitToplevelOf(resolved);

    if (!isWithinRoot(this.browseRoot, toplevel)) {
      throw new InvalidRepoPathError(
        `repository is outside the browse root: ${toplevel} is not under ${this.browseRoot}`,
      );
    }

    return this.upsert(toplevel);
  }

  /**
   * Register the **operator-supplied** boot repo (REPO_ROOT) and make it the
   * default, i.e. the repo every data route falls back to when a request names
   * none.
   *
   * Deliberately skips the containment check that `register()` enforces. The
   * browse root exists to bound what a *browser* can reach; REPO_ROOT is typed
   * by whoever starts the process, who already has a shell on this machine and
   * needs no help reading their own filesystem. Honoring a REPO_ROOT outside the
   * browse root is therefore correct, not a hole — the trust boundary is the
   * HTTP surface, not the path string.
   *
   * Throws on an invalid REPO_ROOT so the caller can fail fast at boot: a
   * REPO_ROOT that is set but wrong is a typo, and starting anyway would only
   * defer the confusion to the first request.
   */
  async registerBootRepo(inputPath: string): Promise<RepoEntry> {
    const resolved = await this.realpathOrReject(inputPath);
    await this.assertDirectory(resolved);
    const entry = this.upsert(await this.gitToplevelOf(resolved));
    this.defaultId = entry.id;
    return entry;
  }

  /** Root path for `id`, or undefined if nothing is registered under it. */
  resolveRoot(id: string): string | undefined {
    return this.byId.get(id)?.path;
  }

  /** Id of the REPO_ROOT repo, or null when the process was started without one. */
  get defaultRepoId(): string | null {
    return this.defaultId;
  }

  /** Root path of the REPO_ROOT repo, or undefined when there is none. */
  defaultRoot(): string | undefined {
    return this.defaultId === null ? undefined : this.resolveRoot(this.defaultId);
  }

  list(): RepoEntry[] {
    return [...this.byId.values()];
  }

  /** Idempotent insert: the same resolved path always yields the same entry. */
  private upsert(toplevel: string): RepoEntry {
    const existing = this.byPath.get(toplevel);
    if (existing) return existing;

    const entry: RepoEntry = { id: repoId(toplevel), path: toplevel, name: basename(toplevel) };
    this.byId.set(entry.id, entry);
    this.byPath.set(entry.path, entry);
    return entry;
  }

  private async realpathOrReject(inputPath: string): Promise<string> {
    try {
      return await realpath(inputPath);
    } catch {
      throw new InvalidRepoPathError(`path does not exist: ${inputPath}`);
    }
  }

  private async assertDirectory(resolved: string): Promise<void> {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new InvalidRepoPathError(`path is not a directory: ${resolved}`);
    }
  }

  private async gitToplevelOf(resolved: string): Promise<string> {
    let toplevel: string;
    try {
      toplevel = await revParseToplevel(resolved);
    } catch {
      throw new InvalidRepoPathError(`not a git repository: ${resolved}`);
    }
    // git prints a physical path here, but realpath it anyway so the value fed
    // to `isWithinRoot` is resolved by the same mechanism as the browse root.
    return this.realpathOrReject(toplevel);
  }
}
