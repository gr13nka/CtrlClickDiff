# vendor/

Prebuilt tree-sitter grammar `.wasm` files, committed because no upstream
prebuild covers every language this tool parses.

**The ABI rule:** every wasm here must be built with `tree-sitter-cli`
`0.26.10` exactly, matching the `web-tree-sitter@0.26.x` runtime
`packages/backend` loads grammars with. A wasm built with a CLI outside the
`0.26.x` line fails to load **silently** -- no error, the grammar just
produces no captures.

Rebuild any grammar with:

```bash
bash vendor/build-grammars.sh <key>
# or, for every pinned grammar:
bash vendor/build-grammars.sh --all
```

The pin table (upstream repo, commit SHA, subdirectory) lives in
`vendor/build-grammars.sh` itself, not here -- this file records the
provenance of what is currently committed, that script records what to
build next time.

## Provenance

### tree-sitter-kotlin.wasm

- **Upstream repo:** https://github.com/fwcd/tree-sitter-kotlin
- **Pinned commit:** `c8ac3d2627240160b999a2c100de3babbdb8f419` (main, 2026-07-08)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 5,812,838 bytes (~5.5 MiB)
- **sha256:** `ba42b78e5c676ba4e4fdf845e8c6510c04bebdf1a0f8d324c764986acb1a890d`
- **Notes:** no prebuilt Kotlin `.wasm` is published upstream, hence
  committing one here. Neither `emcc` nor Docker is needed at build time --
  `tree-sitter-cli@0.26` downloads and uses its own bundled `wasi-sdk`
  (wasi-sdk-29) automatically. Verified against `web-tree-sitter@0.26`: parsed
  a sample Kotlin file with zero parse errors, and
  `packages/backend/src/resolver/tags/kotlin.scm` produced non-empty
  captures (`definition.class`, `definition.function`, `name`) against it.
  Rebuilding from the pinned commit is **not byte-identical** to the
  committed file: two separate `build-grammars.sh kotlin` runs both produced
  sha256 `16f89fc80ec449c71115714b3ad7e8b1ee53a93c025e2ed8f7bf6aee69c26c9c`
  at 5,812,823 bytes (15 bytes smaller than committed, reproducible run to
  run) -- expected for a wasm toolchain that embeds no build-path or
  timestamp guarantee. ABI compatibility, not byte identity, is what's
  required, and that's what `pnpm smoke` checks on every run; it passed
  against the committed wasm after this rebuild was verified and discarded.

### tree-sitter-typescript.wasm

- **Upstream repo:** https://github.com/tree-sitter/tree-sitter-typescript
  (`typescript/` subdirectory of the monorepo)
- **Pinned commit:** `75b3874edb2dc714fb1fd77a32013d0f8699989f` (default
  branch head at build time)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 1,418,202 bytes (~1.35 MiB)
- **sha256:** `22fce33c21f07ca86d16c4ef7fbf398c015846125295df08adbfc9959232376b`
- **Notes:** one repo, two grammars — `typescript/` cannot parse JSX, which is
  why `tsx/` (below) is a separate wasm rather than a superset. The committed
  `src/parser.c` built against `tree-sitter-cli@0.26.10` with no ABI
  mismatch and no need for the `generate` fallback in this script. Verified
  against `web-tree-sitter@0.26`: loaded with zero errors, and
  `packages/backend/src/resolver/tags/typescript.scm` produced non-empty
  captures (`definition.class`, `definition.function`, `definition.constant`,
  `definition.type`, `name`) against a sample exercising a class, a method, an
  interface and a top-level const.

### tree-sitter-tsx.wasm

- **Upstream repo:** https://github.com/tree-sitter/tree-sitter-typescript
  (`tsx/` subdirectory of the monorepo — same repo and commit as
  `tree-sitter-typescript.wasm` above, different subdir)
- **Pinned commit:** `75b3874edb2dc714fb1fd77a32013d0f8699989f` (default
  branch head at build time)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 1,450,757 bytes (~1.38 MiB)
- **sha256:** `94917d337bbe28c0a77cdd19e6ae2d6de558fcc1b95b090d90ef96b496654e7e`
- **Notes:** shares `packages/backend/src/resolver/tags/typescript.scm` with
  the plain `typescript` grammar rather than getting its own file — the
  declaration node shapes (`class_declaration`, `function_declaration`,
  `method_definition`, `interface_declaration`, ...) are identical between
  the two generated grammars, JSX support being additive rather than a
  reshaping of the declaration grammar. Compiling that one query against both
  wasms at boot (`TreeSitterResolver.init`, once per grammar key) is itself
  the drift detector: if a future upstream change ever makes the two grammars
  disagree on a captured node shape, one of the two `Query` constructions
  fails at boot rather than one of the two silently stopping to capture.
  Verified against `web-tree-sitter@0.26`: loaded with zero errors, and the
  shared tags file produced non-empty captures against a JSX sample
  (`export function App() { return <div/> }` plus a top-level arrow-function
  const).

