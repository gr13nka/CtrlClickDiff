// TreeSitterResolver — the SymbolResolver implementation backing Ctrl+click / F12.
//
// Deliberately dumb: exact identifier match only, no scope/import/overload
// analysis (that's the future LspResolver). resolve() ranks same-file hits
// first so a Ctrl+click near a locally-shadowing definition doesn't jump
// across the repo before showing the local one.
//
// The work is scoped to the question. `git grep` names the handful of files
// that mention the identifier at all, and only those are read and parsed. This
// replaced a whole-revision index that parsed every source file at the revision
// before it could answer anything: on lets-plot (2646 .kt, 9.6MB) that measured
// 11.5s and ~320MB of resident memory PER REVISION, against ~40ms for a typical
// identifier now. The index was never the answer to the question — it was the
// answer to every possible question, computed in case one was asked.
//
// resolve() is told which (repoRoot, revision) to answer against on every call —
// the resolver has no notion of a "current" revision, so two overlapping
// requests for different revisions cannot be served from each other's state.

import { readFile } from 'node:fs/promises';
import { Parser, Language, Query, type Node as TSNode, type QueryMatch } from 'web-tree-sitter';
import {
  LANGUAGES,
  languageForPath,
  grammarKeyFor,
  type DefKind,
  type DefLocation,
  type DefQuery,
  type SymbolResolver,
} from '@ctrlclickdiff/shared';
import { candidateFiles, showFile } from '../git';
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

/**
 * Every `definition.<kind>` capture a compiled tags query declares must have a
 * <kind> in DEF_KINDS — `toDefMatch` silently drops anything else, and an
 * empty `resolve()` answer is by contract indistinguishable from "no such
 * symbol" (see the doc on `resolve()`). Upstream tags.scm conventions use
 * kinds this resolver does not recognise (`definition.method`,
 * `definition.interface`, ...), so a hand-authored tags file for a new
 * language can name a capture that would vanish without a trace at the first
 * Ctrl+click that needed it. Calling this at boot turns that into a startup
 * failure instead, with the offending capture named.
 */
export function assertDefinitionKinds(query: Query, grammarKey: string): void {
  for (const name of query.captureNames) {
    if (!name.startsWith(DEFINITION_PREFIX)) continue;
    const suffix = name.slice(DEFINITION_PREFIX.length);
    if (!DEF_KINDS.has(suffix)) {
      throw new Error(
        `TreeSitterResolver.init: '${grammarKey}' tags query has capture '@${name}', ` +
          `whose kind '${suffix}' is not a recognised DefKind (${[...DEF_KINDS].join(', ')}). ` +
          `Rename the capture in the tags file to one of those, or add '${suffix}' to ` +
          `DEF_KINDS in TreeSitterResolver.ts if it names a genuinely new definition kind.`,
      );
    }
  }
}

interface DefMatch {
  name: string;
  location: DefLocation;
}

/** Every definition one file declares, by the name it declares. */
type FileSymbols = ReadonlyMap<string, DefLocation[]>;

/**
 * How many candidate blobs to read at once.
 *
 * 8, measured on lets-plot's worst identifier (`render`, 264 candidate files):
 * sequential 557ms, and concurrency 4/8/16/32/64 gives 267/260/267/267/274ms.
 * The reads plateau at 4 because libuv spawns processes on the loop thread, so
 * every execFile costs ~1ms of MAIN-THREAD work however many are in flight —
 * raising this does not buy the parallelism it looks like it should. 8 rather
 * than 4 because end-to-end, with reads interleaved against parses, it measured
 * 803ms against 1007ms. Do not "tune" this upwards; the number is a plateau.
 */
const CANDIDATE_READ_CONCURRENCY = 8;

/**
 * At most this many (repo, revision, path) symbol tables, least-recently-used
 * evicted first.
 *
 * Measured 6.2KB retained per entry on lets-plot, so 2000 is ~12MB. Both bounds
 * are load-bearing. It must clear the largest candidate set comfortably or a
 * single query evicts its own early files and thrashes — the worst measured is
 * 264, so this is 7.5x that. And it must be bounded at all: the old
 * whole-revision index measured ~320MB of RSS growth *per revision* with no cap,
 * so a ghost squash spanning ten revisions grew the process by ~3GB. This holds
 * ~12MB regardless of how many revisions a selection spans, which is the
 * property that matters.
 *
 * No TTL. (repoRoot, revision, path) names immutable content — the same reason
 * diff.ts never disposes a model. An entry cannot become wrong, only surplus.
 */
const FILE_SYMBOL_LIMIT = 2000;

