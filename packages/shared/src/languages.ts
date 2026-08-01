// The language registry: which file extensions this tool reviews, and what
// each one is called.
//
// It exists to eliminate duplication, not to anticipate a future. Before it,
// the same fact was spelled out thirteen times across three packages and in
// four different *kinds* — `'.kt'` as a suffix test in git.ts, `'*.kt'` as a
// git pathspec, `'kotlin'` as a Monaco language id in three files, `'kotlin'`
// as an HTTP enum in the /api/def schema. Sites that agree only by convention
// and would fail **silently at runtime** if one drifted are the same hazard
// class as splitting modelUri/parseModelUri across two files.
//
// Deliberately ONE entry. Adding a language is a row here plus a grammar in
// the backend's grammars.ts; that is the seam, and shipping a second grammar is
// the trigger to revisit whatever this file assumes.
//
// Filesystem paths live in packages/backend/src/resolver/grammars.ts, keyed by
// the ids below, because this module is imported by the browser.

export interface Language {
  /**
   * Registry key — and Monaco's language id.
   *
   * The identity is the point, not a coincidence: it is what makes
   * `registerDefinitionProvider(lang.id)` and `createModel(src, lang.id, uri)`
   * the same string by construction rather than by two files agreeing. The
   * split this doc used to anticipate has now happened, but on the `grammar`
   * field below, not here: `id` stays fused to Monaco's language id because
   * that agreement-by-construction is the whole point of the field, and
   * splitting it would just move the two-files-must-agree hazard back in.
   * Two registry entries MAY now share an `id` — see `grammar`.
   */
  readonly id: string;
  /**
   * Key into the backend's grammar-asset table (`resolver/grammars.ts`),
   * defaulting to `id` when unset — use `grammarKeyFor`, never this field
   * directly, so that fallback lives in exactly one place.
   *
   * Exists because a Monaco language id and a tree-sitter grammar are not
   * always one-to-one: tree-sitter-typescript ships TWO grammars,
   * `typescript.wasm` and `tsx.wasm`, because the former cannot parse JSX —
   * but `.ts` and `.tsx` are both `id: 'typescript'` to Monaco. That needs two
   * LANGUAGES entries sharing an `id` with different `grammar` keys, not two
   * `id`s, or `registerDefinitionProvider`/`createModel` would stop agreeing.
   */
  readonly grammar?: string;
  /** Extensions this language claims, leading dot included, matched as a path suffix. */
  readonly extensions: readonly string[];
  /**
   * Line beginnings that can NEVER carry a declaration, matched after leading
   * whitespace. A prefix ending in a word character is additionally bounded by
   * `\b`, so `import` does not also match `imported`.
   *
   * Candidate discovery greps for an identifier and parses every file that
   * mentions it, so a name appearing in boilerplate at the top of every file
   * costs a whole-repo parse. Kotlin has TWO such kinds of boilerplate, and
   * both were measured on lets-plot (2646 .kt):
   *
   *  - the *package* line. `letsPlot` is a package segment, matched 2274 files,
   *    and a Ctrl+hover over any package line cost 6.7s.
   *  - the *license header comment*, which every file in that repo carries. Its
   *    words — Copyright, license, source, code, found, file, this, that —
   *    matched ~2571 files EACH and cost 9.4-15.0s per hover.
   *
   * With both excluded: Copyright and license go to 0 candidate files, `file`
   * to 23, `code` to 18. Real identifiers barely move (`render` 57 -> 51,
   * `apply` 348 -> 335, `size` 696 -> 662), which is the point — this removes
   * noise, not signal.
   *
   * These are filters, not heuristics, and the difference is the whole
   * justification: a declaration cannot appear on an `import` or `package`
   * line, nor on a line whose first non-space characters are `//` or `*`.
   * Verified rather than argued — across eleven identifiers, 15025 files were
   * dropped and every line mentioning the name in them was a comment, import or
   * package line, 0 exceptions. An extension function (`fun Foo.bar()`) is on a
   * `fun` line and survives; `import a.b.C as render` is an alias rather than a
   * declaration and is correctly dropped.
   *
   * `/*` is deliberately NOT in this list, only `*`. A line opening a block
   * comment can legally also close it and declare something
   * (`/* note *\/ fun foo()`), so excluding it would not be a filter any more.
   * A line *starting* with `*` is a comment continuation or terminator and
   * cannot be anything else.
   */
  readonly nonDeclaringLinePrefixes: readonly string[];
}

/** Every language this tool reviews. One entry, on purpose — see the file header. */
export const LANGUAGES: readonly Language[] = [
  {
    id: 'kotlin',
    extensions: ['.kt'],
    nonDeclaringLinePrefixes: ['import', 'package', '//', '*'],
  },
];

/** Every extension any registered language claims, in registry order. */
export const SOURCE_EXTENSIONS: readonly string[] = LANGUAGES.flatMap((lang) => lang.extensions);

/**
 * The language whose extension `path` ends with, or undefined for anything
 * else — a path no registered language claims is not an error, it is a file
 * this tool has nothing to say about.
 */
export function languageForPath(path: string): Language | undefined {
  return LANGUAGES.find((lang) => lang.extensions.some((ext) => path.endsWith(ext)));
}

/** Whether any registered language claims `path`. */
export function isSourcePath(path: string): boolean {
  return languageForPath(path) !== undefined;
}

/** The key `lang` loads its grammar under — `lang.grammar` if set, else `lang.id`. */
export function grammarKeyFor(lang: Language): string {
  return lang.grammar ?? lang.id;
}
