// Owns the single monaco DiffEditor instance for the app. Mirrors the M1 spike's
// proven pattern (definitionLinkOpensInPeek + gotoLocation applied directly to
// both inner editors, not trusted to propagate from createDiffEditor's options)
// and the M2 plan's model-building approach: models are keyed by
// file://<repoId>/<sha>/<path> (see modelUri) so they never collide across
// repositories or revisions, and reused rather than recreated when a
// repo/rev/path triple repeats (e.g. re-picking a file).

import * as monaco from 'monaco-editor';
import { readStored, writeStored } from './storage';
import { api } from './api';

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

// See plan "Key corrections from research", item 1: definitionLinkOpensInPeek
// is a top-level IEditorOptions boolean, not nested under gotoLocation.
const PEEK_OPTIONS: monaco.editor.IEditorOptions = {
  definitionLinkOpensInPeek: true,
  gotoLocation: {
    multipleDefinitions: 'peek',
    multipleDeclarations: 'peek'
  }
};

// ---------------------------------------------------------------------------
// View preferences
//
// How the diff renders is decided in two places that have to agree: the option
// bag createDiffEditor is constructed with, and every updateOptions() after it.
// Both read viewOptions() rather than being kept in step by hand — which is
// what makes a mode restored from localStorage take effect on the very first
// paint instead of flipping a frame after it, and what makes a new preference
// one field in one object rather than an edit at each site.
// ---------------------------------------------------------------------------

const DIFF_MODE_KEY = 'ccd.diffMode';

// True for Monaco's two-pane layout, false for the one-column inline one, which
// renders deletions as view zones above the lines that replaced them. Anything
// but the exact string 'inline' — unset, blocked storage, hand-edited garbage —
// reads as side-by-side, which is the default.
let sideBySide = readStored(DIFF_MODE_KEY) !== 'inline';

const COLLAPSE_KEY = 'ccd.collapseUnchanged';

// Whether long unchanged stretches are folded away behind a clickable bar.
// On unless explicitly turned off, because a review is about what changed and
// a 120-line file with a two-line edit is 118 lines of scrolling past nothing.
let collapseUnchanged = readStored(COLLAPSE_KEY) !== 'off';

/** The editor options the current preferences add up to. */
function viewOptions(): monaco.editor.IDiffEditorOptions {
  return {
    renderSideBySide: sideBySide,
    hideUnchangedRegions: {
      enabled: collapseUnchanged,
      // Three lines each side of a change, which is `git diff -U3` and what
      // GitHub shows — so a collapsed diff reads like the patch the reviewer
      // already has in their head, rather than like a third convention.
      contextLineCount: 3,
      // Never fold a gap smaller than the context around it: hiding two lines
      // behind a bar that costs one is a loss twice over, in lines saved and in
      // a reader who now has to click to find out there was nothing there.
      minimumLineCount: 3,
      // Monaco's own default, kept: a click that reveals twenty lines is one
      // screenful of decision, where a smaller step turns "read the rest of
      // this function" into a drum roll.
      revealLineCount: 20
    }
  };
}

/** No-op before initDiff(): the construction option bag carries the same values. */
function applyViewOptions(): void {
  diffEditor?.updateOptions(viewOptions());
}

/** Whether the diff is rendering side-by-side. For the sidebar's toggle. */
export function isSideBySide(): boolean {
  return sideBySide;
}

/**
 * Switches between the side-by-side and inline layouts, and remembers which.
 *
 * DO NOT reimplement this by disposing and re-creating the diff editor. Monaco
 * flips renderSideBySide on a live instance perfectly well, and a re-created
 * editor would come up without PEEK_OPTIONS: those are applied to the two inner
 * editors *after* construction precisely because they do not propagate from
 * createDiffEditor's option bag (see initDiff). Nothing would throw and nothing
 * on screen would look wrong — Ctrl+click would just silently stop peeking,
 * which is the one feature this tool is named after.
 */
export function setRenderSideBySide(next: boolean): void {
  sideBySide = next;
  writeStored(DIFF_MODE_KEY, next ? 'side-by-side' : 'inline');
  applyViewOptions();
}

/** Whether unchanged regions are being folded away. For the sidebar's toggle. */
export function isCollapseUnchanged(): boolean {
  return collapseUnchanged;
}

/**
 * Folds unchanged regions away, or expands them all again, and remembers which.
 *
 * Only `enabled` is a preference; the three counts beside it in viewOptions()
 * are not, so turning this back on restores the same layout it hid.
 */
export function setCollapseUnchanged(next: boolean): void {
  collapseUnchanged = next;
  writeStored(COLLAPSE_KEY, next ? 'on' : 'off');
  applyViewOptions();
}

/**
 * Creates the DiffEditor once on `el` and returns it. Safe to call more than
 * once (e.g. from a re-render) — later calls return the existing instance
 * rather than mounting a second editor.
 */
export function initDiff(el: HTMLElement): monaco.editor.IStandaloneDiffEditor {
  if (diffEditor) return diffEditor;

  diffEditor = monaco.editor.createDiffEditor(el, {
    automaticLayout: true,
    readOnly: true,
    // Spread rather than restated, so the persisted preferences are already in
    // force on the first render. Passing them only through updateOptions would
    // paint one frame in the default mode and then flip out from under the
    // reader.
    ...viewOptions()
  });

  diffEditor.getOriginalEditor().updateOptions(PEEK_OPTIONS);
  diffEditor.getModifiedEditor().updateOptions(PEEK_OPTIONS);

  return diffEditor;
}

/**
 * Returns the existing model for `uriString` or creates it. Required for
 * cross-file peek later (M3): a definition provider can only point Monaco at
 * a model that already exists, so every URI we might ever reference goes
 * through this single chokepoint.
 */
