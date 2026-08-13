; Captures ONLY @name plus @definition.{class,function,constant,type} — the
; resolver's DEF_KINDS (TreeSitterResolver.ts) recognises exactly those four,
; and assertDefinitionKinds fails boot on anything else. Deliberately no
; @reference.* captures: upstream tree-sitter-c-sharp's own queries/tags.scm
; carries reference.class/reference.interface/reference.send captures (for a
; references-panel use case this resolver does not have — resolve() only ever
; looks up @name against @definition.*), so they are left out rather than
; copied in as dead weight.
;
; Kind mapping, and why each declaration form lands where it does:
;
;  - class_declaration, struct_declaration, record_declaration ->
;    @definition.class. All three are "a type users construct an instance
;    of" — a struct is a value-typed class and a record is a class (or, for
;    `record struct`, a struct) with compiler-generated equality — so they
;    share Kotlin's class_declaration/object_declaration -> @definition.class
;    split by the same reasoning, not a C#-specific one.
;  - interface_declaration, enum_declaration, delegate_declaration ->
;    @definition.type. None of the three is instantiated with `new` the way
;    a class/struct/record is: an interface is a contract a class implements,
;    an enum names a closed set of constant values rather than a
;    general-purpose constructible type, and a delegate is a named function
;    *signature*, not a value. Mirrors Kotlin's type_alias -> @definition.type:
;    a type-level name, not a constructible one.
;  - method_declaration, constructor_declaration, local_function_statement ->
;    @definition.function. A constructor has no separate DEF_KIND to go to
;    and is, structurally, a same-named function that returns the class's own
;    instance; a local function is textually nested inside a method body but
;    is exactly as much a named, callable declaration as a top-level one.
;  - property_declaration and field_declaration (through its
;    variable_declaration's declarator) -> @definition.constant. There is no
;    separate "property"/"field"/"variable" kind in DEF_KINDS; this mirrors
;    Kotlin's property_declaration -> @definition.constant, which already
;    conflates the same two concepts (Kotlin's `val`/`var` property is C#'s
;    property/field split back into one).
;  - enum_member_declaration -> @definition.constant. A named, valued member
;    of a closed set — the same role Kotlin's enum_entry plays, captured
;    identically there.
;
; Deliberately NOT captured: local declarations inside a method/function body
; (a `variable_declaration` that is NOT a direct child of a `field_declaration`
; — e.g. `int x = 1;` inside a method). Kotlin's tags.scm draws the identical
; line — property_declaration is captured, a local `val`/`var` inside a
; function body is not — so a C# local variable is left uncaptured for the
; same reason: Ctrl+click on a method-local name is not a cross-file "go to
; definition" question the way a field, property, method, or type name is,
; and admitting it would multiply candidate files with declarations nobody
; importing this file could ever navigate to. Scoping the field pattern to
; `(field_declaration (variable_declaration ...))` rather than a bare
; `variable_declaration` is what keeps a method-local `int x = 1;` out —
; that node is a direct child of a `local_declaration_statement`, never of a
; `field_declaration`, so it cannot match this pattern.

; Classes, structs, and records: constructible types.
(class_declaration
  name: (identifier) @name) @definition.class

(struct_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

; Interfaces, enums, and delegates: contracts/shapes/signatures, not
; constructed with `new` the way a class/struct/record is.
(interface_declaration
  name: (identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.type

(delegate_declaration
  name: (identifier) @name) @definition.type

; Methods, constructors, and local functions.
(method_declaration
  name: (identifier) @name) @definition.function

(constructor_declaration
  name: (identifier) @name) @definition.function

(local_function_statement
  name: (identifier) @name) @definition.function

; Properties, fields (via their declarator), and enum members.
(property_declaration
  name: (identifier) @name) @definition.constant

(field_declaration
  (variable_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.constant

(enum_member_declaration
  name: (identifier) @name) @definition.constant
