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
  {
    id: 'go',
    extensions: ['.go'],
    // Argued against tags/go.scm's own capture set (function_declaration,
    // method_declaration, type_spec, const_spec, var_spec — see that file):
    //  - 'import': an import line names a package path, never a declaration;
    //    same reasoning as Kotlin's package-segment case, and Go's import
    //    grammar cannot embed one (`import "fmt"` / `import ( ... )`).
    //  - 'package': the package clause is exactly one line per file and
    //    grammatically cannot carry a func/type/const/var alongside it.
    //  - '//': a line comment. Nothing tags/go.scm captures can start after
    //    `//` on the same line and still be `//`-prefixed at the line start.
    //  - '*': either a `/* ... */` block-comment continuation/terminator, or
    //    a pointer-dereference STATEMENT (`*p = v`) — an assignment, not a
    //    declaration. Every node tags/go.scm captures begins its line with
    //    `func`, `type`, `const`, or `var`, so a `*`-first line cannot hold
    //    one. (`/*` itself is deliberately excluded, same as Kotlin: a block
    //    comment can open and close on one line and still declare something
    //    after it, e.g. `/* note */ func Foo() {}` — confirmed against this
    //    grammar, which parses that as a `comment` node followed by a
    //    `function_declaration` on the same row.)
    nonDeclaringLinePrefixes: ['import', 'package', '//', '*'],
  },
  /**
   * Rust. Each nonDeclaringLinePrefixes entry argued against THIS language's
   * own tags file, `resolver/tags/rust.scm` — the standard from the interface
   * doc above: a line starting with the prefix cannot hold anything that file
   * captures (function_item, function_signature_item, struct_item, enum_item,
   * union_item, trait_item, type_item, const_item, static_item,
   * macro_definition).
   *
   *  - `use`  binds a path or alias (`use a::B as C;`) and never itself opens
   *    one of the captured item kinds — none of them can begin with `use`.
   *  - `//`   a line comment, which also covers `///` and `//!` doc comments —
   *    everything after `//` on that line is text, not code.
   *  - `*`    a block-comment continuation or terminator line (the kind
   *    `/* ... *\/` spans across) — it cannot itself open a declaration.
   *
   * Two prefixes that look tempting and are deliberately EXCLUDED, unlike
   * Kotlin's `import`/`package`:
   *  - `#`   would drop real declarations. `#[inline] fn foo() {}` is one
   *    legal line: the attribute and a captured function_item share it, so
   *    excluding `#` would filter out an actual definition, not noise.
   *  - `mod` would too. `mod m { fn f() {} }` opens an inline module and
   *    declares a captured function_item on the very same line.
   */
  {
    id: 'rust',
    extensions: ['.rs'],
    nonDeclaringLinePrefixes: ['use', '//', '*'],
  },
  {
    // '.c' ONLY — '.h' deliberately belongs to a future 'cpp' entry, not this
    // one, because tree-sitter-cpp parses C headers acceptably and a header
    // is more often included from C++ than from plain C. Accepted
    // limitation, not a bug: until that entry exists, a Ctrl+click in a .c
    // file on a macro or typedef declared in a .h cannot find it, because
    // `languageForPath('foo.h')` answers undefined rather than 'c' — the
    // header is outside every registered extension list, so it is not a
    // candidate file `git grep` would even be asked to search. This is a
    // scoping-rule decision to revisit on real evidence (a 'cpp' entry
    // landing, or a concrete case where it costs a reader something), not
    // a defect in this row.
    id: 'c',
    extensions: ['.c'],
    // Same shape as the kotlin/java rows above: every prefix here is argued
    // against tags/c.scm's OWN captures (struct/union-with-body, enum-with-
    // body, typedef, #define, #define(args), function declarators,
    // enumerators) — the standard is that a line starting with the prefix
    // cannot hold anything that file captures.
    nonDeclaringLinePrefixes: [
      // `#include <stdio.h>` / `#include "x.h"` brings a header's contents
      // into scope; the tree-sitter node is `preproc_include`, which
      // tags/c.scm does not capture anything from. Deliberately NOT bare
      // `#`: `#define MAX 10` and `#define SQUARE(x) ...` both start with
      // `#` too, and both DO declare something tags/c.scm captures
      // (preproc_def / preproc_function_def) — excluding all preprocessor
      // lines would silently hide every macro definition. '#include' ends
      // in a word character ('e'), so the `\b` this module's prefix
      // matching appends still requires a boundary after it — `#include`
      // followed by whitespace or `<`/`"` matches, `#includeFoo` (not real
      // C, but the boundary is what makes the rule correct in general)
      // would not.
      '#include',
      // A line-comment line's first token is the comment marker itself —
      // nothing after `//` is parsed as code.
      '//',
      // A block-comment continuation or terminator line starts with `*`
      // (not `/*`, for the same reason as Kotlin and Java: a line that
      // OPENS a block comment can still close it and declare something on
      // the same line, e.g. `/* note */ struct Point { int x; };`, so only
      // the continuation form is safe to exclude).
      '*',
    ],
  },
  {
    id: 'cpp',
    // '.h' is claimed here, not by a separate C entry: most real-world .h
    // files in mixed repos are C++-flavored (guards, extern "C", classes
    // forward-declared alongside C structs), and the cpp grammar parses a
    // plain C header acceptably. Registry order between a future c entry and
    // this one would not matter today even if both wanted '.h' -- extension
    // matching is a linear find(), so whichever entry the resolver has yet
    // to see loses -- but nothing else in this repo currently claims it, so
    // there is nothing to order against.
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'],
    // Each entry's one-line admissibility argument, made against
    // tags/cpp.scm specifically (a line starting with this prefix CANNOT
    // hold anything that file captures):
    //  - '#include' names a path, never an identifier tags/cpp.scm captures.
    //  - '//' opens a line comment; nothing after it on the same line is code.
    //  - '*' is a block-comment continuation/terminator line and cannot be
    //    anything else -- same argument as Kotlin's above, and for the same
    //    reason '/*' is deliberately NOT in this list: a line that opens a
    //    block comment can still close it and declare something
    //    (`/* note */ struct Foo {`).
    //
    // Two prefixes a C/C++ reader might expect here and deliberately are
    // NOT, because both CAN hold something tags/cpp.scm captures:
    //  - bare '#': `#define FOO 100` / `#define SQUARE(x) ((x)*(x))` IS a
    //    declaration -- captured as preproc_def / preproc_function_def --
    //    so excluding every '#' line would silently drop every macro.
    //  - 'using': `using Alias = T;` is a captured alias_declaration
    //    (@definition.type), unlike Kotlin's `import`, which can never
    //    itself be a declaration. Excluding it would hide every type alias.
    nonDeclaringLinePrefixes: ['#include', '//', '*'],
  },
  {
    // Registry key AND Monaco's language id, per the field doc above. The
    // grammar asset key (resolver/grammars.ts) is also 'csharp' — Monaco's
    // own id — even though the upstream grammar repo and its own generated
    // artifact call themselves `c_sharp`; vendor/build-grammars.sh's copy
    // step is what normalises `out.wasm` to vendor/tree-sitter-csharp.wasm,
    // so nothing downstream of this file ever sees the underscore spelling.
    id: 'csharp',
    extensions: ['.cs'],
    nonDeclaringLinePrefixes: [
      // TRADE, not an obvious filter like Kotlin's `import`/`package`: a
      // `using System;` directive-line is the top-of-file boilerplate this
      // filter exists for, and is the common case. But `using Foo = Bar;`
      // declares a type alias and `using var f = ...;` declares a local —
      // both are real declarations a `using` line CAN carry in C#. Excluding
      // the prefix is sound here only because tags/csharp.scm captures
      // neither: there is no alias-declaration or local-variable pattern
      // above, so no capture this file produces can ever sit on a `using`
      // line. The day someone adds using-alias (or using-local) capture to
      // tags/csharp.scm, this prefix must go — it would then silently hide
      // real declarations, the same hazard the license-header case
      // demonstrated for a filter that stopped being a filter.
      'using',
      // A line-comment line's first token is the comment marker itself —
      // nothing after `//` is parsed as code, so no capture in
      // tags/csharp.scm can start there.
      '//',
      // A block-comment continuation or terminator line starts with `*`
      // (not `/*`, for the same reason as Kotlin: a line that OPENS a block
      // comment can still close it and declare something on the same line,
      // e.g. `/* note */ class Foo {}`, so only the continuation form is
      // safe to exclude).
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