### tree-sitter-javascript.wasm

- **Upstream repo:** https://github.com/tree-sitter/tree-sitter-javascript
- **Pinned commit:** `58404d8cf191d69f2674a8fd507bd5776f46cb11` (HEAD, resolved
  via `git ls-remote` on 2026-08-02)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 416,480 bytes (~407 KiB)
- **sha256:** `ccec1d78b6a9e40563b7255c1b7d10423fc610ca26bdbafe8c7886de4c980d3d`
- **Notes:** built straight from the pinned commit with no `generate` fallback
  needed -- the committed `src/parser.c` was already current for this CLI's
  ABI. This grammar parses JSX natively (`jsx_element`/`jsx_expression` node
  types live in the same grammar as everything else), unlike
  tree-sitter-typescript which ships a separate `tsx` grammar for the same
  reason -- so `.jsx` needs no second wasm and no second registry entry, only
  a fourth extension on the one `javascript` row. Verified against
  `web-tree-sitter@0.26`: parsed a sample with a class, a method, a top-level
  const, and a JSX expression with zero parse errors, and
  `packages/backend/src/resolver/tags/javascript.scm` produced the expected
  `definition.class`/`definition.function`/`definition.constant`/`name`
  captures against it (see `pnpm smoke`'s `javascript` row).

### tree-sitter-python.wasm

- **Upstream repo:** https://github.com/tree-sitter/tree-sitter-python
- **Pinned commit:** `26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64` (HEAD, resolved
  via `git ls-remote`)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 460,873 bytes (~450 KiB)
- **sha256:** `45a3f2c67595661341de5a8c17b0246372183c06112eeec3be9a339fbdedf6bc`
- **Notes:** built straight from the pinned commit with no `generate` fallback
  needed -- the committed `src/parser.c` already matched the ABI
  `tree-sitter-cli@0.26.10` emits. Verified against `web-tree-sitter@0.26`:
  parsed a sample with a module-level constant, a class and a decorated
  method with zero parse errors, and
  `packages/backend/src/resolver/tags/python.scm` produced the expected
  `definition.constant`/`definition.class`/`definition.function`/`name`
  captures against it -- including confirming that upstream's own
  `queries/tags.scm` pattern for module-level assignments (anchored through
  an `expression_statement` wrapper) captures nothing at all against this
  build, because `expression_statement` is a `supertype` in the grammar and
  is elided from the concrete tree; `tags/python.scm` anchors directly to
  `module` instead (see that file's header comment).

### tree-sitter-java.wasm

- **Upstream repo:** https://github.com/tree-sitter/tree-sitter-java
- **Pinned commit:** `e10607b45ff745f5f876bfa3e94fbcc6b44bdc11` (HEAD, resolved
  via `git ls-remote`)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 416,768 bytes (~407 KiB)
- **sha256:** `63429f29cf9414acca19093b19c9494a586e020a1fdd57824c535f7f701fee62`
- **Notes:** the upstream repo ships a committed `src/parser.c` that built
  cleanly with `tree-sitter-cli@0.26.10 build --wasm` directly -- no
  `generate` regeneration step was needed (unlike the fallback the build
  script's comment warns about). `packages/backend/src/resolver/tags/java.scm`
  is hand-authored rather than copied from upstream's `queries/tags.scm`:
  upstream's file uses definition kinds (`definition.method`,
  `definition.interface`) and `@reference.*` captures this resolver's
  `DEF_KINDS` does not recognise and does not use. Verified against
  `web-tree-sitter@0.26` and, independently, `tree-sitter-cli@0.26.10 query`
  against a clone at the pinned commit: a 30-line sample covering all eleven
  captured declaration forms (class, record, enum, interface,
  annotation-type, method, constructor, field, enum-constant) produced
  exactly the expected `@name`/`@definition.*` pairs and nothing else.

### tree-sitter-go.wasm

- **Upstream repo:** https://github.com/tree-sitter/tree-sitter-go
- **Pinned commit:** `2346a3ab1bb3857b48b29d779a1ef9799a248cd7` (HEAD at pin time)
- **tree-sitter-cli version:** `0.26.10`
- **Wasm byte size:** 218,890 bytes (~214 KiB)
- **sha256:** `9c3338a4567a4d30bf3b29f92371fcb085e8a9822c3f45a7d3d95f73cc2fe677`
- **Notes:** the committed `src/parser.c` at the pinned commit built cleanly
  with `tree-sitter-cli@0.26.10`'s `build --wasm` — no `generate`
  regeneration step was needed (unlike the fallback `build-grammars.sh`
  documents in comment form). Verified against `web-tree-sitter@0.26`:
  loaded, parsed a scratch Go file with zero parse errors, and
  `packages/backend/src/resolver/tags/go.scm` produced non-empty captures
  (`definition.function`, `definition.type`, `definition.constant`, `name`)
  against it.
