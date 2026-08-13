; TypeScript declarations. Shared between the plain `typescript` grammar key
; and `tsx` (see resolver/grammars.ts's tsx row and vendor/README.md) -- the
; declaration node shapes below are identical in both generated grammars,
; JSX support being additive to the expression grammar, not a reshaping of
; the declaration grammar. Compiling this one file against both wasms at
; boot (TreeSitterResolver.init, once per grammar key) is itself the drift
; detector: if that ever stops being true, one of the two Query constructions
; fails at boot rather than one of the two silently stopping to capture.
;
; Captured: class / abstract-class declarations; function and generator
; declarations; named methods (`name: (property_identifier)` excludes
; computed/string/number-keyed members, which are not declarations tags.scm
; can name usefully); TOP-LEVEL (module-scope) const/let/var, split by
; initializer into @definition.function (arrow/function-expression) or
; @definition.constant (everything else); and interface / type-alias / enum
; declarations. Kinds are normalised to the four this resolver recognises
; (definition.class/function/constant/type) -- boot's assertDefinitionKinds
; rejects anything else, which is why there is no definition.method or
; definition.interface here even though those are the more obvious names.
;
; Deliberately NOT filtered by nonDeclaringLinePrefixes: `export`. Unlike
; `import` (which only ever binds an alias, never declares), a line starting
; with `export` routinely declares -- `export function f() {}`, `export
; const x = 1` -- so excluding it would drop real declarations from every
; grep, not just noise.
;
; Deliberately NOT captured: local (function-body) const/let/var. Noise, not
; signal, same argument nonDeclaringLinePrefixes makes for import/package
; lines -- and enforced structurally, not by convention: every
; variable_declarator pattern below is anchored under `program` directly, or
; under `program -> export_statement`, either of which a declaration inside a
; function body can never be. No @reference.* captures either, for the same
; reason tags/kotlin.scm's header gives: this file only names definitions.
;
; The function/constant split for variable_declarator is the one nonobvious
; part of this file. tree-sitter's query language has no "match A, otherwise
; match B" operator -- verified empirically while authoring this file: an
; unconditional `(variable_declarator name: (identifier) @name)
; @definition.constant` pattern alongside a function-specific one made
; `query.matches()` return BOTH patterns for `const Foo = () => {}` (one
; `@definition.function`, one `@definition.constant`, same @name/position) --
; two DefLocation entries at the identical spot, which Ctrl+click would show
; as two rows for one definition. So "otherwise" below is written out as an
; explicit list of every OTHER concrete member of the grammar's `expression`
; supertype, checked against the pinned commit's
; typescript/src/node-types.json: `expression` has 15 members, one of which
; (`primary_expression`) is itself a supertype of 23 more, for 37 concrete
; leaf types total; minus arrow_function and function_expression is 35. A
; variable_declarator with no initializer (`let x: number;`) matches neither
; list and is not captured -- "otherwise" here means "has some other value",
; not "or nothing at all".
;
; The list below is 34, not 35: `type_assertion` (`<Type>expr`) is dropped
; because this file is compiled against BOTH grammars (see the header) and
; tsx/src/node-types.json does not have that node at all -- the angle-bracket
; form is locally ambiguous with a JSX opening tag, so tree-sitter-typescript
; disables it for tsx and there is no substitute node to name instead; a
; `<Type>expr` assertion is written `expr as Type` in a .tsx file regardless
; (`as_expression`, which IS in the list). tsx's own two additions --
; `jsx_element`, `jsx_self_closing_element` -- are the mirror image and are
; correspondingly left OUT of this shared list, since plain `typescript.wasm`
; doesn't have them: a top-level `const x = <div/>;` is real but rare TSX and
; this resolver is deliberately dumb about the cases outside the intersection.

(class_declaration
  name: (type_identifier) @name) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.function

(interface_declaration
  name: (type_identifier) @name) @definition.type

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.type

; Top-level const/let/var, bare (not exported), function-valued.
(program
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]) @definition.function)
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]) @definition.function)
  ])

; Top-level const/let/var, exported, function-valued.
(program
  (export_statement
    declaration: [
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]) @definition.function)
      (variable_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]) @definition.function)
    ]))

; Top-level const/let/var, bare, everything else -- see the header for why
; this is an explicit list rather than an unconstrained `value: (_)`.
(program
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [
          (array) (as_expression) (assignment_expression)
          (augmented_assignment_expression) (await_expression) (binary_expression)
          (call_expression) (class) (false) (generator_function) (identifier)
          (instantiation_expression) (internal_module) (member_expression)
          (meta_property) (new_expression) (non_null_expression) (null) (number)
          (object) (parenthesized_expression) (regex) (satisfies_expression)
          (string) (subscript_expression) (super) (template_string)
          (ternary_expression) (this) (true) (unary_expression)
          (undefined) (update_expression) (yield_expression)
        ]) @definition.constant)
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: [
          (array) (as_expression) (assignment_expression)
          (augmented_assignment_expression) (await_expression) (binary_expression)
          (call_expression) (class) (false) (generator_function) (identifier)
          (instantiation_expression) (internal_module) (member_expression)
          (meta_property) (new_expression) (non_null_expression) (null) (number)
          (object) (parenthesized_expression) (regex) (satisfies_expression)
          (string) (subscript_expression) (super) (template_string)
          (ternary_expression) (this) (true) (unary_expression)
          (undefined) (update_expression) (yield_expression)
        ]) @definition.constant)
  ])

; Top-level const/let/var, exported, everything else.
(program
  (export_statement
    declaration: [
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [
            (array) (as_expression) (assignment_expression)
            (augmented_assignment_expression) (await_expression) (binary_expression)
            (call_expression) (class) (false) (generator_function) (identifier)
            (instantiation_expression) (internal_module) (member_expression)
            (meta_property) (new_expression) (non_null_expression) (null) (number)
            (object) (parenthesized_expression) (regex) (satisfies_expression)
            (string) (subscript_expression) (super) (template_string)
            (ternary_expression) (this) (true) (unary_expression)
            (undefined) (update_expression) (yield_expression)
          ]) @definition.constant)
      (variable_declaration
        (variable_declarator
          name: (identifier) @name
          value: [
            (array) (as_expression) (assignment_expression)
            (augmented_assignment_expression) (await_expression) (binary_expression)
            (call_expression) (class) (false) (generator_function) (identifier)
            (instantiation_expression) (internal_module) (member_expression)
            (meta_property) (new_expression) (non_null_expression) (null) (number)
            (object) (parenthesized_expression) (regex) (satisfies_expression)
            (string) (subscript_expression) (super) (template_string)
            (ternary_expression) (this) (true) (unary_expression)
            (undefined) (update_expression) (yield_expression)
          ]) @definition.constant)
    ]))
