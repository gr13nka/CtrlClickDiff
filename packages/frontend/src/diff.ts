// Makes monaco DiffEditors, one per file in the band (band.ts owns where they
// go and when they exist). Mirrors the M1 spike's proven pattern
// (definitionLinkOpensInPeek + gotoLocation applied directly to both inner
// editors, not trusted to propagate from createDiffEditor's options) and the M2
// plan's model-building approach: models are keyed by
// file://<repoId>/<sha>/<path> (see modelUri) so they never collide across
// repositories or revisions, and reused rather than recreated when a
// repo/rev/path triple repeats (e.g. re-picking a file).
//
// This file owns everything about *an* editor and nothing about the column it
// sits in. A FileDiff keeps its own host element sized to its content, because
// how tall a diff needs to be is the editor's business and not the band's — the
// band only ever reads that height back to hold a card's place while the editor
// is away.

import * as monaco from 'monaco-editor';
import { languageForPath, type FileStatus } from '@ctrlclickdiff/shared';
import { readStored, writeStored } from './storage';
import { api } from './api';

// See plan "Key corrections from research", item 1: definitionLinkOpensInPeek
// is a top-level IEditorOptions boolean, not nested under gotoLocation.
const PEEK_OPTIONS: monaco.editor.IEditorOptions = {
  definitionLinkOpensInPeek: true,
  gotoLocation: {
    multipleDefinitions: 'peek',
    multipleDeclarations: 'peek'
  }
};

// Every editor currently on screen, against the status of the file it shows.
// The band creates and disposes these as cards scroll in and out of reach, so a
// view preference has to reach all of them at once — and a card that was away
// while a toggle flipped has to come back in the new mode, which is why
// viewOptions() is also spread into the construction bag below.
//
// A Map rather than a Set because viewOptions() is a function of the file's
// status as well as the preferences: an added or deleted file is always one
// pane. Without the status here, the next toggle would push a bare
// `renderSideBySide: sideBySide` over that and put the empty pane back.
const liveEditors = new Map<monaco.editor.IStandaloneDiffEditor, FileStatus>();

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

const WRAP_KEY = 'ccd.wordWrap';

// Whether a line too long for its pane wraps instead of running off the edge.
// On unless explicitly turned off, and that default is the fix for a measured
// failure rather than a taste: side-by-side halves an already-capped column, so
// on this repo's own shell.ts at 1900px each pane is 633px against a widest line
// of 899px — 113 of 113 rendered lines clipped. Monaco's horizontal scrollbar is
// opacity 0 until hovered, so nothing on screen even said text was missing; the
// reader silently lost the end of every comment.
let wordWrap = readStored(WRAP_KEY) !== 'off';

const COLLAPSE_KEY = 'ccd.collapseUnchanged';

// Whether long unchanged stretches are folded away behind a clickable bar.
// On unless explicitly turned off, because a review is about what changed and
// a 120-line file with a two-line edit is 118 lines of scrolling past nothing.
let collapseUnchanged = readStored(COLLAPSE_KEY) !== 'off';

/**
 * The editor options the current preferences add up to, for a file of `status`.
 *
 * Side-by-side is a preference for a *modified* file and a mistake for the other
 * two. An added file has no "before" and a deleted one has no "after", so one of
 * the two panes holds nothing and Monaco fills it with diagonal hatch — measured
 * on this repo's own `deeplink.ts`, 1,195,936 px² of hatch against 1,141,200 px²
 * of visible card, i.e. the majority of the card spent saying "there is nothing
 * here" while the half holding all the content was squeezed to 633px and clipped
 * every one of its 113 lines. There is nothing to compare; do not draw a
 * comparison.
 */
