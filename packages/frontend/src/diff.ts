// Owns the single monaco DiffEditor instance for the app. Mirrors the M1 spike's
// proven pattern (definitionLinkOpensInPeek + gotoLocation applied directly to
// both inner editors, not trusted to propagate from createDiffEditor's options)
// and the M2 plan's model-building approach: models are keyed by
// file:///<sha>/<path> so they never collide across revisions, and reused
// rather than recreated when a path/rev pair repeats (e.g. re-picking a file).

import * as monaco from 'monaco-editor';
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
    renderSideBySide: true
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
 * Returns the modified (right-hand, "head") pane's editor instance, or null
 * before initDiff() has run. Used by defprovider.ts's editor opener (to
 * reveal a jumped-to line) and by main.ts's window.__ccd debug hook (so the
 * M3 verify harness can do coordinate math against the live editor).
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
export async function createDiff(headSha: string, baseSha: string, path: string): Promise<void> {
  if (!diffEditor) {
    throw new Error('createDiff: call initDiff(el) before createDiff()');
  }

  const e = ++diffEpoch;
  const [baseSrc, headSrc] = await Promise.all([api.file(baseSha, path), api.file(headSha, path)]);
  // Also skips building the models: a superseded call's models would only be
  // reachable if that path were opened again, which recreates them anyway.
  if (e !== diffEpoch) return;

  const original = getOrCreateModel(`file:///${baseSha}/${path}`, baseSrc, 'kotlin');
  const modified = getOrCreateModel(`file:///${headSha}/${path}`, headSrc, 'kotlin');

  diffEditor.setModel({ original, modified });
}
