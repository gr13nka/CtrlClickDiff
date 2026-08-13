; C++ definitions. Verified node-by-node against tree-sitter-cpp's own
; node-types.json and a real parse (see vendor/build-grammars.sh's pinned
; commit) rather than assumed from the grammar's upstream queries/tags.scm,
; which uses a `@definition.method` kind this resolver's DEF_KINDS does not
; have and omits several of the shapes below entirely.
;
; Covers everything a plain C file can declare, plus three C++-only shapes:
;
;   - class_specifier WITH a body -> @definition.class, the same way
;     struct/union are below. A forward declaration (`class Foo;`) has no
;     `body` field and so does not match -- same reasoning as struct/union.
;   - alias_declaration (`using Alias = T;`) -> @definition.type, alongside
;     typedef. Deliberately captured despite superficially looking like the
;     `using` prefix a reader might expect to be boilerplate: it is a type
;     declaration, not an import, and excluding it would hide a real
;     definition (see languages.ts's `using` prefix argument).
;   - in-class method DECLARATIONS (`int area() const;` inside a class/struct
;     body). These never produce a function_definition at all -- there is no
;     body, so they only exist as a field_declaration whose declarator is a
;     function_declarator. Matched directly on field_declaration; a plain
;     data member's declarator is a bare field_identifier (or wrapped in
;     pointer/array/etc, none of which is a function_declarator), so it never
;     matches this pattern.
;   - out-of-class method DEFINITIONS (`void Shape::draw() { ... }`). The
;     function_declarator's declarator is a qualified_identifier rather than
;     a bare identifier; only the trailing (unqualified) name is captured, so
;     the definition is keyed the same way an in-class declaration of the
;     same method is.
;
; Deliberately NOT captured: template declarations (name resolution for a
; template is not what a click on ordinary code needs), operator overloads
; and constructors/destructors (their "name" fields are operator_name /
; destructor_name, not identifier -- a different, more speculative shape than
; anything a C reviewer needs), and namespace_definition (a namespace is a
; scope, not a symbol a Ctrl+click on an identifier resolves to).

; --- object-like and function-like macros ---

(preproc_def
  name: (identifier) @name) @definition.constant

(preproc_function_def
  name: (identifier) @name) @definition.function

; --- struct / union / enum, only when they have a body (a bare
; `struct Point;` forward declaration has no `body` field and is correctly
; left unmatched -- it declares nothing new at that location) ---

(struct_specifier
  name: (type_identifier) @name
  body: (_)) @definition.class

(union_specifier
  name: (type_identifier) @name
  body: (_)) @definition.class

(enum_specifier
  name: (type_identifier) @name
  body: (_)) @definition.type

(enumerator
  name: (identifier) @name) @definition.constant

; --- typedef ---

(type_definition
  declarator: (type_identifier) @name) @definition.type

; --- function definitions: plain, and the pointer-return-type variant
; (`char *make() { ... }`, where the function_declarator is one level down
; inside a pointer_declarator) ---

(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @name))) @definition.function

; --- C++: class, alias, in-class method declaration, out-of-class method
; definition (see header) ---

(class_specifier
  name: (type_identifier) @name
  body: (_)) @definition.class

(alias_declaration
  name: (type_identifier) @name) @definition.type

(field_declaration
  declarator: (function_declarator
    declarator: (field_identifier) @name)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (identifier) @name))) @definition.function
