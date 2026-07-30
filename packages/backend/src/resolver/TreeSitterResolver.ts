// TreeSitterResolver — Milestone 3 "brain": the SymbolResolver implementation
// backing Ctrl+click / F12. See peekdiff-mvp-iterative-wind.md,
// "Milestone 3 — Tree-sitter brain".
//
// Deliberately dumb: exact identifier match only, no scope/import/overload
// analysis (that's the future LspResolver). resolve() ranks same-file hits
// first so a Ctrl+click near a locally-shadowing definition doesn't jump
// across the repo before showing the local one.
//
// Indexing is per (repo, revision) and cached: buildIndex(repoRoot, rev) is a
// no-op if that pair was already indexed, so switching files in the M4 shell
// never re-parses the tree. resolve() is told which (repoRoot, rev) to answer
// against on every call — the resolver has no notion of a "current" revision,
// so two overlapping requests for different revisions cannot be served from
// each other's index.

import { readFile } from 'node:fs/promises';
import { Parser, Language, Query, type Node as TSNode, type QueryMatch } from 'web-tree-sitter';
import {
  LANGUAGES,
  languageForPath,
  type DefKind,
  type DefLocation,
  type DefQuery,
  type SymbolResolver,
} from '@ctrlclickdiff/shared';
import { showFile, listKtFilesAtRev } from '../git';
import { treeSitterRuntimeWasm, type GrammarAssets } from './grammars';

/** One language's loaded tree-sitter pair. Both are process-lifetime. */
interface LoadedGrammar {
  readonly parser: Parser;
  readonly query: Query;
}

/** tags.scm marks definitions with captures named `definition.<kind>` — the
 * suffix after this prefix *is* the DefKind (see tags.scm + shared/types.ts). */
const DEFINITION_PREFIX = 'definition.';
const DEF_KINDS: ReadonlySet<string> = new Set<DefKind>(['class', 'function', 'constant', 'type']);

interface DefMatch {
  name: string;
  location: DefLocation;
}

/** One (repo, revision)'s symbol table: definition name -> every location it's declared at. */
type SymbolIndex = Map<string, DefLocation[]>;

/**
 * Cache key for `indexByRepoRevision`. The repo root is part of the key
 * because a revision string is only unique *within* one repository — a branch
 * name or an abbreviated sha names different commits in different repos, so
 * keying on the revision alone would let one repo's index answer another
 * repo's queries. `repoRoot` is already a canonical absolute path, so it
 * identifies the repo without the resolver having to know how the HTTP layer
 * names repositories.
 *
 * NUL is the separator because neither a filesystem path nor a git ref can
 * contain one, so the two halves can never run together ambiguously.
 */
function indexKey(repoRoot: string, revision: string): string {
  return `${repoRoot}\u0000${revision}`;
}

export class TreeSitterResolver implements SymbolResolver {
  private readonly grammars = new Map<string, LoadedGrammar>();
  private readonly indexByRepoRevision = new Map<string, SymbolIndex>();

  /**
   * `Parser.init()`, then one `Language.load` + `new Query` per registered
   * language. Must be awaited once at boot before resolve is usable.
   *
   * Every id in LANGUAGES must have assets here, and a missing one throws at
   * boot rather than later: without a grammar, resolve() answers `[]`, and an
   * empty answer is indistinguishable from "no such symbol" by contract — so a
   * misconfiguration would surface as a feature that silently does nothing.
   */
  async init(assets: Readonly<Record<string, GrammarAssets>>): Promise<void> {
    const runtimeWasm = treeSitterRuntimeWasm();
    await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

    for (const language of LANGUAGES) {
      const grammar = assets[language.id];
      if (!grammar) {
        throw new Error(`TreeSitterResolver.init: no grammar assets registered for '${language.id}'`);
      }

      const lang = await Language.load(grammar.wasmPath);
      if (!lang) {
        throw new Error(
          `TreeSitterResolver.init: ${language.id} WASM failed to load from ${grammar.wasmPath} ` +
            '(likely an ABI mismatch — rebuild with tree-sitter-cli ^0.26)',
        );
      }

      const parser = new Parser();
      parser.setLanguage(lang);

      this.grammars.set(language.id, {
        parser,
        query: new Query(lang, await readFile(grammar.tagsScmPath, 'utf8')),
      });
    }
  }

