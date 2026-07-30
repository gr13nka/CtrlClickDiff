// Milestone 3 — Kotlin definition provider. This is the feature's "heart":
// it's what turns Ctrl+click into an inline peek and F12 into a cross-file
// jump. See peekdiff-mvp-iterative-wind.md, "Milestone 3 — Tree-sitter brain".
//
// Two facts (verified in M1/M3 research) shape everything below:
//
//  1. Monaco calls provideDefinition TWICE per Ctrl+click — once to decide
//     whether to underline the word as a link on hover, once to actually
//     resolve it on click. The provider must be cheap/idempotent, so BOTH
//     network calls are coalesced: file fetches are memoized per (rev, path),
//     and /api/def is deduped while in flight. A single click issues one of
//     each. Both provider bodies still run in full — see coalescedDef.
//  2. Cross-file peek only renders if the *target* model already exists in
//     monaco's model registry by the time provideDefinition returns. So
//     every DefLocation we get back has its model eagerly built (via
//     diff.ts's getOrCreateModel, never a blind createModel) before we
//     hand back the Location[].
//
// Model URIs are file://<repoId>/<rev>/<path>, built and read back by diff.ts's
// modelUri/parseModelUri pair (which explains why the repo id lives in the
// authority). The model the user clicked in is therefore the only thing this
// file needs to know *which* repository to resolve against — there is no
// ambient "current repo" here, and deliberately so: a resolution belongs to the
// model it started from.

import * as monaco from 'monaco-editor';
import { LANGUAGES, type DefLocation } from '@ctrlclickdiff/shared';
import { api } from './api';
import { getOrCreateModel, modelUri, parseModelUri } from './diff';
import { applyPeekScope } from './peekscope';

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

/**
 * At most this many memoized /api/def answers, least-recently-used evicted
 * first. Small on purpose: an entry is one short DefLocation[], and the working
 * set is "words the reader pointed at recently", not the repository.
 */
const DEF_CACHE_LIMIT = 256;

/**
 * Memoizes GET /api/def so one Ctrl+click issues one request rather than two.
 *
 * Monaco calls the provider TWICE per click (file header, fact 1) — once to
 * decide whether to underline the word as a link on hover, once to resolve it
 * on click — and both calls used to reach the network.
 *
 * Storing the PROMISE is what covers both shapes of that pair, and measuring is
 * what showed both are needed. When the two calls overlap — a slow resolve,
 * which is exactly when a duplicate hurts most — the second joins the first
 * instead of racing it. When they do NOT overlap, which is the ordinary case
 * (measured ~1s apart over CDP, because the hover resolves long before the
 * mouse goes down), only a retained answer removes the second request. An
 * in-flight-only map was written first and measured: it left the count at two.
 *
 * Retaining is sound because the key names immutable content:
 * (repoId, rev, file, line, name) is a question about one revision, and a
 * revision does not change. Same reason the backend's per-file symbol cache has
 * no TTL and diff.ts never disposes a model — an entry cannot become wrong, only
 * surplus, so a bound rather than an expiry is what keeps it honest. Unlike
 * fileCache above this one HAS a bound: a fileCache entry backs a Monaco model
 * that is itself permanent, so those two share a lifetime, whereas a def answer
 * has no such anchor and would otherwise accumulate one entry per word ever
 * pointed at.
 *
 * `line` is in the key even though the current resolver ignores it, because
 * DefQuery.line documents that a scope-aware implementation is expected to use
 * it. Both calls of one gesture share a position, so including it costs nothing
 * and stops the key becoming a lie later.
 *
 * This memoizes the FETCH only. Both provider calls still run their bodies:
 * each builds the target models, and each calls applyPeekScope, whose sampling
 * point peekscope.ts documents as load-bearing. Returning early from the second
 * call would leave the scope unset and silently break the out-of-review nudge.
 */
const defCache = new Map<string, Promise<DefLocation[]>>();

function memoizedDef(params: {
  repoId: string;
  name: string;
  file: string;
  line: number;
  rev: string;
}): Promise<DefLocation[]> {
  const { repoId, name, file, line, rev } = params;
  const key = [repoId, rev, file, line, name].join('\u0000');

  const cached = defCache.get(key);
  if (cached) {
    // Map iterates in insertion order, so delete+set is the whole LRU.
    defCache.delete(key);
    defCache.set(key, cached);
    return cached;
  }

  // A rejection must NOT stay cached: a failed fetch is not an answer, and the
  // provider degrades it to "no definition found". Leaving it in would make one
  // network blip permanent for that word.
  const pending = api.def(params).catch((err) => {
    defCache.delete(key);
    throw err;
  });
  defCache.set(key, pending);

  while (defCache.size > DEF_CACHE_LIMIT) {
    const oldest = defCache.keys().next().value;
    if (oldest === undefined) break;
    defCache.delete(oldest);
  }

  return pending;
}

let registered = false;

