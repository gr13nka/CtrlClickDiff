// The symbol-resolution contract: what Ctrl+click and F12 ask for, and what an
// implementation owes back. TreeSitterResolver is the only implementation today
// and a language-server-backed one is the anticipated second, so what is written
// here is what that second implementer gets to code against — everything below
// is a rule of the interface, not an accident of the current one.

export type DefKind = 'class' | 'function' | 'constant' | 'type';

/** One "where is this defined?" question, as asked from a spot in a file. */
export interface DefQuery {
  /** The identifier under the cursor, matched exactly. */
  name: string;
  /**
   * Repo-relative path the query was asked from — see `resolve`'s ranking rule.
   *
   * This also decides the language: **a definition is resolved within the
   * language of the file you clicked in.** There used to be a `lang: 'kotlin'`
   * field beside this one, carried by every layer and read by nothing. Deriving
   * it is strictly better than declaring it, because a declared language can
   * disagree with the file it names, and a field that can be derived is a field
   * to delete rather than to widen.
   */
  file: string;
  /**
   * 1-based line the query was asked from.
   *
   * Carried for a resolver that can use it and ignored by the current one:
   * TreeSitterResolver matches on `name` alone, so nothing today narrows by
   * position. A scope-aware implementation is expected to.
   */
  line: number;
}

/** Where a definition lives, in the coordinates an editor can jump to. */
export interface DefLocation {
  /** Repo-relative path, at the revision the query named. */
  path: string;
  /** 1-based, like `DefQuery.line` — these go straight into a Monaco position. */
  line: number;
  /** 1-based column of the identifier itself, not of its declaration. */
  column: number;
  kind: DefKind;
}

/**
 * Resolves identifiers to their definitions at one revision of one repository.
 *
 * ONE method, and that is this contract's main claim: asking is the whole
 * interface. There used to be a `buildIndex(repoRoot, revision)` beside
 * `resolve`, whose only documented rule was that callers await it first — a
 * step that existed to be awaited. It was there because the tree-sitter
 * implementation could not answer without first parsing every file at the
 * revision, and that is a fact about that implementation, not about the
 * question. It cost a 2646-file repository 11.5s and ~320MB per revision to
 * answer about one identifier. An implementation that needs preparatory work
 * now does it inside `resolve`, at the scale the query actually needs.
 *
 * `resolve` takes the (repoRoot, revision) pair explicitly and an
 * implementation must not keep a "current" one. That is not stylistic: a
 * resolver that remembered the last revision answered two concurrent /api/def
 * calls from each other's index, and the observable result was a definition
 * reported in a file that does not exist at the revision asked about.
 *
 * An implementation may still need construction work of its own — loading a
 * grammar, starting a language server — before `resolve` can be called. That
 * step is deliberately NOT on this interface, because what it needs differs per
 * implementation (grammar WASM plus a tags query for tree-sitter; a binary and
 * a workspace root for a language server) and putting one implementation's
 * setup here would make every other implementation satisfy it. server.ts
 * performs it once at boot, before it starts listening.
 */
export interface SymbolResolver {
  /**
   * Definitions matching `query` at that pair, best first: hits in
   * `query.file` rank ahead of hits elsewhere, and the rest are in a fixed
   * order that does not depend on scheduling — so a jump near a locally-
   * shadowing definition finds the local one.
   *
   * The language is taken from `query.file`; see that field. A path no
   * registered language claims answers empty rather than guessing.
   *
   * An empty array means "no answer" and deliberately does NOT distinguish
   * between "no such symbol" and "nothing here could have answered" — callers
   * cannot tell the two apart and must not try to.
   */
  resolve(repoRoot: string, revision: string, query: DefQuery): Promise<DefLocation[]>;
}
