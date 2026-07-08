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
