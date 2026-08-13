# CtrlClickDiff

A local, read-only commit reviewer that keeps go-to-declaration *inside* the diff. Pick a commit —
or several — see every changed file stacked in one scroll, and **Ctrl+click any symbol (Cmd on
macOS) to open its declaration in a peek widget right inside the diff**, whether it is declared in
the same file or another one. Esc puts you back. Nothing opens in a separate tab, so you never lose
your place in the review.

![Ctrl+clicking (Cmd on macOS) shout in Main.kt peeks fun shout from Utils.kt, inline in the diff](docs/screenshot-peek.png)

Declarations are resolved **at the revision you are reviewing**, and resolved by name over your own
code: no overload resolution, no following imports, no jumps into the standard library or
dependencies.

## Supported languages

Kotlin `.kt` · TypeScript `.ts` `.tsx` · JavaScript `.js` `.jsx` `.mjs` `.cjs` · Python `.py` ·
Java `.java` · Go `.go` · Rust `.rs` · C `.c` · C++ `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.h` ·
C# `.cs` · Ruby `.rb`

Eleven languages, twelve prebuilt tree-sitter grammars shipped as WebAssembly under `vendor/` — so
**no native toolchain is needed**, no JDK and no compiler. The list is closed and lives in one file,
`packages/shared/src/languages.ts`. Ctrl+click (Cmd on macOS) never follows a reference across
languages.

## Requirements

Node **22.x** (pinned in `.nvmrc`), pnpm **11 or newer**, git **2.31 or newer**, and any modern
Chromium or Firefox — it is a local web app. Linux or macOS; Windows via WSL, since `start.sh` is a
bash script.

## Install and run

```bash
pnpm install
./start.sh                       # start empty; pick a repo in the app
./start.sh ~/path/to/your/repo   # or open that repo on first load
```

Then open <http://localhost:5173>.

`start.sh` brings up both halves — the backend on `:5178` and the Vite dev server on `:5173` — waits
until the backend is listening, and stops both together on Ctrl+C. Run `./start.sh --help` for its
options. There is **no build step**; the backend runs TypeScript directly.

To drive the two processes yourself instead:

```bash
REPO_ROOT=/path/to/your/repo pnpm dev:backend   # terminal 1
pnpm dev:frontend                               # terminal 2
```

`REPO_ROOT` is optional in both forms — it only names the repo to open on **first load**. Repos,
branches and commits are all switchable inside the app.

To try it against something throwaway, the repo ships a generator for two sample repos:

```bash
bash fixtures/make-sample-repo.sh   # creates ~/ccd-sample-repo and ~/ccd-sample-repo-2
./start.sh ~/ccd-sample-repo
```

Then: newest commit → click `Main.kt` → **Ctrl+click `shout`** (**Cmd+click** on macOS). It peeks `fun shout` from
`Utils.kt` — a different file, inside the diff. That is the screenshot above.

## Using it

The header is a breadcrumb of what you are reviewing — **repo › branch › commit(s)** — and each chip
opens a picker: a sandboxed directory browser for repositories, a grouped branch list, and a
searchable commit palette. Everything the selection changed is then stacked in one continuous
scroll, unchanged regions folded away, with a sidebar tree that scrolls you to a file.

![Every changed file stacked in one scroll, unchanged regions collapsed](docs/screenshot-wide.png)

| Do this | To get this |
|---|---|
| **Ctrl+click** a symbol (**Cmd** on macOS) | peek its declaration inline, in the diff |
| **Esc** | close the peek, back to where you were |
| **F12** | scroll to the declaration, if the selection changed that file |
| **Type** in a palette | filter — commits match on sha, subject *and* author |
| **Split / Inline**, **Wrap lines**, **Collapse unchanged** | change how the diff renders, live |

### Reviewing several commits at once — "ghost squash"

![The commit palette, searchable, with the ghost-squash toggle](docs/screenshot-commit-palette.png)

Flip **Ghost squash** in the commit palette and it becomes a multi-select: read several commits as
one diff, and skip commits out of the middle of a range — a docs-only commit simply disappears from
a review of the code around it. Each file's diff runs from before the earliest selected commit that
touched *that file* to after the latest one that did, which is what makes skipping exact.

The one case that cannot be exact: a file edited by **both** a selected and a skipped commit has no
two-revision representation, so the skipped edits are unavoidably in that file's diff. Those files
are marked **⚠**, with the commits responsible named by subject. A changed file is never silently
dropped from a review.

## Review from an agent, and deep links

Every review has a URL, and the address bar always holds the current one — copy it and whoever opens
it sees the same review:

```
http://localhost:5173/?path=<absolute repo path>&ref=refs/heads/<branch>&shas=<sha>,<sha>
```

Only `path` is required; `ref` and `shas` fall back to the branch HEAD is on and its newest commit.
The repository is named by path rather than by id, because the backend's registry lives in memory
and a path always re-registers to the same repo. A link whose repository the backend refuses reports
why and stops — it never quietly opens a different one.

