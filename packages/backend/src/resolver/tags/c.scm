; Captures ONLY @name plus @definition.{class,function,constant,type} — the
; resolver's DEF_KINDS (TreeSitterResolver.ts) recognises exactly those four,
; and assertDefinitionKinds fails boot on anything else. Deliberately no
; @reference.* captures: this resolver's resolve() only ever looks up @name
; against @definition.*, so a references-panel capture set would be dead
; weight (same reasoning as tags/java.scm).
;
; Kind mapping, and why each declaration form lands where it does:
;
;  - struct_specifier / union_specifier, WITH a body (field_declaration_list)
;    -> @definition.class. A struct or union with a body is the type users
;    construct an instance of, same rank as Kotlin's class_declaration and
;    Java's class_declaration/record_declaration. The `body:` field
;    requirement is load-bearing, not decorative — verified empirically
;    below: without it, `typedef struct Point PointT;` would ALSO capture
;    "Point" a second time from the bare `struct Point` reference inside the
;    typedef (which has a `name:` field but no `body:`), duplicating a
;    definition at the point it is merely named. A forward declaration
;    (`struct Point;`) has the same shape — name, no body — and is correctly
;    left uncaptured for the identical reason: it names a type without
;    defining it.
;  - enum_specifier, WITH a body (enumerator_list) -> @definition.type. Not
;    @definition.class: an enum name is not itself constructible (you build
;    an enum_specifier's *enumerators*, not the enum type), mirroring
;    Kotlin's type_alias -> @definition.type — a type-level name, not one you
;    instantiate directly.
;  - type_definition (a `typedef`), via its declarator -> @definition.type.
;    `typedef struct Point PointT;` introduces the name `PointT`, which is
;    what a reader Ctrl+clicks; the struct_specifier it wraps is a
;    *reference* to the already-declared `Point` (see above), not a second
;    declaration of it.
;  - preproc_def ("#define NAME ...", an object-like macro) -> its `name:`
;    field. A `#define` with no parameter list, e.g. `#define MAX 10`,
;    behaves like a named constant at every call site — DEF_KINDS has no
;    "macro" kind, and constant is the closest existing one (same choice
;    tags/java.scm makes for `field_declaration` — "there is no separate
;    field/variable kind, so the nearest existing one is used").
;  - preproc_function_def ("#define NAME(args) ...", a function-like macro)
;    -> its `name:` field, @definition.function. Distinct node type from
;    preproc_def specifically because it takes a parameter list and expands
;    like a call, so it is captured as a function rather than a constant.
;  - function_declarator's `declarator:` field (an `identifier`) ->
;    @definition.function. This single pattern, with no parent-type
;    constraint, ALSO captures a pointer-returning function
;    (`int *make_point(...)`) without a second pattern: `function_declarator`
;    is nested one level deeper there — inside a `pointer_declarator` that is
;    itself the outer declarator — but the query has no field/parent
;    requirement above `function_declarator`, so it matches at any depth.
;    Verified rather than assumed (`tree-sitter query` against a sample with
;    both a plain and a pointer-returning function): a single pattern
;    produced both `add` and `make_point`, so no separate
;    pointer_declarator-wrapping pattern was added — one would only
;    duplicate the match this pattern already produces for that case.
;    Also captures a bare prototype (`int proto(int a, int b);`, a
;    `declaration` with no body) the same way a definition is captured —
;    accepted rather than filtered out: DEF_KINDS has no "declared, not yet
;    defined" distinction, and a prototype's name is still a legitimate
;    Ctrl+click target.
;  - enumerator's `name:` field -> @definition.constant. An enum member is a
;    named integer constant, the same category preproc_def's macro constants
;    land in.
;
; Deliberately NOT captured: local variable declarations, struct/union
; forward declarations (`struct Point;` — see above), and typedef'd
; primitives/pointers whose RHS is not itself a struct/union/enum
; (`typedef int MyInt;` still captures "MyInt" as @definition.type via
; type_definition's `declarator:` field — that is intended, a typedef name
; is always a Ctrl+click target regardless of what it aliases).

(struct_specifier
  name: (type_identifier) @name
  body: (field_declaration_list)) @definition.class

(union_specifier
  name: (type_identifier) @name
  body: (field_declaration_list)) @definition.class

(enum_specifier
  name: (type_identifier) @name
  body: (enumerator_list)) @definition.type

(type_definition
  declarator: (type_identifier) @name) @definition.type

(function_declarator
  declarator: (identifier) @name) @definition.function

(preproc_function_def
  name: (identifier) @name) @definition.function

(preproc_def
  name: (identifier) @name) @definition.constant

(enumerator
  name: (identifier) @name) @definition.constant
