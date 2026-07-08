# CtrlClickDiff

A local, fast, **read-only Kotlin commit reviewer**. Pick a commit, see a side-by-side
diff of its changed `.kt` files, and **Ctrl+click any symbol to open its declaration in an
inline peek widget *inside* the diff** — Esc to jump back, F12 to jump to the file. Nothing
opens in a separate editor tab. The whole review, including navigation to declarations,
happens inside the diff.

This fills a real gap: plain diff viewers have no code intelligence, and IDEs have
go-to-declaration but bounce you *out* of the diff to use it. CtrlClickDiff keeps
language-aware navigation **inside the diff view**.

![Cross-file peek inside a diff](packages/frontend/m3-peek-crossfile.png)

## How it works

Two processes plus a swappable "brain":

- **Frontend** (`packages/frontend`) — TypeScript + Vite + [Monaco](https://microsoft.github.io/monaco-editor/)
  `DiffEditor`. A `registerDefinitionProvider('kotlin', …)` calls the backend and returns a
  `Location`, which Monaco renders as an inline peek (`definitionLinkOpensInPeek`). Kotlin
  highlighting is built into Monaco.
- **Backend** (`packages/backend`) — TypeScript + Fastify. Serves git content (`git show`)
  and a symbol index over HTTP.
- **The brain** (`packages/backend/src/resolver`) — a `TreeSitterResolver` behind the
  `SymbolResolver` interface (`packages/shared`). It parses every `.kt` file at the reviewed
  revision with [tree-sitter](https://tree-sitter.github.io/) (WASM) + a Kotlin grammar,
  builds a `name → declaration location` index, and answers "where is this declared?".
  The interface keeps it swappable (future `CtagsResolver` / `LspResolver`).

Resolution is **name-based** (good for "jump to the declaration in my own Kotlin"), not
semantic — no overload resolution, import following, or jumps into stdlib/library code.

## Prerequisites

- Node **22.x** (`.nvmrc` pins it) and **pnpm** (`corepack enable` or install pnpm 11+).
- No native toolchain needed — the Kotlin grammar ships prebuilt at
  `vendor/tree-sitter-kotlin.wasm` (see `vendor/README.md` to rebuild).

## Setup

```bash
pnpm install
pnpm smoke        # optional: asserts the Kotlin WASM loads with a matching ABI
```

## Run

The backend reviews **one git repository**, given by the `REPO_ROOT` env var. Point it at any
local repo that has Kotlin files.

```bash
# Terminal 1 — backend (serves git + the symbol index on :5178)
REPO_ROOT=/path/to/your/kotlin/repo pnpm dev:backend

# Terminal 2 — frontend (Vite dev server; proxies /api to the backend)
pnpm dev:frontend
```

Open the Vite URL it prints (default http://localhost:5173).

**Using it:** choose a commit from the picker → click a changed `.kt` file (badged `A`/`M`/`D`)
→ **Ctrl+click** (Cmd on macOS) a symbol to peek its declaration, **Esc** to close, **F12** to
jump to the declaration's file.

### Try it with the bundled fixture

```bash
bash fixtures/make-sample-repo.sh          # creates ~/ccd-sample-repo (3 commits, cross-file refs)
REPO_ROOT=~/ccd-sample-repo pnpm dev:backend
pnpm dev:frontend
```

Open the newest commit, click `Main.kt`, and Ctrl+click `shout` — it peeks `fun shout` from
`Utils.kt`, cross-file, inside the diff.

## Layout

```
packages/shared     @ctrlclickdiff/shared  — the SymbolResolver contract + wire types (consumed as TS source)
packages/backend    Fastify + git.ts + resolver/TreeSitterResolver.ts
packages/frontend    Vite + monaco; diff.ts, defprovider.ts, shell.ts
vendor/             prebuilt tree-sitter-kotlin.wasm (+ how to rebuild)
fixtures/           make-sample-repo.sh — a reproducible Kotlin test repo
m1-spike/           throwaway CDN spike that proved peek-in-diff before any real code
```

## HTTP API

| Endpoint | Returns |
|---|---|
| `GET /api/commits` | `CommitInfo[]` (newest 100) |
| `GET /api/commit/:sha/files` | `{ headSha, baseSha, files: ChangedFile[] }` (`.kt` only, `A`/`M`/`D`) |
| `GET /api/file?rev=&path=` | file content at a revision (`""` for the missing side of added/deleted files) |
| `GET /api/def?name=&file=&line=&lang=kotlin&rev=` | `DefLocation[]` (empty = not found; multiple = ambiguous) |
| `POST /api/index?rev=` | prewarm the symbol index for a revision |

## Scope (MVP)

**In:** Kotlin, side-by-side diff, same-file + cross-file peek, name-based resolution, read-only.
**Out:** other languages, semantic accuracy, unified/inline diff, staging/editing, auth/remote,
desktop packaging, find-references/rename/hover. The `SymbolResolver` seam keeps these open.
