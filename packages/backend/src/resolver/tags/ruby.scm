; Definitions only — no @reference.* captures. This resolver only ever needs
; to answer "where is X declared", so the reference captures kotlin.scm
; carries (for a future use this project does not have yet) are deliberately
; not repeated here; the boot validator (assertDefinitionKinds) would accept
; them but nothing would ever read them.
;
; Node shapes verified empirically against tree-sitter-ruby's pinned commit
; (see vendor/build-grammars.sh) with `tree-sitter parse` on a scratch file —
; not assumed from grammar.js or upstream's own queries/tags.scm.

; Classes. `name` is `(constant)` here, not the `scope_resolution` alternative
; grammar.js also allows (`class Foo::Bar`) — deliberately not captured: a
; scoped reopen isn't exercised by SAMPLES, and widening this later is a
; query change, not an architecture one.
(class
  name: (constant) @name) @definition.class

; Modules. Same `name: (constant)` shape as class, and Ruby modules are the
; closest thing this language has to Kotlin's `object` — a named namespace
; that can itself be referenced by name — so it is mapped to the same
; `definition.class` kind rather than inventing a `module` DefKind for one
; language.
(module
  name: (constant) @name) @definition.class

; Instance methods. `name` is left as `(_)` rather than pinned to
; `identifier`: grammar.js's `_method_name` also allows `constant`, `setter`,
; `simple_symbol`/`delimited_symbol` and `operator` (e.g. `def self.[]`,
; `def ==`), and every one of those is still a declaration site.
(method
  name: (_) @name) @definition.function

; Singleton (`def self.foo`) methods — grammar.js gives these their own node
; distinct from `method`, with the receiver in a separate `object` field that
; is not captured (it is not a declaration site, only a target).
(singleton_method
  name: (_) @name) @definition.function

; SCREAMING_SNAKE constants (`MAX = 10`). Captured only when the assignment's
; `left` is a bare `(constant)` — `_lhs` also allows `identifier` (a local or
; instance variable), and locals assigned anywhere in a method body are noise
; a Ctrl+click resolver has no business surfacing as a "definition"; only a
; Ruby constant is conventionally a name other files reference by. Left-hand
; sides that aren't a single `(constant)` (multiple assignment, `@ivar = x`,
; `self.attr = x`) fall outside this pattern and are correctly left uncaptured.
(assignment
  left: (constant) @name) @definition.constant
