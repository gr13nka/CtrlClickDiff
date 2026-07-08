// Typed fetch client for the Fastify backend's /api routes (Milestone 2 contract).
// All routes are proxied by Vite dev server: '/api' -> http://127.0.0.1:5178
// (see vite.config.ts). No caching here — callers decide what to memoize.

import type { CommitInfo, CommitFiles, DefLocation } from '@ctrlclickdiff/shared';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  /** GET /api/commits -> newest-first commit log (up to 100). */
  commits(): Promise<CommitInfo[]> {
    return getJson<CommitInfo[]>('/api/commits');
  },

  /** GET /api/commit/:sha/files -> resolved head/base SHAs + changed .kt files. */
  commitFiles(sha: string): Promise<CommitFiles> {
    return getJson<CommitFiles>(`/api/commit/${encodeURIComponent(sha)}/files`);
  },

  /**
   * GET /api/file?rev=<sha>&path=<p> -> raw file text at that revision.
   * Backend returns '' (not an error) when the path doesn't exist at rev —
   * that's the expected shape for an added file's base side, a deleted
   * file's head side, or a root commit's base side. Don't add error
   * handling here; an empty string is a valid, meaningful response.
   */
  file(rev: string, path: string): Promise<string> {
    return fetch('/api/file?rev=' + encodeURIComponent(rev) + '&path=' + encodeURIComponent(path)).then((r) =>
      r.text()
    );
  },

  /**
   * GET /api/def?name=<name>&file=<path>&line=<lineNumber>&lang=kotlin&rev=<rev>
   * -> ranked DefLocation[] (same-file hits first per the resolver; []
   * means "not found", never an error). Called from defprovider.ts's
   * provideDefinition, which Monaco invokes TWICE per Ctrl+click (once for
   * hover-link underlining, once for resolution) — see that file's
   * memoizedFile() for how the double-call is kept cheap. lang is fixed to
   * 'kotlin' here since that's the only language this MVP resolves.
   */
  def(params: { name: string; file: string; line: number; rev: string }): Promise<DefLocation[]> {
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
    return getJson<DefLocation[]>('/api/def?' + qs);
  },

  /**
   * Fire-and-forget POST /api/index?rev=<rev> — prewarms the resolver's
   * per-revision index (see TreeSitterResolver.buildIndex) ahead of the
   * first Ctrl+click, so that request doesn't pay the parse cost inline.
   * Called from shell.ts on commit-select. Errors are swallowed: a failed
   * prewarm just means /api/def builds the index lazily on first use
   * instead — not a broken feature, so there's nothing for a caller to
   * await or handle.
   */
  prewarm(rev: string): void {
    fetch('/api/index?rev=' + encodeURIComponent(rev), { method: 'POST' }).catch(() => {});
  }
};
