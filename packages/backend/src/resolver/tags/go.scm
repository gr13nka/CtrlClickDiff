; Definitions only — no @reference.* captures. This resolver only ever needs
; to answer "where is X declared", so the reference captures kotlin.scm
; carries (for a future use this project does not have yet) are deliberately
; not repeated here; the boot validator (assertDefinitionKinds) would accept
; them but nothing would ever read them.
;
; Node shapes verified empirically against tree-sitter-go's pinned commit
; (see vendor/build-grammars.sh) with `tree-sitter parse` on a scratch file —
; not assumed from the grammar source.

; Top-level functions. `name` is a plain `identifier`.
(function_declaration
  name: (identifier) @name) @definition.function

; Methods. `name` is a `field_identifier`, not `identifier` — the receiver
; (`func (p *Point) Move(...)`) is a separate `parameter_list` field and is
; not captured; only the method name is a declaration site.
(method_declaration
  name: (field_identifier) @name) @definition.function

; Type declarations. Captured on `type_spec`, the node that carries the name,
; not on the enclosing `type_declaration` (which also wraps `type_alias` for
; `type X = Y` — deliberately NOT captured here, matching the spec this file
; was written against; a `type X = Y` alias is not currently exercised by
; SAMPLES and revisiting it is a smoke-sample change, not a query change).
(type_spec
  name: (type_identifier) @name) @definition.type

; Constants. `const A, B = 1, 2` repeats the `name` field once per identifier
; in the spec — the query matches each occurrence independently, so a
; multi-name const line yields one capture per name, not one for the line.
(const_spec
  name: (identifier) @name) @definition.constant

; Package-level (and function-local, which the resolver never looks inside —
; candidate discovery only reads declaration lines) variables. Same
; multi-name behaviour as const_spec.
(var_spec
  name: (identifier) @name) @definition.constant
