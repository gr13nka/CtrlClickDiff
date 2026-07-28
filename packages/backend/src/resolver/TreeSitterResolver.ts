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

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { Parser, Language, Query, type Node as TSNode, type QueryMatch } from 'web-tree-sitter';
import type { DefKind, DefLocation, DefQuery, SymbolResolver } from '@ctrlclickdiff/shared';
import { showFile, listKtFilesAtRev } from '../git';

const require = createRequire(import.meta.url);

/**
 * Resolve the on-disk path to web-tree-sitter's own runtime WASM
 * (`tree-sitter.wasm` — the generic engine, distinct from the Kotlin
 * grammar). Copied verbatim from smoke.ts: under plain Node/tsx (no
 * bundler), `Parser.init()`'s default `locateFile` heuristics don't
 * reliably find this relative to cwd, so we resolve it explicitly via
 * Node's module resolver and hand it back through an explicit `locateFile`
 * override. Falls back gracefully to Parser.init()'s own default behavior
 * if resolution fails.
 */
function resolveTreeSitterRuntimeWasm(): string | undefined {
  try {
    return require.resolve('web-tree-sitter/tree-sitter.wasm');
  } catch {
    try {
      const pkgEntry = require.resolve('web-tree-sitter');
      const candidate = resolvePath(dirname(pkgEntry), 'tree-sitter.wasm');
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
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
type Index = Map<string, DefLocation[]>;

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
  private parser: Parser | undefined;
  private query: Query | undefined;
  private readonly indexByRepoRevision = new Map<string, Index>();

  /**
   * `Parser.init()` -> `Language.load(wasmPath)` -> `new Query(lang, tagsScmSource)`.
   * Must be awaited once at boot before buildIndex/resolve are usable.
   */
  async init(wasmPath: string, tagsScmSource: string): Promise<void> {
    const runtimeWasm = resolveTreeSitterRuntimeWasm();
    await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

    const lang = await Language.load(wasmPath);
    if (!lang) {
      throw new Error(
        `TreeSitterResolver.init: Kotlin WASM failed to load from ${wasmPath} ` +
          '(likely an ABI mismatch — rebuild with tree-sitter-cli ^0.26)',
      );
    }

    const parser = new Parser();
    parser.setLanguage(lang);

    this.parser = parser;
    this.query = new Query(lang, tagsScmSource);
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
    if (!this.parser || !this.query) {
      throw new Error('TreeSitterResolver.buildIndex: called before init()');
    }
    const parser = this.parser;
    const query = this.query;

    const paths = await listKtFilesAtRev(repoRoot, revision);
    const index: Index = new Map();

    for (const path of paths) {
      const source = await showFile(repoRoot, revision, path);
      if (!source) continue; // deleted/empty at this rev

      const tree = parser.parse(source);
      if (!tree) continue;

      for (const match of query.matches(tree.rootNode)) {
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
