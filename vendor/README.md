# vendor/tree-sitter-kotlin.wasm

Prebuilt Kotlin tree-sitter grammar, committed because no prebuilt Kotlin
`.wasm` is published upstream.

- **Source repo:** https://github.com/fwcd/tree-sitter-kotlin
- **Pinned commit SHA:** `c8ac3d2627240160b999a2c100de3babbdb8f419` (main, 2026-07-08)
- **Built with:** `tree-sitter-cli` `0.26.10` (resolved from `^0.26.0`), matching
  the `web-tree-sitter@0.26.x` ABI used by `packages/backend`. Do not build
  this file with a tree-sitter-cli outside the `0.26.x` line — an ABI
  mismatch between the CLI that emits the wasm and the runtime that loads it
  fails to load **silently**.
- **Toolchain note:** neither `emcc` nor Docker was needed at build time —
  `tree-sitter-cli@0.26` downloads and uses its own bundled `wasi-sdk`
  (wasi-sdk-29) automatically.
- **Verified:** loaded with `web-tree-sitter@0.26`, parsed a sample Kotlin
  file with zero parse errors, and `packages/backend/src/resolver/tags/kotlin.scm`
  produced non-empty captures (`definition.class`, `definition.function`,
  `name`) against it.
- **File size:** 5,812,838 bytes (~5.5 MiB).

## Rebuild

```bash
git clone --depth 1 https://github.com/fwcd/tree-sitter-kotlin.git /tmp/tsk && \
  cd /tmp/tsk && npx --yes tree-sitter-cli@^0.26.0 build --wasm && \
  cp tree-sitter-kotlin.wasm /path/to/CtrlClickDiff/vendor/tree-sitter-kotlin.wasm
```
