import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Every registry language is monarch-colorized and needs nothing but the
// default editor worker — EXCEPT typescript/javascript: importing the full
// monaco-editor bundle (main.ts) registers the TS language service, which
// spins up its own dedicated worker the moment a typescript/javascript model
// exists. Route those two labels to it; everything else keeps the default.
// Skip the routing and Monaco logs worker errors and silently falls back to
// running the language service on the main thread.
self.MonacoEnvironment = {
  getWorker: (_workerId, label) =>
    label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()
};
