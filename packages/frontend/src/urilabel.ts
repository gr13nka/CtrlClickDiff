// urilabel.ts — how a model URI is spelled out to the reader.
//
// Model URIs are `file://<repoId>/<rev>/<path>` (diff.ts's modelUri), which is
// exactly right for a registry key and exactly wrong to show anybody: the
// authority is an opaque id and the first path segment is a 40-hex SHA. Monaco
// shows it anyway, because standalone's own label service answers `uri.fsPath`
// for any `file:` URI (standaloneServices.js:584-589), so the peek's title bar
// read
//
//   storage.ts  //ctrlclickdiff-66caac9c/c3ebf28e349f6e7f874d7027c9fd6a07c06afbfa/packages/frontend/src
//
// — 89 characters, of which 62 are identifiers the reader has no use for, in the
// widget's most prominent band and in the place its *directory* was meant to go.
// It was not merely ugly: the title bar ellipsizes, so at the default side-by-side
// width the noise pushed the filename itself off the edge and the title rendered
// as `storag…  //ctrlclickdiff-66caac9c/c3ebf28e…  - Definitio…`. A title that no
// longer says which file it is has given up its whole job — the same argument
// peekscope.ts makes about clipped row labels, happening one element up.
//
// So this replaces the service rather than patching the widget: one seam, and
// every consumer of it is fixed at once (the peek's title, its row descriptions,
// and the `title`/`aria-label` on each row).
//
// TWO THINGS HERE ARE LOAD-BEARING AND FAIL SILENTLY IF DISTURBED.
//
//  1. **`modelUriLabel` is what lands in a peek row's `aria-label`.** IconLabel
//     builds that attribute out of its `title` option (iconLabel.js:88-93,124),
//     and referencesTree.js:113 fills `title` with `getUriLabel(uri)` — this
//     function. peekscope.ts keys every one of its generated CSS selectors and
//     its row walk on that same attribute, so the two must be the *same*
//     function, not two implementations that happen to agree. They are an
//     inverse-pair hazard of the same kind as modelUri/parseModelUri: a
//     disagreement throws nothing, logs nothing and shows nothing — the peek
//     simply stops marking out-of-review candidates and stops nudging.
//  2. **`installUriLabels` must run before ANY model or editor exists.**
//     `StandaloneServices.initialize` is `if (initialized) return`, and it is not
//     the only caller — `StandaloneServices.get` initializes with no overrides
//     when it is reached first (standaloneServices.js:716-719), and every
//     `monaco.editor.createModel` goes through it. So "before the first
//     createDiffEditor" is not a strong enough rule; it has to be before the
//     shell starts loading anything at all. See main.ts.

import type * as monaco from 'monaco-editor';
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
import { parseModelUri } from './diff';

/**
 * How a model URI is named for a human: the repo-relative path, with the repo id
 * and the revision dropped.
 *
 * Works for a directory URI as well as a file one — `parseModelUri` only splits
 * the path, and Monaco asks for the label of `dirname(uri)` as often as of the
 * file itself. A file at the repository root therefore has the empty string for
 * its directory, which is the right answer and renders as nothing.
 *
 * Anything that is not one of ours falls through to standalone Monaco's own
 * behaviour. Nothing in this app creates such a URI today, but the label service
 * is global: this stays true if that changes, rather than answering nonsense for
 * a URI it was never shown.
 */
export function modelUriLabel(uri: monaco.Uri): string {
  if (uri.scheme !== 'file' || !uri.authority) {
    return uri.scheme === 'file' ? uri.fsPath : uri.path;
  }
  return parseModelUri(uri).path;
}

/** The last segment of a URI's path — a filename, for one naming a file. */
function basenameOf(uri: monaco.Uri): string {
  const path = modelUriLabel(uri);
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Teaches Monaco to spell a model URI the way this app means it.
 *
 * Call once, before anything creates a model or an editor — see fact 2 in the
 * header. Safe to call more than once: the second call is Monaco's own no-op.
 *
 * The `relative` option the reference tree passes is deliberately ignored. It
 * means "relative to the workspace root" in VS Code, and every label here is
 * already relative to the repository, so there is nothing left to strip — an
 * honest no-op rather than a second notion of relativeness.
 */
export function installUriLabels(): void {
  StandaloneServices.initialize({
    labelService: {
      getUriLabel: (resource: monaco.Uri) => modelUriLabel(resource),
      getUriBasenameLabel: (resource: monaco.Uri) => basenameOf(resource)
    }
  });
}