/**
 * Whether a repo-relative path is one of the files the current selection
 * changed. Injected rather than imported so this file keeps having no ambient
 * state of its own: a resolution belongs to the model it started from, and the
 * *review* it is judged against belongs to the shell (see main.ts, which wires
 * shell.isInReview in the same place it wires window.__ccd).
 */
export type InReview = (path: string) => boolean;

/**
 * Registers the definition provider for every language in the registry, plus
 * the cross-file editor opener. Call once during app init, after monaco is
 * available (see main.ts). Safe to call more than once — later calls are
 * no-ops, so accidental double-init never double-registers the provider.
 */
export function registerDefinitions(inReview: InReview): void {
  if (registered) return;
  registered = true;

  const provider: monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const { repoId, rev, path } = parseModelUri(model.uri);

      let defs: DefLocation[];
      try {
        defs = await memoizedDef({ repoId, name: word.word, file: path, line: position.lineNumber, rev });
      } catch (err) {
        // Network/server error is not a "no definition found" — but Monaco
        // has no distinct signal for the two, so log and degrade to "none".
        console.error('[ccd] /api/def failed', err);
        return null;
      }

      // Split as we go, by whether the selection under review changed the file a
      // definition lives in. Both halves are answered here rather than by the
      // resolver: which commits are being reviewed is not a fact about the
      // repository at a revision, and /api/def deliberately knows nothing of it.
      const inside: monaco.languages.Location[] = [];
      const outside: monaco.languages.Location[] = [];

      // All at once, not one per iteration. This await used to sit inside the
      // loop below, which made an ambiguous name cost one sequential round trip
      // per candidate *file* before the peek could render — 35 of them for
      // `render` on lets-plot. memoizedFile still collapses two locations in the
      // same file to a single fetch, and Promise.all preserves order.
      const sources = await Promise.all(defs.map((loc) => memoizedFile(repoId, rev, loc.path)));

      for (const [index, loc] of defs.entries()) {
        // Same repo as the model the click started in: a definition never
        // crosses repositories, so the id travels straight through.
        const uriStr = modelUri(repoId, rev, loc.path);
        // REQUIRED for cross-file peek (see file header, fact 2): build the
        // target model before returning, from the *same* memoized fetch a
        // second provideDefinition call for this click would reuse. Still built
        // inside the loop, in defs order — these models are what make cross-file
        // peek render at all.
        //
        // Same language as the model the click started in — a definition is
        // resolved within the language of the file it was asked from, so the
        // target's language is known without consulting the registry again.
        getOrCreateModel(uriStr, sources[index]!, model.getLanguageId());
        const location = {
          uri: monaco.Uri.parse(uriStr),
          range: new monaco.Range(loc.line, loc.column, loc.line, loc.column)
        };
        (inReview(loc.path) ? inside : outside).push(location);
      }

      // The URIs, not labels for them: how a candidate is named in the peek list
      // is that widget's business, and peekscope.ts is the only file that should
      // have to know it.
      applyPeekScope({ inReview: inside.map((l) => l.uri), outside: outside.map((l) => l.uri) });

      // In-review first, and a stable partition, so the resolver's same-file
      // hits stay ahead of its cross-file ones inside each half. This decides
      // the *jump* — `firstReference()`, goToCommands.js:143, which is what a
      // Ctrl+click inside the peek preview takes. It does NOT decide the peek's
      // own list or which candidate it opens on: the list is re-sorted by URI
      // (referencesModel.js:120) and the opening candidate is the one nearest
      // the clicked file by URI prefix (referencesController.js:152). Do not
      // "fix" the peek by reordering here — it has no effect at all.
      return [...inside, ...outside];
    }
  };

  // The same provider instance for every language: it reads what it needs from
  // the model it was handed, so there is nothing per-language to close over.
  for (const language of LANGUAGES) {
    monaco.languages.registerDefinitionProvider(language.id, provider);
  }

  // F12 / "go to definition" on a cross-file Location routes through here
  // instead of monaco's default no-op for resources other than the current
  // model. Routes through the app's debug/open hook (window.__ccd, see
  // main.ts) rather than talking to the band directly — that hook is the one
  // "take the reader to this file" entry point, which is what makes an F12 jump
  // and a sidebar click the same gesture.
  monaco.editor.registerEditorOpener({
    async openCodeEditor(_source, resource, selectionOrPosition) {
      const { path } = parseModelUri(resource);
      const ccd = window.__ccd;
      if (!ccd) return false;

      // Path and line together in one call, not a jump followed by a separate
      // reveal. Only the receiving end knows when the target's diff has been
      // computed and its collapsed regions expanded, and a reveal issued from
      // out here would be measuring a layout that is still about to move.
      const line = selectionOrPosition
        ? 'lineNumber' in selectionOrPosition
          ? selectionOrPosition.lineNumber
          : selectionOrPosition.startLineNumber
        : undefined;

      // Best-effort on the scroll: the jump itself is what this returns true
      // for, and a failure to centre a line is not a failure to get there.
      try {
        await ccd.openPath(path, line);
      } catch (err) {
        console.error('[ccd] editor opener: reveal failed', err);
      }

      return true;
    }
  });
}
