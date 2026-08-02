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
 * One changed path in a preview, carrying the exact revision pair its diff is
 * computed at.
 *
 * The pair is **per file**, not per selection, and that is what lets a reviewer
 * leave commits out of the middle of a range. For a path, the interesting span
 * is bounded by the selected commits that actually touched it: anything the
 * selection did to it happened between those two points, and nothing outside
 * them is the selection's doing. A single span shared by every file would drag
 * in every unselected commit's edits to files the selection merely happens to
 * bracket.
 *
 * Both SHAs name revisions that already exist in the object database, which is
 * the property the whole feature rests on: `git show <rev>:<path>` works, so
 * the file routes, the symbol index and Ctrl+click peek need to know nothing
 * about previews at all. Synthesizing a tree for a selection would need
 * `git merge-tree --write-tree`, which writes objects — see the read-only rule
 * in CLAUDE.md.
 */
export interface PreviewFile {
  path: string;
  status: FileStatus;
  /** First parent of the EARLIEST selected commit that touched `path`. */
  baseSha: string;
  /** The LATEST selected commit that touched `path`. */
  headSha: string;
  /**
   * Commits the reviewer did NOT select that also touched `path` between
   * `baseSha` and `headSha`, newest-first.
   *
   * Non-empty means this file's diff is not a pure squash of the selection —
   * those commits' edits to it are in there too. That is not a bug to fix but a
   * fact to report: `A -> (unselected edit) -> A'` has no two-SHA
   * representation, because no revision in the repository holds this file with
   * the selected edits and without the unselected ones. The UI marks such a row
   * rather than hiding it; a changed file silently dropped from a review is a
   * file nobody reviewed.
   */
  skippedShas: string[];
}

/**
 * Response shape for `GET /api/preview`: what a selection of commits looks like
 * when read as one diff.
 *
 * A selection of exactly one commit is the ordinary single-commit review, and
 * yields precisely what a per-commit route would — which is why there is no
 * longer a separate one.
 */
export interface Preview {
  /** The selection, newest-first, resolved to full 40-char SHAs. */
  shas: string[];
  /**
   * The revision pair for a path that is NOT in `files` — the newest selected
   * commit, and the first parent of the oldest selected commit.
   *
   * This exists for one caller and would otherwise be dead weight: a cross-file
   * jump can land on any source file at the revision, not only on one the
   * selection changed (the resolver indexes the whole tree), and such a path has
   * no `PreviewFile` to read revisions from. Do not use it for a path that does
   * appear in `files` — that file's own pair is narrower and is the honest one.
   */
  spanHeadSha: string;
  spanBaseSha: string;
  files: PreviewFile[];
}
