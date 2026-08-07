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

    /**
     * Resolves a service by its decorator, initializing the container with no
     * overrides if nothing has yet.
     *
     * The identifier is opaque here on purpose — typing it would mean
     * transcribing Monaco's `ServiceIdentifier`, and the only caller
     * (peeklayout.ts) immediately narrows the result to the one interface it
     * uses.
     */
    get<T>(id: unknown): T;
  };
}

declare module 'monaco-editor/esm/vs/platform/storage/common/storage.js' {
  /**
   * Decorator for the key-value store the peek reads its saved layout back from
   * on every open (referencesController.js:85-86). Standalone Monaco backs it
   * with `InMemoryStorageService`, so nothing stored here outlives the tab.
   *
   * `StorageScope` and `StorageTarget` are deliberately absent: they are const
   * enums, so Monaco's build inlines them as bare numbers and the module does
   * not export them at runtime (its export list is
   * AbstractStorageService, IStorageService, InMemoryStorageService, TARGET_KEY,
   * WillSaveStateReason, loadKeyTargets). Declaring them here would typecheck
   * and then be `undefined` in the browser. Callers pass the literals, the way
   * Monaco's own transpiled call sites do.
   */
  export const IStorageService: unknown;
}
