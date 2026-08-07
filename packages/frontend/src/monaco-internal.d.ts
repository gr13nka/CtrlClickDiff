// Types for the one monaco-editor internal this app imports directly.
//
// `monaco-editor`'s public surface (`editor.api.d.ts`) describes only what
// `import * as monaco from 'monaco-editor'` gives you, and the service container
// is not in it — the package ships `esm/vs/**` as plain untyped `.js`. Its
// exports map allows the deep path (`"./*": "./*"`), and monaco-env.ts already
// reaches into the same tree for the worker entry points, so importing it is not
// new; only saying what it looks like is.
//
// Deliberately NARROW. This declares the one function urilabel.ts calls and
// nothing else — a fuller transcription of Monaco's internals would be a second
// copy of a contract we do not own, free to drift silently at the next upgrade.
// If a second internal is ever needed, add its signature here and nowhere else,
// so `grep 'esm/vs'` keeps finding every place this app depends on unpublished
// API.
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  import type { editor } from 'monaco-editor';

  export const StandaloneServices: {
    /**
     * Builds the standalone service container, letting `overrides` replace any
     * service that has not been instantiated yet, and returns the instantiation
     * service.
     *
     * Idempotent, and that is the whole reason urilabel.ts has to call it early:
     * the second call returns the container the first one built, overrides
     * ignored. `monaco.editor.create*` calls it, and so does
     * `StandaloneServices.get`, which every `createModel` goes through.
     */
    initialize(overrides: editor.IEditorOverrideServices): unknown;
  };
}
