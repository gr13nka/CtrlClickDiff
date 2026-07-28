// Milestone 3 — Kotlin definition provider. This is the feature's "heart":
// it's what turns Ctrl+click into an inline peek and F12 into a cross-file
// jump. See peekdiff-mvp-iterative-wind.md, "Milestone 3 — Tree-sitter brain".
//
// Two facts (verified in M1/M3 research) shape everything below:
//
//  1. Monaco calls provideDefinition TWICE per Ctrl+click — once to decide
//     whether to underline the word as a link on hover, once to actually
//     resolve it on click. The provider must be cheap/idempotent: file
//     fetches are memoized per (rev, path) so a single click never issues
//     the same GET /api/file twice.
//  2. Cross-file peek only renders if the *target* model already exists in
//     monaco's model registry by the time provideDefinition returns. So
//     every DefLocation we get back has its model eagerly built (via
//     diff.ts's getOrCreateModel, never a blind createModel) before we
//     hand back the Location[].
//
// Model URIs are file://<repoId>/<rev>/<path> (built by diff.ts's modelUri,
// which explains why the repo id lives in the authority). The model the user
// clicked in is therefore the only thing this file needs to know *which*
// repository to resolve against — there is no ambient "current repo" here, and
// deliberately so: a resolution belongs to the model it started from.
// `path` may itself contain '/', so parsing takes the first path segment as
// `rev` and rejoins the remainder as `path`.

import * as monaco from 'monaco-editor';
import type { DefLocation } from '@ctrlclickdiff/shared';
import { api } from './api';
import { getOrCreateModel, modelUri, revealLine } from './diff';

function parseModelUri(uri: monaco.Uri): { repoId: string; rev: string; path: string } {
  const segments = uri.path.replace(/^\/+/, '').split('/');
  const [rev = '', ...rest] = segments;
  return { repoId: uri.authority, rev, path: rest.join('/') };
}

// Memoizes GET /api/file per "<repoId>/<rev>/<path>" so the two
// provideDefinition calls per click (see file header, fact 1) never
// double-fetch, and so repeatedly peeking the same cross-file target reuses one
// resolved fetch instead of racing two. The repo id is part of the key for the
// same reason it is part of the URI: a SHA alone does not identify a file.
const fileCache = new Map<string, Promise<string>>();

function memoizedFile(repoId: string, rev: string, path: string): Promise<string> {
  const key = `${repoId}/${rev}/${path}`;
  let pending = fileCache.get(key);
  if (!pending) {
    pending = api.file(repoId, rev, path);
    fileCache.set(key, pending);
  }
  return pending;
}

let registered = false;

/**
 * Registers the kotlin definition provider and the cross-file editor
 * opener. Call once during app init, after monaco is available (see
 * main.ts). Safe to call more than once — later calls are no-ops, so
 * accidental double-init never double-registers the provider.
 */
export function registerKotlinDefinitions(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerDefinitionProvider('kotlin', {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const { repoId, rev, path } = parseModelUri(model.uri);

      let defs: DefLocation[];
      try {
        defs = await api.def({ repoId, name: word.word, file: path, line: position.lineNumber, rev });
      } catch (err) {
        // Network/server error is not a "no definition found" — but Monaco
        // has no distinct signal for the two, so log and degrade to "none".
        console.error('[ccd] /api/def failed', err);
        return null;
      }

      const locations: monaco.languages.Location[] = [];
      for (const loc of defs) {
        // Same repo as the model the click started in: a definition never
        // crosses repositories, so the id travels straight through.
        const uriStr = modelUri(repoId, rev, loc.path);
        // REQUIRED for cross-file peek (see file header, fact 2): build the
        // target model before returning, from the *same* memoized fetch a
        // second provideDefinition call for this click would reuse.
        getOrCreateModel(uriStr, await memoizedFile(repoId, rev, loc.path), 'kotlin');
        locations.push({
          uri: monaco.Uri.parse(uriStr),
          range: new monaco.Range(loc.line, loc.column, loc.line, loc.column)
        });
      }
      return locations;
    }
  });

  // F12 / "go to definition" on a cross-file Location routes through here
  // instead of monaco's default no-op for resources other than the current
  // model. Routes through the app's debug/open hook (window.__ccd, see
  // main.ts) rather than talking to diff.ts directly — that hook is the
  // one "switch the view to this file" entry point, and M4's real file
  // switcher will replace its implementation without this file changing.
  monaco.editor.registerEditorOpener({
    async openCodeEditor(_source, resource, selectionOrPosition) {
      const { path } = parseModelUri(resource);
      const ccd = window.__ccd;
      if (!ccd) return false;

      await ccd.openPath(path);

      // Best-effort: land the cursor/viewport on the target line now that
      // the modified editor's model has switched. revealLine owns the timing
      // and ordering this needs (see diff.ts) — openPath only guarantees the
      // models are swapped, not that the diff behind them has been computed,
      // and scrolling before that lands on a layout that then moves. Wrapped
      // in try/catch — the jump itself (the file switch) already succeeded
      // either way.
      try {
        const line = selectionOrPosition
          ? 'lineNumber' in selectionOrPosition
            ? selectionOrPosition.lineNumber
            : selectionOrPosition.startLineNumber
          : undefined;
        if (line !== undefined) await revealLine(line);
      } catch (err) {
        console.error('[ccd] editor opener: reveal failed', err);
      }

      return true;
    }
  });
}
