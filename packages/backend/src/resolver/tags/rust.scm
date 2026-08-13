; The tags query naming Rust's declarations for Ctrl+click / F12.
;
; Captures @name plus @definition.{class,function,constant,type} ONLY --
; TreeSitterResolver's boot validator (assertDefinitionKinds) rejects any
; other definition kind, and this resolver has no @reference.* consumer, so
; none are captured here. Upstream's own queries/tags.scm also marks
; @reference.call and @reference.implementation (for cross-referencing
; tools this repo doesn't have) and uses @definition.method/.interface/
; .module/.macro, none of which shared/types.ts's DefKind recognises --
; this file is deliberately narrower, not a copy.
;
; Kind mapping, against shared/types.ts's four-way DefKind:
;  - function_item, function_signature_item -> @definition.function
;      A function_signature_item is a body-less declaration (a trait or
;      extern method, e.g. `fn foo(&self);`) -- still a jump target, so it
;      gets the same kind as a function with a body.
;  - struct_item, enum_item, union_item     -> @definition.class
;      The ADT kinds, grouped as "class" the same way Kotlin's class/object
;      declarations both map to @definition.class.
;  - trait_item, type_item                  -> @definition.type
;  - const_item, static_item                -> @definition.constant
;  - macro_definition                       -> @definition.function
;      A macro_rules! definition is invoked like a function at every call
;      site and there is no @definition.macro kind, so @definition.function
;      is the closest honest fit.
;
; mod_item is deliberately OMITTED: a module is a namespace, not a jump
; target this tool serves well, unlike every kind above which names one
; specific declaration. `mod m { fn f() {} }` still surfaces `f` via
; function_item above -- an inline module's declarations are still found,
; only the module name itself is not a definition site.
;
; Field names (`name:`) rather than positional child matching, because a
; Rust item node's children include an optional visibility_modifier and
; keyword tokens before the name -- verified against grammar.js at the
; pinned commit and cross-checked against upstream's own tags.scm.

(struct_item
  name: (type_identifier) @name) @definition.class

(enum_item
  name: (type_identifier) @name) @definition.class

(union_item
  name: (type_identifier) @name) @definition.class

(trait_item
  name: (type_identifier) @name) @definition.type

(type_item
  name: (type_identifier) @name) @definition.type

(function_item
  name: (identifier) @name) @definition.function

(function_signature_item
  name: (identifier) @name) @definition.function

(macro_definition
  name: (identifier) @name) @definition.function

(const_item
  name: (identifier) @name) @definition.constant

(static_item
  name: (identifier) @name) @definition.constant
