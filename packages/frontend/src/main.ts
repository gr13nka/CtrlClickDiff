import './monaco-env';
import * as monaco from 'monaco-editor';
import { registerDefinitions } from './defprovider';
import { installTheme } from './theme';
import {
  initShell,
  revealPath,
  getActiveEditor,
  getHeadSha,
  getBaseSha,
  getRepoId,
  getSelectedShas,
  isInReview
} from './shell';

// Milestone 4: replaces the M3 auto-load-first-file boot with the real
// commit picker + changed-file switcher (shell.ts). All app state (current
// headSha/baseSha/files, active file) now lives in shell.ts's module state;
// this file only wires the debug hook and starts the shell.

// ---------------------------------------------------------------------------
// Debug/testing hook — NOT a public API, do not build product logic against
// it. Exposes just enough app state on `window.__ccd` for (a) the verify
// harness to drive Ctrl+click/F12 checks and do coordinate math against the
// live editor, and (b) defprovider.ts's registerEditorOpener, which routes
// cross-file jumps through openPath() as its one "take the reader to this file"
// entry point — openPath is shell.revealPath itself, so the sidebar's manual
// file clicks and F12's cross-file jumps share the exact same code path
// (scrolling, mounting, cursor placement, everything).
interface CcdDebugHook {
  /**
   * `line` is 1-based and optional: without one the file is scrolled to, not into.
   * `rev` lets a path the selection never changed be opened as a reference card;
   * only the peek's editor-opener has one, and only it needs to.
   */
  openPath(path: string, line?: number, rev?: string): Promise<void>;
  /** '' until the shell has resolved a repository. Also the model URIs' authority. */
  readonly repoId: string;
  readonly headSha: string;
  readonly baseSha: string;
  /**
   * The selected commits, newest-first — one sha in the ordinary case, several
   * for a ghost squash. headSha/baseSha describe the span those collapse to,
   * which cannot be read backwards: several different selections share a span.
   * A harness checking *which* commits a preview was built from has to ask here.
   */
  readonly selectedShas: string[];
  /**
   * The modified pane of the file at the top of the band — "the" editor no
   * longer being a thing, now that every changed file has one. Null before the
   * first card has mounted.
   */
  readonly modifiedEditor: monaco.editor.IStandaloneCodeEditor | null;
}

declare global {
  interface Window {
    __ccd: CcdDebugHook;
  }
}
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
if (!app) throw new Error('main.ts: #app element not found');

// The predicate, not the file list: the provider asks about one path at a time
// and must see the *current* selection, which a snapshot taken here could not.
registerDefinitions(isInReview);

// The TS language service is turned OFF wholesale, not just quieted. Its
// "project" is every typescript/javascript model in the registry at once, and
// this app's registry deliberately holds models from MULTIPLE revisions side
// by side (file://<repo>/<rev>/<path>, never disposed) — so any answer it
// gives is computed across a soup of revisions and is wrong by construction
// here. Concretely measured: with only its diagnostics silenced, a Ctrl+click
// on `render` in App.tsx peeked "Definitions (2)" — our resolver's answer
// plus the service's duplicate of it — because the service registers its own
// definition provider beside ours. Colorization is unaffected (monarch, not
// the worker), and with every feature off the ts.worker never spawns;
// monaco-env.ts's worker routing stays as the guard if one ever does.
// Lives here rather than in monaco-env.ts, which deliberately does not import
// monaco — it only defines MonacoEnvironment for the workers.
const TS_SERVICE_OFF: monaco.typescript.ModeConfiguration = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false
};
monaco.typescript.typescriptDefaults.setModeConfiguration(TS_SERVICE_OFF);
monaco.typescript.javascriptDefaults.setModeConfiguration(TS_SERVICE_OFF);

// Before initShell(), which starts the first cards loading: a theme set
// afterwards would repaint them a frame late, and the theme is global state
// Monaco reads at construction time.
installTheme();

window.__ccd = {
  openPath: revealPath,
  get repoId() {
    return getRepoId();
  },
  get headSha() {
    return getHeadSha();
  },
  get baseSha() {
    return getBaseSha();
  },
  get selectedShas() {
    return getSelectedShas();
  },
  get modifiedEditor() {
    return getActiveEditor();
  }
};

initShell(app);
