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
 * Both methods take the (repoRoot, revision) pair explicitly and an
 * implementation must not keep a "current" one. That is not stylistic: a
 * resolver that remembered the last revision answered two concurrent /api/def
 * calls from each other's index, and the observable result was a definition
 * reported in a file that does not exist at the revision asked about.
 *
 * An implementation may need construction work of its own — loading a grammar,
 * starting a language server — before either method can be called. That step
 * is deliberately NOT on this interface, because what it needs differs per
 * implementation (a WASM path and a query file for tree-sitter; a binary and a
 * workspace root for a language server) and putting one implementation's setup
 * here would make every other implementation satisfy it. server.ts performs it
 * once at boot, before it starts listening.
 */
export interface SymbolResolver {
  /**
   * Indexes `revision` of `repoRoot`, if it has not been indexed already.
   *
   * Idempotent per pair, and cheap on the second call — callers are expected to
   * await it before every `resolve` rather than track what has been built.
   */
  buildIndex(repoRoot: string, revision: string): Promise<void>;

  /**
   * Definitions matching `query` at that pair, best first: hits in
   * `query.file` rank ahead of hits elsewhere, stable within each group, so a
   * jump near a locally-shadowing definition finds the local one.
   *
   * An empty array means "no answer" and deliberately does NOT distinguish
   * between "no such symbol" and "that pair was never indexed" — callers cannot
   * tell the two apart and must not try to. Awaiting `buildIndex` for the same
   * pair first is what makes the distinction unnecessary.
   */
  resolve(repoRoot: string, revision: string, query: DefQuery): Promise<DefLocation[]>;
}
