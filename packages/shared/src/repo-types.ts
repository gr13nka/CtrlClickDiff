// Repository-registry and directory-browsing shapes shared between the Fastify
// backend (packages/backend/src/repos.ts, browse.ts, server.ts) and the
// frontend's typed fetch client.
//
// Separate from git-types.ts because these are not git shapes: nothing here
// comes out of a git invocation. They describe what the backend has been told
// to serve and what it will let a picker look at — the registry and the browse
// root — which is a different contract that happens to cross the same wire.

/** A repository the backend will serve, addressed over HTTP by `id`. */
export interface RepoEntry {
  /** Deterministic, URL- and Monaco-safe handle — see repos.ts's `repoId()`. */
  id: string;
  /**
   * Absolute, symlink-resolved path to the repository's toplevel — and the only
   * thing that can re-register it. Ids are handed out by an in-memory registry
   * and do not survive a backend restart; the path is what re-creates them.
   */
  path: string;
  /** `basename(path)` — a display label only; never used to identify the repo. */
  name: string;
}

/** GET /api/repos — everything a repo picker needs to populate itself. */
export interface ReposListing {
  repos: RepoEntry[];
  /** The boot REPO_ROOT repo, or null when the backend was started without one. */
  defaultRepoId: string | null;
  /** Directory browsing is capped to this subtree. */
  browseRoot: string;
}

/** One subdirectory of the browsed directory. Names and paths only, by design. */
export interface BrowseEntry {
  name: string;
  path: string;
  /**
   * Whether this directory looks like a git checkout — a hint for rendering,
   * not a guarantee. See the `existsSync` note in `browseDirectory()`; POST
   * /api/repos is the authority on what actually registers.
   */
  isRepo: boolean;
}

export interface BrowseListing {
  /** The directory that was listed, symlink-resolved. */
  path: string;
  /**
   * Parent directory, or null when `path` is the browse root — there is no "up"
   * from there, and the picker's ascent is capped accordingly.
   */
  parent: string | null;
  /** The browse root, so the client can render how far up it may go. */
  root: string;
  entries: BrowseEntry[];
}
