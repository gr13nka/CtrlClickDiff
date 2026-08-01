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
  // TypeScript is the `grammar` field's reason for existing: `.ts` and `.tsx`
  // are one Monaco language (`id: 'typescript'`, so a Ctrl+click started in
  // either registers against the same provider and can find a definition in
  // the other — see TreeSitterResolver.resolve's `siblings`), but tsx.wasm is
  // a SEPARATE tree-sitter grammar from typescript.wasm because the plain
  // grammar cannot parse JSX. Both rows share
  // packages/backend/src/resolver/tags/typescript.scm (the declaration
  // shapes are identical — see that file's header for what that promise
  // actually costs: `.ts` gets `type_assertion`, `.tsx` gets the two `jsx_*`
  // node types, and the shared query only names what both grammars have).
  {
    id: 'typescript',
    extensions: ['.ts'],
    // 'import' — an import line only ever binds an alias ('import { x } from
    //   "y"', 'import x = require("y")'); nothing tags/typescript.scm
    //   captures can start a line with that keyword.
    // '//' / '*' — a comment line or block-comment continuation cannot hold
    //   a captured declaration, same argument as Kotlin's.
    // Deliberately NOT 'export': 'export function f() {}' and 'export const
    //   x = 1' both declare, and both are exactly what this file's
    //   variable-declarator patterns exist to capture — filtering the line
    //   out before parsing even looks at it would silently drop every
    //   exported top-level declaration, not just noise.
    nonDeclaringLinePrefixes: ['import', '//', '*'],
  },
  {
    id: 'typescript',
    extensions: ['.tsx'],
    grammar: 'tsx',
    // Element-wise identical to the '.ts' row above — TreeSitterResolver.init
    // boot-asserts every LANGUAGES group sharing an `id` agrees, because
    // resolve() applies the CLICKED entry's filter across every sibling's
    // candidates (see the comment on `siblings` there); a `.tsx`-started
    // click must filter `.ts` candidates by the same rule '.ts' would have
    // used, or the answer would depend on which file the gesture began in.
    nonDeclaringLinePrefixes: ['import', '//', '*'],
  },
  {
    id: 'javascript',
    // tree-sitter-javascript parses JSX natively — jsx_element/jsx_expression
    // are ordinary node types in the same grammar as everything else, not a
    // second grammar the way tree-sitter-typescript needs one wasm for `.ts`
    // and a second (`tsx`) for `.tsx` because the `.ts` grammar cannot parse
    // JSX at all. So `.jsx` costs one more extension on this one row and
    // nothing else — no second `grammar` key, no second tags file.
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    // Argued against resolver/tags/javascript.scm, which is the standard: a
    // line starting with this prefix cannot hold anything that file captures
    // (class_declaration, method_definition, function_declaration,
    // generator_function_declaration, or a top-level variable_declarator).
    //
    //  - 'import': binds a local name to something another module exports
    //    (import_statement/import_clause); it names an alias for a
    //    declaration, never is one — same argument as Kotlin's `import`.
    //  - '//': a line comment. Nothing tags.scm captures is expressible as
    //    text after `//` on the same line; the declaration would have to
    //    start the line, not follow a comment marker on it.
    //  - '*': a JSDoc/block-comment continuation or terminator line, same
    //    reasoning as Kotlin's `*` — a line *starting* with `*` cannot also
    //    open new code, only close or continue a `/* ... */` run.
    //
    // Deliberately NOT 'export': `export const foo = ...` and
    // `export function foo() {}` are exactly the top-level-declaration shapes
    // javascript.scm captures via its `export_statement` branches. Filtering
    // `export`-prefixed lines out of candidate discovery would silently drop
    // every exported top-level definition whose only declaring line starts
    // with the word `export` — this is the same class of mistake `package`
    // would be for Kotlin if `package` ever legally preceded a declaration
    // rather than only naming one.
    nonDeclaringLinePrefixes: ['import', '//', '*'],
  },
  {
    id: 'python',
    extensions: ['.py'],
    // `import`/`from` are keywords — a line beginning with either can only be
    // an import statement (`import os`) or an import-from (`from x import y
    // as z`); the latter binds a local alias, not a declaration, so it must
    // never be read as one. `#` opens a comment that runs to end of line, so
    // nothing after it can declare either. No `*` here (unlike Kotlin):
    // Python has no block-comment continuation convention — `#` is the only
    // comment syntax — so there is no second boilerplate shape to filter.
    nonDeclaringLinePrefixes: ['import', 'from', '#'],
  },
  {
    // Same shape as the kotlin row above, and the same admissibility
    // argument for every prefix: none of these can hold anything
    // tags/java.scm captures (class/record/enum/interface/annotation
    // declarations, methods, constructors, field declarators, enum
    // constants).
    id: 'java',
    extensions: ['.java'],
    nonDeclaringLinePrefixes: [
      // An `import` statement names a type to bring into scope; it cannot
      // itself be a class/interface/method/field/enum-constant declaration.
      'import',
      // A `package` statement names the enclosing package; same argument.
      'package',
      // A line-comment line's first token is the comment marker itself —
      // nothing after `//` is parsed as code.
      '//',
      // A Javadoc/block-comment continuation or terminator line starts with
      // `*` (not `/*`, for the same reason as Kotlin: a line that OPENS a
      // block comment can still close it and declare something on the same
      // line, e.g. `/* note */ class Foo {}`, so only the continuation form
      // is safe to exclude).
      '*',
    ],
  },
];

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
