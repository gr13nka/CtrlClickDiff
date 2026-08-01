; Deliberately captured: class declarations, methods (including static/get/set
; and the constructor — a reader might Ctrl+click any of them), named function
; declarations (plain and generator), and every TOP-LEVEL const/let/var,
; classified as @definition.function when its value is an arrow function, a
; function expression or a generator expression, and @definition.constant
; otherwise (including one with no initializer at all, e.g. `let counter;`).
;
; Deliberately omitted: class *expressions* assigned to a variable capture as
; @definition.constant, not @definition.class — this file follows the letter
; of the spec ("variable_declarator ... -> function else -> constant"), and a
; class expression is not function-ish. No @reference.* captures: this
; resolver only recognises @definition.<kind> (DEF_KINDS in
; TreeSitterResolver.ts is class/function/constant/type) and silently drops
; anything else, so adding reference captures here would be dead weight, not
; a feature. No `type` kind: JS has no type-alias declaration to name one for.
;
; The "top-level" restriction (program- or export_statement-level only, never
; a local inside a function/block) is load-bearing, not decorative: without
; it, EVERY local const/let/var in every function body would also match, and
; candidate discovery already greps the whole repo per identifier (see
; nonDeclaringLinePrefixes in languages.ts) — turning a handful of top-level
; symbols into every local variable everywhere would make that grep's result
; set, and the parse cost behind it, unrecognisably larger for no benefit: a
; local is definitionally only visible in the scope it says its own value.
;
; The function/constant split needs BOTH a positive list (value is one of the
; three function-ish expression types) and an exhaustive negative list (value
; is any of the *other* concrete expression types tree-sitter-javascript
; defines, enumerated from this pinned commit's src/node-types.json: the
; `expression` supertype's subtypes, plus `primary_expression`'s, minus the
; three already claimed) rather than one positive list and an unconstrained
; fallback. tree-sitter's query engine has no type-negation predicate — only
; text predicates (#eq?, #match?, #any-of?, ...) — so an unconstrained
; fallback pattern (`(variable_declarator name: (identifier) @name)` with no
; `value:` constraint) structurally matches the SAME node the function
; pattern already matched, and both fire: verified empirically against
; `const qux = function () {}` and `const arrow = () => {}`, which each
; produced TWO captures (one @definition.function, one @definition.constant)
; at the identical location before this file added the negative list. A
; third pair of patterns (`!value`) covers the no-initializer case, which the
; negative list's `value:` constraint requires a value to exist and so
; cannot.
;
; `var` is included alongside `let`/`const` (variable_declaration alongside
; lexical_declaration) for completeness, not because it is common in code
; this tool expects to review.

; Classes
(class_declaration
  name: (identifier) @name) @definition.class

; Methods — instance and static, get/set and the constructor alike
(method_definition
  name: (property_identifier) @name) @definition.function

; Named function declarations, including generators
[
  (function_declaration
    name: (identifier) @name)
  (generator_function_declaration
    name: (identifier) @name)
] @definition.function

; Top-level const/let/var bound to a function-ish value
(program
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression) (generator_function)]) @definition.function)
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression) (generator_function)]) @definition.function)
    (export_statement
      declaration: (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression) (generator_function)]) @definition.function))
    (export_statement
      declaration: (variable_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression) (generator_function)]) @definition.function))
  ])

; Every other top-level const/let/var: value present, of any non-function-ish
; expression type. The alternation is the exhaustive complement of the three
; function-ish types above, over every leaf type the `expression` and
; `primary_expression` supertypes name in this pinned grammar commit — see
; the file header for why this must be exhaustive rather than a shorter
; "common cases" list.
(program
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [
          (assignment_expression) (augmented_assignment_expression) (await_expression)
          (binary_expression) (jsx_element) (jsx_self_closing_element) (new_expression)
          (ternary_expression) (unary_expression) (update_expression) (yield_expression)
          (array) (call_expression) (class) (false) (identifier) (member_expression)
          (meta_property) (null) (number) (object) (parenthesized_expression) (regex)
          (string) (subscript_expression) (super) (template_string) (this) (true) (undefined)
        ]) @definition.constant)
    (variable_declaration
      (variable_declarator
        name: (identifier) @name
        value: [
          (assignment_expression) (augmented_assignment_expression) (await_expression)
          (binary_expression) (jsx_element) (jsx_self_closing_element) (new_expression)
          (ternary_expression) (unary_expression) (update_expression) (yield_expression)
          (array) (call_expression) (class) (false) (identifier) (member_expression)
          (meta_property) (null) (number) (object) (parenthesized_expression) (regex)
          (string) (subscript_expression) (super) (template_string) (this) (true) (undefined)
        ]) @definition.constant)
    (export_statement
      declaration: (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [
            (assignment_expression) (augmented_assignment_expression) (await_expression)
            (binary_expression) (jsx_element) (jsx_self_closing_element) (new_expression)
            (ternary_expression) (unary_expression) (update_expression) (yield_expression)
            (array) (call_expression) (class) (false) (identifier) (member_expression)
            (meta_property) (null) (number) (object) (parenthesized_expression) (regex)
            (string) (subscript_expression) (super) (template_string) (this) (true) (undefined)
          ]) @definition.constant))
    (export_statement
      declaration: (variable_declaration
        (variable_declarator
          name: (identifier) @name
          value: [
            (assignment_expression) (augmented_assignment_expression) (await_expression)
            (binary_expression) (jsx_element) (jsx_self_closing_element) (new_expression)
            (ternary_expression) (unary_expression) (update_expression) (yield_expression)
            (array) (call_expression) (class) (false) (identifier) (member_expression)
            (meta_property) (null) (number) (object) (parenthesized_expression) (regex)
            (string) (subscript_expression) (super) (template_string) (this) (true) (undefined)
          ]) @definition.constant))
  ])

; Top-level const/let/var with no initializer at all (`let counter;`) — also
; "else", but `!value` rather than the list above, since there is no value
; node to test the type of.
(program
  [
    (lexical_declaration
      (variable_declarator name: (identifier) @name !value) @definition.constant)
    (variable_declaration
      (variable_declarator name: (identifier) @name !value) @definition.constant)
    (export_statement
      declaration: (lexical_declaration
        (variable_declarator name: (identifier) @name !value) @definition.constant))
    (export_statement
      declaration: (variable_declaration
        (variable_declarator name: (identifier) @name !value) @definition.constant))
  ])
