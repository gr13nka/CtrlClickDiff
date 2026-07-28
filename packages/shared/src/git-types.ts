// Git-backed data shapes shared between the Fastify backend (packages/backend/src/git.ts,
// server.ts) and the frontend's typed fetch client. Milestone 2 contract — see
// peekdiff-mvp-iterative-wind.md, "Milestone 2 — Git backend (Fastify)".

/** Single-letter status as reported by `git diff-tree --name-status`. */
export type FileStatus = 'A' | 'M' | 'D';

export interface ChangedFile {
  path: string;
  status: FileStatus;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  /**
   * Author date, ISO-8601 with offset (git's `%aI`), e.g.
   * `2026-07-28T14:03:11+03:00`.
   *
   * The *author* date, not the committer date: it is the one a reviewer
   * recognizes as "when this change was written", and it survives the rebases
   * and cherry-picks that reset the committer date to now.
   */
  date: string;
}

/**
 * One entry of `GET /api/branches` — a ref the commit picker may be pointed at.
 *
 * `ref` is the **full** refname (`refs/heads/main`, `refs/remotes/origin/main`)
 * and is the only value that should ever travel back to the backend as `?ref=`.
 * The short form is ambiguous: a remote's display name `origin/main` is also a
 * legal *local* branch name, so two different refs can share one short name, and
 * only the full refname names exactly one of them. `name` exists purely to be
 * shown to a human and must not be used to identify a ref.
 */
export interface BranchInfo {
  /** Full refname, e.g. `refs/heads/main` — the wire value for `?ref=`. */
  ref: string;
  /** Display label: `main`, `origin/main`. Not an identifier. */
  name: string;
  kind: 'local' | 'remote';
  /** True for the one ref HEAD currently points at (none, when detached). */
  isHead: boolean;
  /** 40-char SHA the ref points at. */
  tipSha: string;
}

/**
 * Response shape for `GET /api/commit/:sha/files`. Bundles the resolved head/base
 * SHAs alongside the changed-file list so the frontend never has to compute the
 * base side itself (root commits fall back to the empty-tree hash — see
 * git.ts's resolveBaseSha) — model URIs are built directly from these.
 */
export interface CommitFiles {
  headSha: string;
  baseSha: string;
  files: ChangedFile[];
}
