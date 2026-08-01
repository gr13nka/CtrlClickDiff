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