function viewOptions(status: FileStatus): monaco.editor.IDiffEditorOptions {
  return {
    renderSideBySide: sideBySide && status === 'M',
    wordWrap: wordWrap ? 'on' : 'off',
    // 'indent' rather than Monaco's default 'same': a continuation that starts
    // further in than the line it continues cannot be mistaken for a statement
    // of its own, which matters more here than anywhere, because the reader is
    // scanning for what changed rather than following control flow.
    wrappingIndent: 'indent',
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

/** No-op while nothing is mounted: the construction option bag carries the same values. */
function applyViewOptions(): void {
  for (const [editor, status] of liveEditors) editor.updateOptions(viewOptions(status));
}

/** Whether the diff is rendering side-by-side. For the sidebar's toggle. */
export function isSideBySide(): boolean {
  return sideBySide;
}

/**
 * Switches between the side-by-side and inline layouts, and remembers which.
 *
 * Flips the option on every live instance rather than rebuilding them. Monaco
 * handles renderSideBySide on a live editor perfectly well, and a rebuild here
 * would be both wasteful and a chance to get PEEK_OPTIONS wrong — see
 * createFileDiff for why that failure is invisible.
 */
export function setRenderSideBySide(next: boolean): void {
  sideBySide = next;
  writeStored(DIFF_MODE_KEY, next ? 'side-by-side' : 'inline');
  applyViewOptions();
}

/** Whether long lines wrap. For the topbar's toggle. */
export function isWordWrap(): boolean {
  return wordWrap;
}

/**
 * Wraps long lines, or lets them run off the edge again, and remembers which.
 *
 * The escape hatch exists because wrapping is not free everywhere: a wide table,
 * generated code or ASCII art is held together by its columns, and reflowing it
 * destroys the structure the reader was using. Off, the horizontal scrollbar is
 * the only way to see the rest of a line — which is the state this app shipped
 * in, so nothing is lost by making it reachable.
 */
export function setWordWrap(next: boolean): void {
  wordWrap = next;
  writeStored(WRAP_KEY, next ? 'on' : 'off');
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

// Options that make an editor a *slice of a page* rather than its own scrolling
// viewport. Every one is load-bearing, and the first three are what the band
// physically cannot work without:
//
//  - scrollBeyondLastLine, off. On it, getContentHeight() includes a whole
//    viewport of trailing padding — measured at 837px of the 3136px a 121-line
//    file reported, against 856px of pane. Every card would end in a screenful
//    of nothing.
//  - handleMouseWheel off and alwaysConsumeMouseWheel off. The second is the one
//    that matters: it defaults to true, and on true Monaco swallows a wheel
//    event it cannot use instead of letting it bubble to the scroller.
//  - vertical scrollbar hidden. There is never anything to scroll — the host is
//    exactly as tall as the content — so the bar would only ever be a full-height
//    thumb, once per file.
//
// fixedOverflowWidgets moves hovers and suggest widgets to the body, so the
// card's overflow:hidden (which the rounded corners need) cannot clip them.
// Peek is unaffected: it is a *zone* widget living inline in the content, which
// is what lets a card simply grow to contain it.
const BAND_OPTIONS: monaco.editor.IDiffEditorConstructionOptions = {
  automaticLayout: true,
  readOnly: true,
  scrollBeyondLastLine: false,
  scrollbar: {
    vertical: 'hidden',
    horizontal: 'auto',
    handleMouseWheel: false,
    alwaysConsumeMouseWheel: false
  },
  renderOverviewRuler: false,
  overviewRulerLanes: 0,
  stickyScroll: { enabled: false },
  fixedOverflowWidgets: true
};

/** One file's diff, mounted. Created and disposed by band.ts as cards come and go. */
export interface FileDiff {
  /**
   * The modified (right-hand, "head") pane. The band does reveal maths against
   * it, and main.ts's debug hook exposes the active card's.
   */
  readonly modified: monaco.editor.IStandaloneCodeEditor;
  /** Resolves once the diff for this pair has actually been computed. */
  whenDiffComputed(): Promise<void>;
  /**
   * How many lines this diff adds and removes, or null before it is computed.
   *
   * Read off Monaco's own line changes rather than counted anywhere else,
   * because this is the diff the reader is looking at — `getLineChanges()` is
   * the same list the `.line-insert` / `.line-delete` tinting is drawn from, so
   * the number in the header and the coloured lines under it cannot disagree.
   *
   * That is worth being deliberate about, because it does NOT always equal
   * `git diff --numstat`. Monaco's diff algorithm is its own: on this project's
   * shell.ts over one selection it reports +98/-14 where every git algorithm —
   * myers, minimal, patience, histogram, with and without the indent heuristic
   * — says +96/-12. Both are valid diffs of the same content; they just draw
   * hunk boundaries differently. Matching git would mean printing a number that
   * contradicts the lines on screen, which is the worse of the two.
   *
   * Asking git would also answer a different question in a second way: over a
   * multi-commit selection, a line touched twice is counted twice by summing
   * `--numstat` across commits and once by diffing the endpoints.
   */
  churn(): { added: number; removed: number } | null;
  /** Current content height in px — what the host element is sized to. */
  height(): number;
  /** Drops the editor. Leaves the models: see loadModels. */
  dispose(): void;
}

/**
 * Fetches both sides of `path`, builds (or reuses) their models, mounts a diff
 * editor on `host` and keeps `host` sized to the editor's content.
 *
 * **This is the only place a diff editor is constructed, and that is a
 * guarantee the band depends on rather than a tidiness preference.**
 * PEEK_OPTIONS has to be applied to the two inner editors *after* construction,
 * because it does not propagate from createDiffEditor's option bag (the M1 spike
 * established this). An editor built anywhere else would look completely normal
 * and simply never peek — no error, nothing wrong on screen, the one feature
 * this tool is named after silently gone. Cards are now created and disposed
 * routinely as the reader scrolls, so that mistake would be permanent and
 * invisible. Keep the door single.
 */
export async function createFileDiff(
  host: HTMLElement,
  spec: { repoId: string; path: string; status: FileStatus; baseSha: string; headSha: string }
): Promise<FileDiff> {
  const { original, modified } = await loadModels(spec);

  const editor = monaco.editor.createDiffEditor(host, {
    ...BAND_OPTIONS,
    // Spread rather than restated, so the persisted preferences — and any
    // toggle flipped while this card was unmounted — are already in force on
    // the first paint instead of flipping a frame after it.
    ...viewOptions(spec.status)
  });

  editor.getOriginalEditor().updateOptions(PEEK_OPTIONS);
  editor.getModifiedEditor().updateOptions(PEEK_OPTIONS);

  editor.setModel({ original, modified });
  liveEditors.set(editor, spec.status);

  // Auto-height. IDiffEditor has no onDidContentSizeChange of its own — it
  // extends IEditor, not ICodeEditor (monaco.d.ts:6410) — so the signal has to
  // come from the two inner editors, which are ICodeEditors and do have it
  // (monaco.d.ts:6107).
  //
  // The max of the two, because side-by-side pads the shorter pane with
  // alignment view zones while inline mode carries the deletions as view zones
  // on the modified side; whichever mode is on, one of the two is the full
  // height and neither is always the one.
  //
  // The `=== applied` early return is what stops this recursing: writing the
  // height trips automaticLayout's ResizeObserver, which lays the editor out
  // again. It terminates because scrollBeyondLastLine is off, which is exactly
  // what makes content height independent of viewport height — with it on, a
  // taller host would mean taller content would mean a taller host.
  let applied = -1;
  const syncHeight = (): void => {
    const px = Math.max(
      editor.getOriginalEditor().getContentHeight(),
      editor.getModifiedEditor().getContentHeight()
    );
    if (px === applied) return;
    applied = px;
    host.style.height = `${px}px`;
    // Now rather than a frame later, when the ResizeObserver would get here on
    // its own: a reveal measures line positions immediately after awaiting a
    // height change, and a measurement against the pre-resize layout is the
    // whole bug class the cursor-before-reveal rule exists for.
    editor.layout();
  };

  const subs = [
    editor.getOriginalEditor().onDidContentSizeChange(syncHeight),
    editor.getModifiedEditor().onDidContentSizeChange(syncHeight)
  ];
  syncHeight();

  return {
    modified: editor.getModifiedEditor(),
    whenDiffComputed: () => whenDiffComputed(editor),
    churn: () => churnOf(editor),
    height: () => applied,
    dispose: () => {
      for (const sub of subs) sub.dispose();
      liveEditors.delete(editor);
      editor.dispose();
    }
  };
}

/**
 * One file at one revision, as a plain read-only editor sized to its content —
 * the *context* card the band shows for a definition in a file the selection
 * never touched.
 *
 * Deliberately NOT a diff editor with the same model on both sides. That was the
 * old single-editor view's mistake and it is recorded in revealPath's comment:
 * for an untouched file the two ends of the span hold identical content, so the
 * reader arrives at a diff of a file against itself with every line folded away
 * behind an unchanged-region bar. A file that is not being diffed should not be
 * dressed as a diff.
 *
 * It satisfies `FileDiff` so a card does not care which kind it holds — the only
 * asymmetry is `whenDiffComputed`, which resolves immediately here because there
 * is no diff to wait for.
 *
 * PEEK_OPTIONS is applied after construction like createFileDiff does, and for
 * the same reason spelled out there: without it this editor would look completely
 * normal and simply never peek, so Ctrl+click would work everywhere except the
 * card you reached BY Ctrl+click. It is not registered in `liveEditors` — that
 * set exists for the side-by-side/inline toggle, which is a diff-only idea.
 */
export async function createFileView(
  host: HTMLElement,
  spec: { repoId: string; path: string; rev: string }
): Promise<FileDiff> {
  const { repoId, path, rev } = spec;
  const uri = modelUri(repoId, rev, path);
  const model =
    findModel(uri) ??
    getOrCreateModel(uri, await api.file(repoId, rev, path), languageForPath(path)?.id ?? 'plaintext');

  const editor = monaco.editor.create(host, {
    ...BAND_OPTIONS,
    // A diff editor takes renderSideBySide et al; a plain one must not be handed
    // options it does not understand, so only the shared subset is spread and
    // the model is set explicitly rather than through the bag (see loadModels on
    // why models must outlive their editor).
    model: null
  });
  editor.updateOptions(PEEK_OPTIONS);
  editor.setModel(model);

  let applied = -1;
  const syncHeight = (): void => {
    const px = editor.getContentHeight();
    if (px === applied) return;
    applied = px;
    host.style.height = `${px}px`;
    editor.layout();
  };
  const sub = editor.onDidContentSizeChange(syncHeight);
  syncHeight();

  return {
    modified: editor,
    whenDiffComputed: () => Promise.resolve(),
    // A reference card is one revision of a file the selection never touched,
    // so there is no churn to report — not "0 added, 0 removed", which would be
    // a claim about a diff that was never taken. null is the same answer this
    // gives before a real diff has computed, and the caller already draws
    // nothing for it.
    churn: () => null,
    height: () => applied,
    dispose: () => {
      sub.dispose();
      editor.dispose();
    }
  };
}

/**
 * Both sides of one file as models, fetching only what is not already built.
 *
 * Models are deliberately never disposed — not here, and not by FileDiff.dispose.
 * That is what makes a card free to re-mount: `(rev, path)` content is immutable,
 * so a model that exists is still correct, and scrolling back up costs no
 * requests at all. Monaco guarantees it, too: a model handed over via setModel
 * (rather than through the construction bag) survives the editor's disposal.
 *
 * The two fetches are also not always two. `git show` on a path that does not
 * exist at a revision answers with an empty string, so an added file's base side
 * and a deleted file's head side are known blank without asking — and asking
 * would cost a subprocess per card.
 */
async function loadModels(spec: {
  repoId: string;
  path: string;
  status: FileStatus;
  baseSha: string;
  headSha: string;
}): Promise<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }> {
  const { repoId, path, status, baseSha, headSha } = spec;
  const baseUri = modelUri(repoId, baseSha, path);
  const headUri = modelUri(repoId, headSha, path);

  const cachedBase = findModel(baseUri);
  const cachedHead = findModel(headUri);
  if (cachedBase && cachedHead) return { original: cachedBase, modified: cachedHead };

  const [baseSrc, headSrc] = await Promise.all([
    cachedBase || status === 'A' ? '' : api.file(repoId, baseSha, path),
    cachedHead || status === 'D' ? '' : api.file(repoId, headSha, path)
  ]);

  // A path no registered language claims still gets a model — it just gets no
  // highlighting and no definition provider. Falling back to 'plaintext' rather
  // than skipping keeps "every changed file has a card" true, which the band
  // depends on.
  const language = languageForPath(path)?.id ?? 'plaintext';

  return {
    original: cachedBase ?? getOrCreateModel(baseUri, baseSrc, language),
    modified: cachedHead ?? getOrCreateModel(headUri, headSrc, language)
  };
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
 * The already-built model for `uriString`, or null. Separate from
 * getOrCreateModel rather than a flag on it, because the callers want opposite
 * things: that one guarantees a model exists, this one asks whether fetching
 * its content can be skipped.
 */
function findModel(uriString: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModel(monaco.Uri.parse(uriString));
}

/**
 * The one place that knows a model URI's shape: `file://<repoId>/<rev>/<path>`.
 * `parseModelUri` below is its inverse; together they are the only code allowed
 * to care about the layout.
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
 * `modelUri`'s inverse, and it lives here for that reason: a change to the
 * layout above is only correct if this changes with it, and split across two
 * files that pairing was a convention rather than something the code held.
 * Getting it wrong fails silently at runtime — cross-file peek simply stops
 * rendering — not at typecheck, which is what makes the split expensive.
 *
 * `path` may itself contain '/', so the first path segment is the rev and the
 * remainder is rejoined.
 */
export function parseModelUri(uri: monaco.Uri): { repoId: string; rev: string; path: string } {
  const segments = uri.path.replace(/^\/+/, '').split('/');
  const [rev = '', ...rest] = segments;
  return { repoId: uri.authority, rev, path: rest.join('/') };
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
 * Added and removed line counts, off the same `getLineChanges()` that decides
 * readiness above — null until it is.
 *
 * An `ILineChange` uses an END line of 0 to mean "this side contributes
 * nothing", which is how a pure insertion and a pure deletion are spelled. That
 * is why each side is guarded rather than subtracted unconditionally: on a
 * pure insertion the original range is 0..0, and `end - start + 1` would count
 * it as one removed line that does not exist.
 */
function churnOf(
  editor: monaco.editor.IStandaloneDiffEditor
): { added: number; removed: number } | null {
  const changes = editor.getLineChanges();
  if (changes === null) return null;

  let added = 0;
  let removed = 0;
  for (const c of changes) {
    if (c.originalEndLineNumber > 0) {
      removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
    }
    if (c.modifiedEndLineNumber > 0) {
      added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    }
  }

  // Neither side can change more lines than it has, and that clamp is doing two
  // jobs a pair of special cases would have done worse.
  //
  // A text model counts the empty string after a file's trailing newline as a
  // line and git does not, so a whole-file add reported "+113" for the 112-line
  // file `git diff --numstat` counts. And loadModels hands an added file '' for
  // its original, which is one empty line, so the same file also reported "-1"
  // — the absence of the file, counted as a deletion.
  //
  // Clamping to each side's real line count fixes both, and keeps working for
  // the cases neither special case would have covered: a file emptied but not
  // deleted (status still 'M', git says "+0 -N"), or one whose trailing newline
  // is itself what changed.
  const models = editor.getModel();
  if (models) {
    added = Math.min(added, contentLines(models.modified));
    removed = Math.min(removed, contentLines(models.original));
  }
  return { added, removed };
}

/** Lines as git counts them: the empty one after a trailing newline is not a line. */
function contentLines(model: monaco.editor.ITextModel): number {
  const n = model.getLineCount();
  return n > 0 && model.getLineLength(n) === 0 ? n - 1 : n;
}
