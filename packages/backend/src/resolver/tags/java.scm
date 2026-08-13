; Captures ONLY @name plus @definition.{class,function,constant,type} — the
; resolver's DEF_KINDS (TreeSitterResolver.ts) recognises exactly those four,
; and assertDefinitionKinds fails boot on anything else. Deliberately no
; @reference.* captures: upstream tree-sitter-java's own queries/tags.scm
; carries reference.call/reference.class/reference.implementation captures
; (for a references-panel use case this resolver does not have — resolve()
; only ever looks up @name against @definition.*), so they are left out
; rather than copied in as dead weight.
;
; Kind mapping, and why each declaration form lands where it does:
;
;  - class_declaration, record_declaration, enum_declaration -> @definition.class.
;    All three are "a type users construct an instance of" — a record is a
;    restricted class and an enum's constants are instances of it — so they
;    share Kotlin's class_declaration/object_declaration -> @definition.class
;    split by the same reasoning, not a Java-specific one.
;  - interface_declaration, annotation_type_declaration -> @definition.type.
;    Neither is instantiated directly; both declare a contract/shape a class
;    then implements or is annotated with. Mirrors Kotlin's type_alias ->
;    @definition.type: a type-level name, not a constructible one.
;  - method_declaration, constructor_declaration -> @definition.function.
;    A constructor has no separate DEF_KIND to go to and is, structurally,
;    a same-named function that returns the class's own instance.
;  - field_declaration (through its declarator's name) and enum_constant ->
;    @definition.constant. There is no separate "field"/"variable" kind in
;    DEF_KINDS; this mirrors Kotlin's property_declaration ->
;    @definition.constant, and an enum constant is a field in every sense
;    that matters here (a named, typed, class-body-level declaration).
;
; Deliberately NOT captured: local_variable_declaration (a variable inside a
; method body). Kotlin's tags.scm draws the identical line — property_declaration
; is captured, a local `val`/`var` inside a function body is not — so a Java
; local variable is left uncaptured for the same reason: Ctrl+click on a
; method-local name is not a cross-file "go to definition" question the way a
; field, method, or type name is, and admitting it would multiply candidate
; files with declarations nobody importing this file could ever navigate to.

; Classes, records, and enums: constructible types.
(class_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(enum_declaration
  name: (identifier) @name) @definition.class

; Interfaces and annotation types: contracts/shapes, not constructed directly.
(interface_declaration
  name: (identifier) @name) @definition.type

(annotation_type_declaration
  name: (identifier) @name) @definition.type

; Methods and constructors.
(method_declaration
  name: (identifier) @name) @definition.function

(constructor_declaration
  name: (identifier) @name) @definition.function

; Fields (via their declarator) and enum constants.
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @definition.constant

(enum_constant
  name: (identifier) @name) @definition.constant
