import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Only the default editor worker is required (Kotlin highlighting is bundled
// in basic-languages and needs no dedicated language worker).
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};