/**
 * Cache key for `fileSymbols`. The repo root is part of the key because a
 * revision string is only unique *within* one repository — a branch name or an
 * abbreviated sha names different commits in different repos, so keying on the
 * revision alone would let one repo's symbols answer another repo's queries.
 * `repoRoot` is already a canonical absolute path, so it identifies the repo
 * without the resolver having to know how the HTTP layer names repositories.
 *
 * NUL is the separator because neither a filesystem path nor a git ref can
 * contain one, so the parts can never run together ambiguously.
 */
function symbolsKey(repoRoot: string, revision: string, path: string): string {
  return `${repoRoot}\u0000${revision}\u0000${path}`;
}

export class TreeSitterResolver implements SymbolResolver {
  /** Keyed by grammar key (`grammarKeyFor`), NOT `Language.id` — see init(). */
  private readonly grammars = new Map<string, LoadedGrammar>();

  /**
   * Parsed-file cache, LRU-bounded at FILE_SYMBOL_LIMIT.
   *
   * The value is a *promise*, not a resolved table, and that is what gives
   * in-flight coalescing for free: two concurrent resolves for different names
   * in the same file share one `git show` and one parse. It costs nothing extra
   * because the promise is infallible by construction — showFile swallows
   * non-zero exits and returns '', and a null parse yields an empty map — so
   * there is no rejected-entry to evict specially.
   */
  private readonly fileSymbols = new Map<string, Promise<FileSymbols>>();

