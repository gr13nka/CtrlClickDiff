; Deliberately captures only @name plus @definition.{class,function,constant} —
; no @reference.* captures (this resolver's boot validator, assertDefinitionKinds,
; rejects any capture kind it does not recognise; see TreeSitterResolver.ts).
;
; Classes and functions are unconditional: a bare `function_definition` pattern
; matches a `def` wherever one appears in the tree — a top-level function, a
; method inside a class, AND (verified by parsing a decorated sample against
; this grammar) the function_definition nested inside a `decorated_definition`
; node, since `@x.y` decoration wraps the def rather than replacing it. That is
; the wanted behaviour: a decorated function or a class method is still a
; definition a reader can Ctrl+click to.
;
; Assignments are the one deliberately narrow capture: only MODULE-LEVEL
; assignments are constants, matched via `(module (assignment ...))`. Upstream's
; own tags.scm anchors this through an `(expression_statement (assignment ...))`
; wrapper, but `expression_statement` is declared a `supertype` in grammar.js —
; supertype rules are elided from the concrete tree, so an assignment sits
; directly under `module`, never wrapped in one. Verified empirically against
; the built wasm: the `expression_statement`-wrapped pattern captured nothing at
; all on `MAX_SIZE = 100`, while anchoring straight to `module` captured it
; correctly — so the wrapper is dropped here rather than copied from upstream
; unverified. A function local (`local_var = x + 1` inside a `def`) sits under a
; `block`, not `module`, so the `module` anchor is what excludes it — that is
; noise (every local variable a function ever assigns), not signal, exactly as
; Kotlin excludes package/license lines rather than because it cannot be
; expressed. Confirmed the same way: anchoring to `module` finds only the
; top-level assignment; dropping the anchor entirely also matches the local.

(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(module
  (assignment
    left: (identifier) @name) @definition.constant)