  /**
   * List `.kt` files at `revision` (git ls-tree), `git show` + parse + query
   * each, and build `Map<name, DefLocation[]>`. No-op if this
   * (repoRoot, revision) pair is already cached — the built index stays put
   * and later resolve() calls name the pair they want, so there is nothing to
   * switch over.
   */
  async buildIndex(repoRoot: string, revision: string): Promise<void> {
    const key = indexKey(repoRoot, revision);
    if (this.indexByRepoRevision.has(key)) return;

    const paths = await listKtFilesAtRev(repoRoot, revision);
    const index: SymbolIndex = new Map();

    for (const path of paths) {
      const language = languageForPath(path);
      const grammar = language && this.grammars.get(language.id);
      if (!grammar) continue;

      const source = await showFile(repoRoot, revision, path);
      if (!source) continue; // deleted/empty at this rev

      const tree = grammar.parser.parse(source);
      if (!tree) continue;

      for (const match of grammar.query.matches(tree.rootNode)) {
        const def = toDefMatch(match, path);
        if (!def) continue;
        const existing = index.get(def.name);
        if (existing) existing.push(def.location);
        else index.set(def.name, [def.location]);
      }
    }

    this.indexByRepoRevision.set(key, index);
    console.log(`[resolver] indexed ${revision} (${this.indexedCount(repoRoot, revision)} symbols)`);
  }

  /**
   * Exact identifier match against `revision`'s index in `repoRoot`. Empty
   * array = not found (no such symbol, or that pair was never indexed).
   * Multiple hits are ranked same-file (`query.file`) first, then
   * cross-file — stable within each group.
   *
   * The pair to answer against is passed in rather than held as resolver
   * state: a caller's `await buildIndex(...)` and its `resolve(...)` are two
   * separate turns of the event loop, and anything remembered in between
   * could have been overwritten by another in-flight request.
   */
  async resolve(repoRoot: string, revision: string, query: DefQuery): Promise<DefLocation[]> {
    const index = this.indexByRepoRevision.get(indexKey(repoRoot, revision));
    if (!index) return [];

    const locs = index.get(query.name);
    if (!locs || locs.length === 0) return [];

    // filter() preserves insertion order, so concatenating same-file first
    // then cross-file is a stable partition, not a re-sort.
    const sameFile = locs.filter((l) => l.path === query.file);
    const crossFile = locs.filter((l) => l.path !== query.file);
    return [...sameFile, ...crossFile];
  }

  /**
   * Total DefLocation count indexed for `revision` in `repoRoot` (0 if never
   * built) — not part of SymbolResolver; used by POST /api/index's
   * `{ ok, count }` prewarm response (M4).
   */
  indexedCount(repoRoot: string, revision: string): number {
    const index = this.indexByRepoRevision.get(indexKey(repoRoot, revision));
    if (!index) return 0;
    let count = 0;
    for (const locs of index.values()) count += locs.length;
    return count;
  }
}

/**
 * A tags.scm match pairs a `@name` capture (the identifier node — used for
 * the jump target) with a `@definition.<kind>` capture (the enclosing
 * declaration node — used only to classify `kind`). Matches lacking either
 * (e.g. the `@reference.*` patterns, which exist for future use, not
 * definitions) are not definitions and are skipped.
 */
function toDefMatch(match: QueryMatch, path: string): DefMatch | undefined {
  let nameNode: TSNode | undefined;
  let kind: DefKind | undefined;

  for (const capture of match.captures) {
    if (capture.name === 'name') {
      nameNode = capture.node;
    } else if (capture.name.startsWith(DEFINITION_PREFIX)) {
      const suffix = capture.name.slice(DEFINITION_PREFIX.length);
      if (DEF_KINDS.has(suffix)) kind = suffix as DefKind;
    }
  }

  if (!nameNode || !kind) return undefined;

  return {
    name: nameNode.text,
    location: {
      path,
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column + 1,
      kind,
    },
  };
}
