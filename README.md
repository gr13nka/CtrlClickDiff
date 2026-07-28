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

**One repo, one branch, per run.** `REPO_ROOT` is read once when the backend boots and cached
for the life of the process — there is no in-app repo or branch switcher. The commit picker
lists the newest 100 commits of whatever `HEAD` is checked out in `REPO_ROOT` at that moment
(`git log -n 100`, no `--all`, no ref filter). To review a different repo or a different
branch:

```bash
# stop the backend (Ctrl+C, or kill the process — see note below), then:
cd /path/to/repo && git checkout <branch>   # only if you need a different branch
REPO_ROOT=/path/to/repo pnpm dev:backend    # restart, pointed at the new repo/branch
```

The frontend doesn't need restarting — it just proxies `/api` to whatever backend is running.
One gotcha: killing the `pnpm dev:backend` process by its top-level PID doesn't always kill the
underlying `tsx watch` server (pnpm wraps it in a process tree), which can leave the old backend
still bound to port 5178 and silently serving the old repo. If a restart seems to not take
effect, check `lsof -i :5178` and kill the actual listening PID.

**Using it:** choose a commit from the picker (auto-selects the newest on load) → click a
changed `.kt` file in the sidebar (badged `A`/`M`/`D`, shown as a flat list — full path is the
row's hover tooltip, not truncated in the UI yet) → **Ctrl+click** (Cmd on macOS) a symbol to
peek its declaration inline, **Esc** to close the peek, **F12** to jump to the declaration's
file (opens in the same diff pane, side-by-side view only — no unified/inline diff mode yet).

Planned UX work (repo/branch picker, resizable + tree-view sidebar, unified diff mode, etc.) is
tracked in `TO-DOS.md`.

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
| `GET /api/browse?path=` | subdirectories of `path` (default: the browse root) — directory names only |

## Scope (MVP)

**In:** Kotlin, side-by-side diff, same-file + cross-file peek, name-based resolution, read-only.
**Out:** other languages, semantic accuracy, unified/inline diff, staging/editing, auth/remote,
desktop packaging, find-references/rename/hover, repo/branch switching without a restart,
resizable/tree-view sidebar. The `SymbolResolver` seam keeps the resolver swappable; see
`TO-DOS.md` for the rest.

### Read-only, mechanically

"Read-only" isn't just a design intent — the code has no path to write or delete anything:

- Every git call goes through one function (`packages/backend/src/git.ts`'s `run()`) using
  `execFile('git', args, …)` with an **argument array**, never a shell string, so request input
  can't inject shell commands. The only git subcommands ever invoked are `log`, `rev-parse`,
  `diff-tree`, `ls-tree`, and `show` — all read-only plumbing. Nothing calls `checkout`,
  `reset`, `clean`, `commit`, `push`, or any branch-mutating command.
- The backend reads the filesystem and never writes it. Its whole filesystem surface is
  `readFile` (the Kotlin WASM grammar + `tags.scm`, once at boot), `realpath`/`stat` to validate
  a path being registered as a repo, `readdir` to list directories for the repo picker, and
  `existsSync`. There is no `writeFile`, `unlink`, `rm`, `rename`, or `mkdir` anywhere in
  `packages/backend` or `packages/shared`.
- That directory listing (`GET /api/browse`, `packages/backend/src/browse.ts`) is confined to a
  **browse root** — `CCD_BROWSE_ROOT`, defaulting to `$HOME` — and returns **directory names
  only**. Never file names, never file contents, sizes, or timestamps; entries starting with `.`
  are skipped, and symlinked directories are excluded outright so a listing can't dangle a path
  out of the sandbox. The requested path and the root are both `realpath`'d *before* they are
  compared, which is what stops a symlink from escaping the root.
- `POST /api/repos` is the only way a browser can choose which directory git runs in, and it
  applies the same containment check — after canonicalizing the path to its repository toplevel
  via `git rev-parse --show-toplevel`, so an allowed-looking subdirectory of a repo that lives
  outside the browse root is rejected too. `REPO_ROOT` bypasses this check by design: it is
  supplied by whoever starts the process, not by the browser.
- Monaco's diff editor is created with `readOnly: true` (`packages/frontend/src/diff.ts`), so
  the UI itself can't be typed into either.
