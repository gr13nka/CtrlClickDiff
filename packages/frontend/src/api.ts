// Typed fetch client for the Fastify backend's /api routes (Milestone 2 contract).
// All routes are proxied by Vite dev server: '/api' -> http://127.0.0.1:5178
// (see vite.config.ts). No caching here — callers decide what to memoize.
//
// Every data route is scoped to a repository by id: the backend serves any repo
// registered through POST /api/repos, and a request that names none falls back
// to the operator's boot REPO_ROOT. Rather than let call sites forget the
// `repo=` parameter, all repo-scoped requests funnel through repoFetch() below,
// which appends it — and which owns the restart recovery described there.

import type { BranchInfo, CommitInfo, DefLocation, Preview } from '@ctrlclickdiff/shared';

// Mirrors of backend repos.ts's RepoEntry and browse.ts's BrowseListing /
// BrowseEntry. Declared here rather than imported from @ctrlclickdiff/shared
// because they are not in that package — this is their only client, and
// promoting them is a change to a package this commit deliberately leaves
// alone.

/** A repository the backend will serve, addressed over HTTP by `id`. */
export interface RepoEntry {
  id: string;
  /** Absolute, symlink-resolved toplevel — the only thing that can re-register it. */
  path: string;
  /** basename(path); a display label only, never used to identify the repo. */
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

export interface BrowseEntry {
  name: string;
  path: string;
  /** Display hint only — POST /api/repos is the authority on what registers. */
  isRepo: boolean;
}

export interface BrowseListing {
  path: string;
  /** null when `path` is the browse root, i.e. there is no "up" from here. */
  parent: string | null;
  root: string;
  entries: BrowseEntry[];
}

// Path for every repo id this client has seen, learned from the two responses
// that hand out ids (GET /api/repos and POST /api/repos). It exists for
// repoFetch()'s 409 recovery, which needs a *path* while holding only an *id*
// — and cannot ask its caller for one, because the call sites that matter most
// (defprovider.ts) recover the id from a Monaco model URI, whose authority
// segment has room for an opaque id and none for a filesystem path.
const pathById = new Map<string, string>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function withRepo(url: string, repoId: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}repo=${encodeURIComponent(repoId)}`;
}

/**
 * One request against a repo-scoped route, with the backend's restart recovery.
 *
 * The registry lives in the backend's memory, so restarting it (a `tsx watch`
 * reload, a crash) silently empties it while this tab still holds ids that were
 * valid a second ago. The backend answers an unknown id **409, not 404**, and
 * that distinction is the whole protocol: 404 would mean "no such repository,
 * give up", while 409 means "your view of server state conflicts with mine" —
 * which is exactly true, and is actionable. Because POST /api/repos is
 * idempotent and its ids are a pure function of the resolved path, re-posting
 * the path rebuilds the *same* id and the retried request finds it, with no
 * reload and nothing above this function aware that a restart happened.
 *
 * Retried exactly once, deliberately: a second 409 after a successful
 * re-registration is no longer a lost registry, it is a bug, and looping on it
 * would turn that bug into a request storm.
 */
async function repoFetch(repoId: string, url: string, init?: RequestInit): Promise<Response> {
  const target = withRepo(url, repoId);
  const res = await fetch(target, init);
  if (res.status !== 409) return res;

  const path = pathById.get(repoId);
  // An id we never learned a path for: hand the 409 back rather than pretend it
  // was handled, so the caller reports a real failure instead of a silent one.
  if (path === undefined) return res;

  await api.registerRepo(path);
  return fetch(target, init);
}

async function getRepoJson<T>(repoId: string, url: string): Promise<T> {
  const res = await repoFetch(repoId, url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  /** GET /api/repos -> registered repos, the boot default, and the browse root. */
  async repos(): Promise<ReposListing> {
    const listing = await getJson<ReposListing>('/api/repos');
    for (const entry of listing.repos) pathById.set(entry.id, entry.path);
    return listing;
  },

  /**
   * POST /api/repos -> the entry for `path`, registering it if it is new.
   *
   * Idempotent on the backend (the id is derived from the resolved path), so
   * callers may re-register freely: on every boot, and as repoFetch()'s
   * recovery after a backend restart. Rejects with the backend's own message
   * when the path is not a git repository inside the browse root — that text
   * is written for a human and is what the picker shows.
   */
  async registerRepo(path: string): Promise<RepoEntry> {
    const res = await fetch('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path })
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `POST /api/repos failed: ${res.status} ${res.statusText}`);
    }
    const entry = (await res.json()) as RepoEntry;
    pathById.set(entry.id, entry.path);
    return entry;
  },

  /**
   * GET /api/browse?path=<abs> -> the subdirectories of `path`, defaulting to
   * the browse root. Directories only, dotfiles skipped (see backend
   * browse.ts). Not repo-scoped, and cannot be: browsing is how a repo is
   * *found*, before there is an id to scope anything to.
   */
  browse(path?: string): Promise<BrowseListing> {
    const url = path === undefined ? '/api/browse' : '/api/browse?path=' + encodeURIComponent(path);
    return getJson<BrowseListing>(url);
  },

  /** GET /api/branches -> every local and remote-tracking branch, HEAD flagged. */
  branches(repoId: string): Promise<BranchInfo[]> {
    return getRepoJson<BranchInfo[]>(repoId, '/api/branches');
  },

  /**
   * GET /api/commits -> newest-first commit log of `ref` (up to 100).
   *
   * `ref` must be a **full** refname as `branches()` reported it
   * (`refs/heads/main`), which is also the only shape the backend's route
   * schema accepts — a short name is a 400, not a lookup. Omitting it asks for
   * HEAD's log, which is what the shell does before it has a branch to name.
   */
  commits(repoId: string, ref?: string): Promise<CommitInfo[]> {
    const url = ref === undefined ? '/api/commits' : '/api/commits?ref=' + encodeURIComponent(ref);
    return getRepoJson<CommitInfo[]>(repoId, url);
  },

  /**
   * GET /api/preview?shas=<csv> -> the changed .kt files of a *selection* of
   * commits, each with the revision pair its diff is computed at.
   *
   * One sha is the ordinary single-commit review; several is a ghost squash.
   * There is no separate per-commit route, because a selection of one already
   * answers that question exactly.
   *
   * `shas` must be full 40-char SHAs as `commits()` reported them — the
   * backend's route schema accepts nothing else, so an abbreviation is a 400
   * rather than a lookup. The backend re-sorts them newest-first, so the order
   * sent here does not matter.
   */
  preview(repoId: string, shas: string[]): Promise<Preview> {
    return getRepoJson<Preview>(repoId, '/api/preview?shas=' + encodeURIComponent(shas.join(',')));
  },

  /**
   * GET /api/file?rev=<sha>&path=<p> -> raw file text at that revision.
   * Backend returns '' (not an error) when the path doesn't exist at rev —
   * that's the expected shape for an added file's base side, a deleted
   * file's head side, or a root commit's base side. Don't add error
   * handling here; an empty string is a valid, meaningful response.
   */
  file(repoId: string, rev: string, path: string): Promise<string> {
    const url = '/api/file?rev=' + encodeURIComponent(rev) + '&path=' + encodeURIComponent(path);
    return repoFetch(repoId, url).then((r) => r.text());
  },

  /**
   * GET /api/def?name=<name>&file=<path>&line=<lineNumber>&lang=kotlin&rev=<rev>
   * -> ranked DefLocation[] (same-file hits first per the resolver; []
   * means "not found", never an error). Called from defprovider.ts's
   * provideDefinition, which Monaco invokes TWICE per Ctrl+click (once for
   * hover-link underlining, once for resolution) — see that file's
   * memoizedFile() for how the double-call is kept cheap. lang is fixed to
   * 'kotlin' here since that's the only language this MVP resolves.
   *
   * `repoId` is as load-bearing as `rev`: the resolver indexes a revision *of a
   * repository*, and a bare SHA does not say which one.
   */
  def(params: {
    repoId: string;
    name: string;
    file: string;
    line: number;
    rev: string;
  }): Promise<DefLocation[]> {
    const qs =
      'name=' +
      encodeURIComponent(params.name) +
      '&file=' +
      encodeURIComponent(params.file) +
      '&line=' +
      encodeURIComponent(String(params.line)) +
      '&lang=kotlin' +
      '&rev=' +
      encodeURIComponent(params.rev);
    return getRepoJson<DefLocation[]>(params.repoId, '/api/def?' + qs);
  }
};
