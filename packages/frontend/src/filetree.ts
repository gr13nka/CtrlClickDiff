// filetree.ts — turns a commit's flat ChangedFile[] into a renderable
// directory tree for the sidebar. Pure and DOM-free: the caller owns the
// rendering, this owns the shape.
//
// The non-obvious part is the collapsing of single-child directory chains,
// and it exists because of Kotlin package layout. A path like
// src/main/kotlin/org/example/model/Account.kt is six directory levels deep,
// so a naive tree would spend six rows of indentation to show one file —
// strictly worse than the flat list of full paths it replaces. GitHub's file
// browser solves this by merging any directory whose sole child is another
// directory into that child, so the same path renders as ONE row labelled
// `src/main/kotlin/org/example/model/`. Merging runs to a fixpoint, so a
// chain of five collapses into one node rather than four nested ones.
//
// A directory holding exactly one *file* is deliberately not collapsed: that
// file is a leaf the user clicks, and folding it into its parent's label
// would hide the row rather than shorten it.

import type { ChangedFile, FileStatus } from '@ctrlclickdiff/shared';

export type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string; status: FileStatus };

/**
 * Groups `files` into a directory tree, collapsing single-child directory
 * chains (see file header). Directories sort before files, then
 * case-insensitively by name; the result depends only on the set of input
 * paths, never on their order.
 *
 * A file node's `path` is its input path verbatim — the caller keys row
 * lookups and active-row highlighting by full path, so it must round-trip
 * even when the path needed normalizing. A directory node's `path` is its
 * normalized prefix, suitable as a stable expand/collapse key.
 */
export function buildFileTree(files: ChangedFile[]): TreeNode[] {
  const root = emptyDir();

  for (const file of files) {
    // Drop '' (a doubled or trailing slash) and '.' (a leading './') so they
    // never become a nameless or dot-named tree row.
    const segments = file.path.split('/').filter((s) => s !== '' && s !== '.');
    const name = segments.pop();
    // Nothing addressable left ('', '/', './') — there is no row to render,
    // and inventing one would produce a node the caller can never match.
    if (name === undefined) continue;

    let dir = root;
    for (const segment of segments) {
      let child = dir.dirs.get(segment);
      if (!child) {
        child = emptyDir();
        dir.dirs.set(segment, child);
      }
      dir = child;
    }
    // Keyed by name, so a duplicated path collapses to one node (the last
    // occurrence's status wins). `dirs` and `files` are separate maps, so a
    // file and a directory sharing a name at one level both survive.
    dir.files.set(name, file);
  }

  return toNodes(root, '');
}

/** A directory under construction: children not yet collapsed or sorted. */
interface TrieDir {
  dirs: Map<string, TrieDir>;
  files: Map<string, ChangedFile>;
}

function emptyDir(): TrieDir {
  return { dirs: new Map(), files: new Map() };
}

/**
 * The single sub-directory `dir` can be merged into, or null if merging
 * would lose something — `dir` holds files of its own, or holds zero or
 * several sub-directories.
 */
function onlyChildDir(dir: TrieDir): [string, TrieDir] | null {
  if (dir.files.size > 0 || dir.dirs.size !== 1) return null;
  for (const entry of dir.dirs) return entry;
  return null; // unreachable (size checked above); narrows for TS
}

function toNodes(dir: TrieDir, prefix: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [name, child] of dir.dirs) {
    nodes.push(toDirNode(name, child, prefix));
  }
  for (const [name, file] of dir.files) {
    nodes.push({ kind: 'file', name, path: file.path, status: file.status });
  }
  return nodes.sort(compareNodes);
}

function toDirNode(name: string, dir: TrieDir, prefix: string): TreeNode {
  let label = name;
  let node = dir;
  for (let only = onlyChildDir(node); only; only = onlyChildDir(node)) {
    label += `/${only[0]}`;
    node = only[1];
  }
  const path = prefix ? `${prefix}/${label}` : label;
  return { kind: 'dir', name: label, path, children: toNodes(node, path) };
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const aKey = a.name.toLowerCase();
  const bKey = b.name.toLowerCase();
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  // Case-insensitive tie (`Model/` beside `model/`): fall back to a codepoint
  // compare rather than leaving the order up to insertion. Deliberately not
  // localeCompare — its collation varies by environment.
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}