  /**
   * `Parser.init()`, then one `Language.load` + `new Query` per registered
   * grammar KEY (`grammarKeyFor`, not `Language.id` — several LANGUAGES entries
   * can share an id with different grammars, e.g. `.ts`/`.tsx` both Monaco
   * `typescript`). Must be awaited once at boot before resolve is usable.
   *
   * Every grammar key LANGUAGES names must have assets here, and a missing one
   * throws at boot rather than later: without a grammar, resolve() answers
   * `[]`, and an empty answer is indistinguishable from "no such symbol" by
   * contract — so a misconfiguration would surface as a feature that silently
   * does nothing.
   */
  async init(assets: Readonly<Record<string, GrammarAssets>>): Promise<void> {
    const runtimeWasm = treeSitterRuntimeWasm();
    await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

    for (const language of LANGUAGES) {
      const key = grammarKeyFor(language);
      // Two LANGUAGES entries can name the same grammar key on purpose (two
      // `.ts`-like ids sharing one grammar) — load it once, not once per entry.
      if (this.grammars.has(key)) continue;

      const grammar = assets[key];
      if (!grammar) {
        throw new Error(`TreeSitterResolver.init: no grammar assets registered for '${key}'`);
      }

      const lang = await Language.load(grammar.wasmPath);
      if (!lang) {
        throw new Error(
          `TreeSitterResolver.init: ${key} WASM failed to load from ${grammar.wasmPath} ` +
            '(likely an ABI mismatch — rebuild with tree-sitter-cli ^0.26)',
        );
      }

      const parser = new Parser();
      parser.setLanguage(lang);

      const tagsSource = await readFile(grammar.tagsScmPath, 'utf8');
      let query: Query;
      try {
        query = new Query(lang, tagsSource);
      } catch (err) {
        throw new Error(
          `TreeSitterResolver.init: '${key}' tags query at ${grammar.tagsScmPath} ` +
            `failed to compile: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      assertDefinitionKinds(query, key);

      this.grammars.set(key, { parser, query });
    }
  }

  /**
   * Exact identifier match at (`repoRoot`, `revision`). Empty array = no
   * answer, which by contract does not distinguish "no such symbol" from
   * "nothing here could have answered".
   *
   * The language comes from `query.file`'s extension — a definition is resolved
   * within the language of the file it was asked from. A path no registered
   * language claims answers empty rather than guessing. That is unreachable
   * today, since the provider is only registered for LANGUAGES ids, but it is
   * a real branch and would otherwise read as a bug.
   */
  async resolve(repoRoot: string, revision: string, query: DefQuery): Promise<DefLocation[]> {
    const startedAt = performance.now();
    const language = languageForPath(query.file);
    const grammar = language && this.grammars.get(grammarKeyFor(language));
    if (!language || !grammar) return [];

    const candidates = await candidateFiles(
      repoRoot, revision, query.name, language.extensions, language.nonDeclaringLinePrefixes,
    );
    const grepMs = performance.now() - startedAt;
    // How many of the candidates still have to be read and parsed. Counted
    // before the pool runs, because symbolsFor moves entries around as it goes.
    const cached = candidates.reduce(
      (n, path) => n + (this.fileSymbols.has(symbolsKey(repoRoot, revision, path)) ? 1 : 0),
      0,
    );

    // Partitioned BEFORE the reads, not after. The read pool finishes out of
    // order, so ordering the *results* would make the answer depend on
    // scheduling. filter() preserves order, so this is a stable partition of an
    // already-sorted list rather than a re-sort — same-file hits first, so a
    // Ctrl+click near a locally-shadowing definition finds the local one.
    const ordered = [
      ...candidates.filter((path) => path === query.file),
      ...candidates.filter((path) => path !== query.file),
    ];

    // Read and parse INTERLEAVED, one file at a time per worker. The tempting
    // tidy-up — await every read, then parse them all in a loop — is a single
    // 313ms synchronous block on this repo's worst identifier, because parsing
    // is synchronous WASM on the event loop. The await on each subprocess is
    // the only thing yielding it; measured max loop lag as written is 27ms.
    const perFile = await mapWithLimit(ordered, CANDIDATE_READ_CONCURRENCY, async (path) => {
      const symbols = await this.symbolsFor(repoRoot, revision, path, grammar);
      return symbols.get(query.name) ?? [];
    });

    const hits = perFile.flat();

    // One line per resolve, with the split that says WHICH half is slow. `grep`
    // is candidate discovery, `parse` is read+parse of the ones not already
    // cached — and on a blobless clone `grep` is also where a lazy blob fetch
    // would land, so a grep time far above the usual ~30ms means the network,
    // not this code. Logged unconditionally because the question it answers
    // ("why was that click slow?") is only ever asked after the fact.
    const totalMs = performance.now() - startedAt;
    console.log(
      `[resolver] ${query.name} in ${totalMs.toFixed(0)}ms ` +
        `(grep ${grepMs.toFixed(0)}ms -> ${candidates.length} candidates, ` +
        `${cached} cached, parse ${(totalMs - grepMs).toFixed(0)}ms) -> ${hits.length} hits`,
    );

    return hits;
  }

  /** Cached `readSymbols`, moving the entry to the end of the LRU on every hit. */
  private symbolsFor(
    repoRoot: string,
    revision: string,
    path: string,
    grammar: LoadedGrammar,
  ): Promise<FileSymbols> {
    const key = symbolsKey(repoRoot, revision, path);

    const cached = this.fileSymbols.get(key);
    if (cached) {
      // Map iterates in insertion order, so delete+set is the whole LRU.
      this.fileSymbols.delete(key);
      this.fileSymbols.set(key, cached);
      return cached;
    }

    const pending = readSymbols(repoRoot, revision, path, grammar);
    this.fileSymbols.set(key, pending);

    // Evicting an in-flight entry is safe: whoever awaited it holds the promise,
    // and the only cost is that a later query re-reads that file.
    while (this.fileSymbols.size > FILE_SYMBOL_LIMIT) {
      const oldest = this.fileSymbols.keys().next().value;
      if (oldest === undefined) break;
      this.fileSymbols.delete(oldest);
    }

    return pending;
  }
}

/**
 * Every definition declared in one file at one revision.
 *
 * The tree is deleted in a `finally`. web-tree-sitter trees are WASM pointers
 * and are NOT garbage collected — the whole-revision index this replaced leaked
 * one per file per revision, which is most of why it cost ~320MB a revision.
 */
async function readSymbols(
  repoRoot: string,
  revision: string,
  path: string,
  grammar: LoadedGrammar,
): Promise<FileSymbols> {
  const symbols = new Map<string, DefLocation[]>();

  const source = await showFile(repoRoot, revision, path);
  if (!source) return symbols; // absent or empty at this rev

  const tree = grammar.parser.parse(source);
  if (!tree) return symbols;

  try {
    for (const match of grammar.query.matches(tree.rootNode)) {
      const def = toDefMatch(match, path);
      if (!def) continue;
      const existing = symbols.get(def.name);
      if (existing) existing.push(def.location);
      else symbols.set(def.name, [def.location]);
    }
  } finally {
    tree.delete();
  }

  return symbols;
}

/**
 * `work` over `items` with at most `limit` in flight, results in INPUT order.
 *
 * Module-private with one caller, and it must stay that way: promoting this to
 * a shared util would invite callers whose ordering and failure needs differ,
 * which is the argument storage.ts already makes for refusing readJson<T>.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  // Each worker pulls the next index and runs it to completion before taking
  // another, so a slow file delays only its own worker.
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A tags.scm match pairs a `@name` capture (the identifier node — used for
 * the jump target) with a `@definition.<kind>` capture (the enclosing
 * declaration node — used only to classify `kind`). Matches lacking either
 * (e.g. the `@reference.*` patterns, which exist for future use, not
 * definitions) are not definitions and are skipped.
 *
 * Everything this returns is COPIED out of the tree — `nameNode.text` and
 * `startPosition` are read here, not stored. Nodes, matches and captures all
 * hold into the tree's WASM arena, so anything derived from them dies with the
 * `tree.delete()` in readSymbols. The natural refactor (return the QueryMatch
 * and classify it later) is a use-after-free that typechecks perfectly.
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
