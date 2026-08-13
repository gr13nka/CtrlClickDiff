// preview.ts — what a selection of commits looks like when read as one diff.
//
// This is the "ghost squash" itself. Nothing here writes: the answer is always
// a pair of revisions that already exist in the object database, which is what
// lets the rest of the app stay ignorant of the feature. `/api/file`, the
// tree-sitter index and Ctrl+click peek all take a rev and a path, and a
// preview hands them revs they already understand.
//
// It lives outside git.ts because it is not a git primitive. git.ts answers
// "what does this repository contain"; this file answers "what did these
// commits, and only these commits, do" — a question git has no command for.

import type { ChangedFile, FileStatus, Preview, PreviewFile } from '@ctrlclickdiff/shared';
import { commitSpan, orderCommits, type CommitChanges } from './git';

/**
 * Resolves `shas` into the changed files of that selection, each carrying the
 * revision pair its diff should be computed at.
 *
 * THE RULE, for one path:
 *
 *   base = first parent of the EARLIEST selected commit that touched it
 *   head =                   the LATEST selected commit that touched it
 *
 * Per file, not per selection, and that is the whole reason a reviewer may
 * leave commits out of the middle of a range. Everything the selection did to a
 * path happened between those two points; nothing outside them is the
 * selection's doing. A single span shared by every file would drag in every
 * unselected commit's edits to files the selection merely happens to bracket —
 * a docs-only commit would still be visible in the code files it never touched.
 *
 * A path no selected commit touched never appears at all. That is the feature:
 * deselect the docs commit and its files leave the review.
 *
 * WHERE THIS IS INEXACT, and it cannot be otherwise: a path touched by both a
 * selected and an unselected commit. `A -> (unselected edit) -> A'` has no
 * two-SHA representation, because no revision in the repository holds that file
 * with the selected edits and without the unselected ones. Building one would
 * mean `git merge-tree --write-tree`, which writes objects into `.git/objects`
 * and would end this backend's read-only guarantee. So the unselected edits
 * stay in that file's diff and the commits responsible are named in
 * `skippedShas`, for the UI to mark. Reporting the leak beats hiding the file:
 * a changed file dropped from a review is a file nobody reviewed.
 *
 * Rejects (git does) when any sha is unknown to this repository.
 */
export async function buildPreview(repoRoot: string, shas: string[]): Promise<Preview> {
  // Newest-first, and every sha proven to exist, before anything else looks at
  // them — the order is what "earliest" and "latest" above are measured in, and
  // the caller's array order is not to be trusted for it.
  const ordered = await orderCommits(repoRoot, shas);
  const selected = ordered.map((commit) => commit.sha);
  const span = await commitSpan(repoRoot, selected);

  // Position in the walk, newest = 0. The span is a superset of the selection,
  // so this is the one ruler both selected and unselected commits are measured
  // against — which is what makes "did an unselected commit land between this
  // file's base and head" a comparison of two integers.
  const positionOf = new Map<string, number>();
  for (const sha of span.keys()) positionOf.set(sha, positionOf.size);

  const selectedSet = new Set(selected);
  const touches = new Map<string, PathTouches>();

  // Newest-first, so the first sighting of a path is its latest toucher and the
  // last sighting is its earliest. Both are recorded in one pass.
  for (const sha of selected) {
    const changes = span.get(sha);
    // A selected commit the walk did not reach cannot happen for a selection
    // made from one ref's log — every commit there is a walk tip. Skipping is
    // still the right answer over throwing: one unreachable commit must not
    // cost the reviewer the other nine.
    if (!changes) continue;
    for (const file of changes.files) {
      record(touches, file, sha, changes.parentSha);
    }
  }

  attributeSkipped(touches, span, selectedSet, positionOf);

  const spanHeadSha = selected[0] ?? '';
  const oldest = selected[selected.length - 1];
  const spanBaseSha = (oldest !== undefined ? span.get(oldest)?.parentSha : undefined) ?? '';

  return {
    shas: selected,
    commits: ordered,
    spanHeadSha,
    spanBaseSha,
    files: [...touches.values()].map(toPreviewFile).filter(isPresent).sort(byPath),
  };
}

/** What the selected commits did to one path, accumulated newest-first. */
interface PathTouches {
  path: string;
  /** The latest selected commit touching `path`, and how it left it. */
  headSha: string;
  headStatus: FileStatus;
  /** The earliest selected commit touching `path` so far, and its first parent. */
  earliestSha: string;
  baseSha: string;
  earliestStatus: FileStatus;
  skippedShas: string[];
}

function record(
  touches: Map<string, PathTouches>,
  file: ChangedFile,
  sha: string,
  parentSha: string,
): void {
  const seen = touches.get(file.path);
  if (!seen) {
    touches.set(file.path, {
      path: file.path,
      headSha: sha,
      headStatus: file.status,
      earliestSha: sha,
      baseSha: parentSha,
      earliestStatus: file.status,
      skippedShas: [],
    });
    return;
  }
  // Walking newest-first, so every later sighting is an earlier commit: the
  // base keeps moving back and the head, set on the first sighting, never moves.
  seen.earliestSha = sha;
  seen.baseSha = parentSha;
  seen.earliestStatus = file.status;
}

/**
 * Fills in `skippedShas`: for each path, the unselected commits that touched it
 * strictly between its base and its head.
 *
 * Strictly between is the whole test. An unselected commit at or before a path's
 * base is already folded into the base side, and one after its head is not in
 * the diff at all — neither leaks anything. Only the ones in the middle put
 * changes on screen that the selection did not ask for.
 */
function attributeSkipped(
  touches: Map<string, PathTouches>,
  span: Map<string, CommitChanges>,
  selectedSet: Set<string>,
  positionOf: Map<string, number>,
): void {
  for (const [sha, changes] of span) {
    if (selectedSet.has(sha)) continue;
    const at = positionOf.get(sha);
    if (at === undefined) continue;

    for (const file of changes.files) {
      const seen = touches.get(file.path);
      if (!seen) continue; // a path the selection never touched is not in the review
      const headAt = positionOf.get(seen.headSha);
      const earliestAt = positionOf.get(seen.earliestSha);
      if (headAt === undefined || earliestAt === undefined) continue;
      // Newest-first positions, so "between head and earliest" is
      // headAt < at < earliestAt.
      if (at > headAt && at < earliestAt) seen.skippedShas.push(sha);
    }
  }
}

/**
 * The wire shape, with the net status derived from what actually exists at each
 * end rather than guessed from any single commit's letter.
 *
 * A file added by the earliest selected toucher did not exist at the base side;
 * one deleted by the latest did not survive to the head side. Those two facts
 * decide the status between them, which is why a path added and then deleted
 * inside the selection returns null: it is absent from both sides, its diff is
 * empty against empty, and listing it would send the reviewer to a blank pane.
 */
function toPreviewFile(touches: PathTouches): PreviewFile | null {
  const atBase = touches.earliestStatus !== 'A';
  const atHead = touches.headStatus !== 'D';
  if (!atBase && !atHead) return null;

  const status: FileStatus = !atBase ? 'A' : !atHead ? 'D' : 'M';
  return {
    path: touches.path,
    status,
    baseSha: touches.baseSha,
    headSha: touches.headSha,
    skippedShas: touches.skippedShas,
  };
}

function isPresent(file: PreviewFile | null): file is PreviewFile {
  return file !== null;
}

function byPath(a: PreviewFile, b: PreviewFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