A coding agent that just finished an iteration can build that link and open the review of its own
commits:

```bash
node tools/ccd-review.mjs
```

It works out what the iteration committed, registers the worktree, prints the URL and opens it — as
a tab inside [Orca](https://github.com/stablyai/orca)'s embedded browser when running under Orca, in
your desktop browser otherwise. Exit **0** means the review is open, **2** that the iteration left no
commits, **1** a real failure. Flags: `--base=<rev>`, `--shas=a,b`, `--no-open`, `--json`. Installing
`tools/ccd-session-start.sh` as a `SessionStart` hook records where HEAD was when the session began,
which is what sharpens "this iteration" on a long-lived branch; under Claude Code,
`.claude/skills/open-review/` is what tells the agent to run the opener.

Worktrees have to sit inside `CCD_BROWSE_ROOT` (default `$HOME`); Orca's own live under
`~/orca/workspaces`, so that works out of the box.

## Configuration

All optional, all environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `REPO_ROOT` | *(none)* | Repo to select on first load. Unset, you pick one in the app. |
| `CCD_BROWSE_ROOT` | `$HOME` | The only directory tree the repo picker may browse or register from. |
| `PORT` | `5178` | Backend port. |

`CCD_BROWSE_ROOT` is a **sandbox, not a convenience**: it bounds what the browser can reach on your
filesystem. `REPO_ROOT` deliberately ignores it — that one is typed by whoever starts the process.

> **Note on `PORT`:** the Vite dev proxy targets `127.0.0.1:5178` literally
> (`packages/frontend/vite.config.ts`). If you change `PORT`, change that target too, or `/api`
> calls will not reach the backend. `start.sh` warns you when the two disagree.

## Troubleshooting

**`start.sh` says something is already listening on :5178.** An earlier backend is still running —
`tsx watch` does not always die with the `pnpm` process that started it. Find it with
`lsof -i :5178` and kill it.

**Ctrl+click does nothing.** Resolution is name-based over your own code at that revision, in a
supported language. If the symbol *is* declared in a source file in the same repo and nothing
happens, check you are holding Ctrl (Cmd on macOS) — a plain click just moves the cursor.

**On macOS, use Cmd — Ctrl+click opens a context menu.** macOS turns Ctrl+click into a secondary
click before the page ever sees it, so it can only ever raise the menu. Cmd+click is the gesture
there, and Cmd+hover is what underlines a symbol that has a definition. If *neither* underlines
anything the lookup is failing rather than the key: check the backend's log for a `[resolver]` line
on each attempt.

## What it deliberately does not do

- **Eleven languages, and it is a closed list.** Adding one means vendoring a grammar, authoring a
  tags query and adding a smoke sample.
- **Not semantically accurate.** Resolution is by name; it tells you when a name is ambiguous.
- **No editing, staging or committing.** It is a reviewer, not a git client.
- **No auth and no remote access.** It binds to `127.0.0.1` and assumes one trusted local user.
- **No light mode, no find-references or rename, no desktop packaging.** Two dev processes and a
  browser tab.

## Read-only, mechanically

This is a **guarantee, not an aspiration**. Every git call goes through one function
(`packages/backend/src/git.ts`'s `run()`) using `execFile` with an **argument array, never a shell
string**, and the only subcommands invoked anywhere are `log`, `rev-parse`, `for-each-ref`, `show`
and `grep` — nothing that can move a ref or touch your working tree. The backend has no
write-capable filesystem call at all: its entire surface is `readFile`, `realpath`, `stat`,
`readdir`, `existsSync` and `fs.watch`. Monaco's editors are constructed `readOnly: true`. A ghost
squash synthesises nothing — both sides of every file's diff are revisions that already exist in
your object database. Directory browsing is confined to `CCD_BROWSE_ROOT`, on realpath'd paths, and
returns **directory names only**: never file names, contents, sizes or timestamps.

## Changing it

```bash
pnpm typecheck                      # tsc --noEmit, strict, all three packages
pnpm smoke                          # asserts every registered grammar loads with a matching ABI
bash fixtures/make-sample-repo.sh   # regenerate the fixture repos
node tools/verify-deeplink.mjs      # the deep-link contract, in a real browser (app must be running)
```

There is **no test runner** — behaviour is verified in a real browser, because most of what matters
here (peek rendering inside a diff, region auto-expansion on a jump, drag-resize relayout) has no
meaningful assertion outside one.

**If you are going to change this code, read [`CLAUDE.md`](CLAUDE.md) first.** It is a short index
over [`docs/internals/`](docs/internals), one file per subsystem, which record the constraints that
look arbitrary and are not, the bugs that have already been fixed once, and the reasoning behind
decisions a reasonable person would otherwise undo. `TO-DOS.md` tracks anything still open.
