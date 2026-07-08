import './monaco-env';
import type * as monaco from 'monaco-editor';
import { getModifiedEditor } from './diff';
import { registerKotlinDefinitions } from './defprovider';
import { initShell, openFile, getHeadSha, getBaseSha } from './shell';

// Milestone 4: replaces the M3 auto-load-first-file boot with the real
// commit picker + changed-file switcher (shell.ts). All app state (current
// headSha/baseSha/files, active file) now lives in shell.ts's module state;
// this file only wires the debug hook and starts the shell.

// ---------------------------------------------------------------------------
// Debug/testing hook — NOT a public API, do not build product logic against
// it. Exposes just enough app state on `window.__ccd` for (a) the verify
// harness to drive Ctrl+click/F12 checks and do coordinate math against the
// live editor, and (b) defprovider.ts's registerEditorOpener, which routes
// cross-file jumps through openPath() as its one "switch the view to this
// file" entry point — openPath is shell.openFile itself, so the sidebar's
// manual file clicks and F12's cross-file jumps share the exact same code
// path (highlighting, model creation, everything).
interface CcdDebugHook {
  openPath(path: string): Promise<void>;
  readonly headSha: string;
  readonly baseSha: string;
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

registerKotlinDefinitions();

window.__ccd = {
  openPath: openFile,
  get headSha() {
    return getHeadSha();
  },
  get baseSha() {
    return getBaseSha();
  },
  get modifiedEditor() {
    return getModifiedEditor();
  }
};

initShell(app);