export function getOrCreateModel(uriString: string, src: string, language: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.parse(uriString);
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(src, language, uri);
}

/**
 * The one place that knows a model URI's shape: `file://<repoId>/<rev>/<path>`.
 * defprovider.ts's parseModelUri reads it back, and is the only other file
 * allowed to care.
 *
 * The repo id goes in the URI's **authority**, not in the path, for two
 * reasons that both come from Monaco:
 *
 *  - An authority cannot contain '/', which is exactly why the id is an opaque
 *    slug-plus-hash rather than the repository's path. It also means `uri.path`
 *    still holds precisely rev + path, so parsing stays what it was.
 *  - Monaco LOWERCASES the authority in Uri.toString() (vs/base/common/uri.js:
 *    546), and that string is what its model registry keys on. An id with an
 *    uppercase character would be stored under one key and looked up under
 *    another, and the model would silently fail to round-trip — cross-file peek
 *    would just stop rendering, with nothing to show for it. The backend
 *    guarantees ids match /^[a-z0-9][a-z0-9-]*$/ (see repos.ts's repoId), which
 *    is what makes this safe; it is a contract, not a coincidence.
 */
export function modelUri(repoId: string, rev: string, path: string): string {
  return `file://${repoId}/${rev}/${path}`;
}

/**
 * Returns the modified (right-hand, "head") pane's editor instance, or null
 * before initDiff() has run. Exists for main.ts's window.__ccd debug hook, so
 * the M3 verify harness can do coordinate math against the live editor.
 * In-app positioning goes through revealLine() instead, which knows when the
 * editor's layout is safe to scroll against.
 */
export function getModifiedEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return diffEditor?.getModifiedEditor() ?? null;
}

// Guards setModel against out-of-order completions. shell.ts has its own
// epoch counter, but it cannot cover this one: openFile() only regains control
// *after* createDiff resolves, by which point setModel has already run. So two
// overlapping createDiff calls — a commit switch racing a cross-file F12 jump,
// say — would both point the editor somewhere, and whichever fetch finished
// last would win regardless of which the user asked for last.
let diffEpoch = 0;

/**
 * Fetches both sides of `path` at headSha/baseSha in parallel, builds (or
 * reuses) their models, and points the diff editor at them.
 *
 * Superseded calls return without touching the editor.
 */
export async function createDiff(
  repoId: string,
  headSha: string,
  baseSha: string,
  path: string
): Promise<void> {
  if (!diffEditor) {
    throw new Error('createDiff: call initDiff(el) before createDiff()');
  }

  const e = ++diffEpoch;
  const [baseSrc, headSrc] = await Promise.all([
    api.file(repoId, baseSha, path),
    api.file(repoId, headSha, path)
  ]);
  // Also skips building the models: a superseded call's models would only be
  // reachable if that path were opened again, which recreates them anyway.
  if (e !== diffEpoch) return;

  const original = getOrCreateModel(modelUri(repoId, baseSha, path), baseSrc, 'kotlin');
  const modified = getOrCreateModel(modelUri(repoId, headSha, path), headSrc, 'kotlin');

  diffEditor.setModel({ original, modified });
}

// A diff so slow it never arrives must degrade to "position anyway" rather
// than swallow the jump forever.
const DIFF_COMPUTE_TIMEOUT_MS = 1000;

// setModel is synchronous but the diff behind it is not, and until it lands
// the modified pane still carries its pre-diff line layout: none of the
// alignment view zones that pad it against the original, and — now that
// hideUnchangedRegions is on — none of the collapsed regions either, so every
// line below the first fold is still at its uncollapsed position. Scrolling
// before that point aims at coordinates that are about to move.
//
// onDidUpdateDiff alone is not that signal. It's Event.fromObservableLight
// over the diff model's `diff` observable, and a setModel walks that value
// through result -> undefined -> newResult — so the first tick after a model
// swap can arrive with nothing computed yet. getLineChanges() reads the same
// observable and is null in exactly that state, which makes it the readiness
// test; the event only says "check again".
function whenDiffComputed(editor: monaco.editor.IStandaloneDiffEditor): Promise<void> {
  if (editor.getLineChanges() !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, DIFF_COMPUTE_TIMEOUT_MS);

    const sub = editor.onDidUpdateDiff(() => {
      if (editor.getLineChanges() === null) return;
      clearTimeout(timer);
      sub.dispose();
      resolve();
    });
  });
}

/**
 * Positions the cursor at `line` in the modified pane and centers it, once
 * the diff for the current model pair has actually been computed.
 *
 * Cursor first, reveal second — deliberately, not incidentally. It is the
 * *cursor* move that expands a collapsed region: hideUnchangedRegions listens
 * on onDidChangeCursorPosition and calls ensureModifiedLineIsVisible from
 * there. Revealing first would center against the un-expanded layout and let
 * the expansion shift the line back out from under the viewport — which, now
 * that collapsing is on by default, is the ordinary case for any cross-file
 * jump into the middle of a file rather than a hypothetical one.
 *
 * Superseded calls return without touching the editor, on the same rule
 * createDiff follows: the cursor belongs to whichever file the user asked for
 * last, not to whichever jump finished waiting last.
 */
export async function revealLine(line: number): Promise<void> {
  const editor = diffEditor;
  if (!editor) return;

  const e = diffEpoch;
  await whenDiffComputed(editor);
  if (e !== diffEpoch) return;

  const modified = editor.getModifiedEditor();
  modified.setPosition({ lineNumber: line, column: 1 });
  modified.revealLineInCenter(line);
}
