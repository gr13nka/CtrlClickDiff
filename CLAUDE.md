# CtrlClickDiff — working notes

Read-only Kotlin commit reviewer. `README.md` explains what it is and how to run it; this file
is for changing it. It records the things that cost time to rediscover — the constraints that
look arbitrary, the bugs that have already been fixed once, and the reasons behind decisions
that a reasonable person would otherwise undo.

## Shape

pnpm workspace, Node 22, ESM everywhere, TypeScript run directly by `tsx` — **the backend has
no build step**, and `packages/shared` is consumed as raw `.ts` source (`"exports": "./src/index.ts"`).
`tsconfig.base.json` sets `noEmit`, so `tsc` is purely a checker here.

```
packages/shared     wire types + the SymbolResolver contract
packages/backend    Fastify. server.ts (routes) git.ts (all git) repos.ts browse.ts watch.ts
                    resolver/TreeSitterResolver.ts (tree-sitter symbol index)
packages/frontend   Vite + Monaco. shell.ts (all UI state) diff.ts defprovider.ts api.ts
                    filetree.ts repopicker.ts live.ts theme.ts; ALL CSS is inline in index.html
vendor/             prebuilt tree-sitter-kotlin.wasm (no upstream prebuild exists)
fixtures/           make-sample-repo.sh — generates the two test repos
m1-spike/           throwaway CDN spike, kept as historical evidence. Not built or tested.
```

`shell.ts` is the spine: it owns every piece of frontend state and nearly every change touches
it. New logic belongs in its own module with a small interface, so `shell.ts` gains a call site
rather than another screenful.

## Verification

There is **no test runner** and adding one has been deliberately deferred. What exists:

```bash
pnpm typecheck                      # tsc --noEmit, strict, all 3 packages
pnpm smoke                          # asserts the Kotlin WASM loads with a matching ABI
bash fixtures/make-sample-repo.sh   # regenerates both fixture repos
```

Behaviour is verified **in a real browser**. Most of what matters here — peek rendering inside
a diff, region auto-expansion on a jump, drag-resize relayout — has no meaningful assertion
outside one. Drive Chromium over CDP; Node 22 has a global `WebSocket`, so this needs no
dependencies. Note snap-confined Chromium needs `--no-sandbox` and a profile dir it can reach.

When you fix a bug, **reproduce it first and record the numbers**. Several fixes in the history
would have been unfalsifiable otherwise — "the reveal is wrong" means nothing next to "it
scrolled to 1862px when the line was at 2622px".

## Constraints that look arbitrary and are not

**Monaco lowercases a URI's authority** in `Uri.toString()` (`vs/base/common/uri.js:546`), which
is what its model registry keys on. Model URIs are `file://<repoId>/<sha>/<path>`, so **repo ids
must match `^[a-z0-9][a-z0-9-]*$`** or a model is stored under one string and looked up under
another. `repos.ts` asserts this. The id is in the *authority* because an authority cannot
contain `/`, which is exactly why it is an opaque id rather than a path.

**`PEEK_OPTIONS` is applied with `updateOptions` to both inner editors after construction**, not
passed to `createDiffEditor`. The M1 spike proved they do not propagate from the option bag.
Anything that re-creates the diff editor silently kills Ctrl+click peek — this is why the
side-by-side/inline toggle uses `updateOptions` and must keep doing so.

**The four `diffEditor.*Background` colours must be translucent 8-digit hex.** Monaco registers
them `needsTransparency`; an opaque tint paints over selection and search highlights inside a
changed line. The word-diff tint is 10% rather than the 15% that reads best alone, because it
stacks on the line tint and the darkest syntax colour otherwise falls below WCAG AA (4.34:1).

**`diffEditor.unchangedRegionBackground` defaults to `sideBar.background`**, a workbench colour
standalone Monaco never registers. Unset, the collapsed-region bars render unstyled.

**`onDidUpdateDiff` is not "the diff is ready".** It is `Event.fromObservableLight` over the diff
model, so it fires on every transition including `result → undefined` during a `setModel`. The
readiness check is `getLineChanges() !== null`. Also: cursor move *before* reveal — it is
`onDidChangeCursorPosition` that expands a collapsed region, so revealing first computes a
scroll against a layout that is about to move.

**Do not watch `.git` recursively.** On Linux that is one inotify watch per subdirectory and
`.git/objects/` alone is 256 fanout dirs. `watch.ts` uses two narrow watchers (the git common
dir, plus `refs/` recursively) and dedupes with a change token so `.git/index` churn is silent.

**Vite's dev proxy does not propagate upstream death.** A stream read directly errors ~2.5s
after the backend dies; through the proxy it stays open 20s+ with no `error` event. That is why
the SSE heartbeat is a named `ping` event and not a `: ping` comment — EventSource never
surfaces comments to script, so a comment gives the client nothing to time out against.
`live.ts` runs a silence watchdog on it.

**No raw control bytes in source.** Two files have already had to be repaired: a literal NUL in
a template literal makes git classify the file as *binary*, so `git diff` and `grep` stop
working on it. Write the escape sequence (`\u0000`), never the byte.

## Decisions worth not undoing

- **Repo scoping is stateless.** There is no "current repo" on the server; every data route
  takes `?repo=<id>`. That is what removes cache invalidation, cross-tab interference, and the
  restart-to-switch problem in one move. The registry is an append-only *validated-path* store,
  not active-repo state.
- **`register()`'s validation order is the security property.** realpath → is-directory →
  `rev-parse --show-toplevel` → containment checked **on the canonicalized toplevel**. Checking
  containment on the input instead would let a caller name an allowed-looking subdirectory of a
  repo that lives outside the browse root. Both sides are realpathed; that is what defeats a
  symlink. `REPO_ROOT` skips the check on purpose — the trust boundary is the HTTP surface.
- **`/api/browse` returns directory names only.** Never file names, contents, sizes or mtimes.
  Symlinked directories are excluded outright (`Dirent.isDirectory()` is lstat-like).
- **The resolver holds one mutable field.** It used to keep an `activeRevision` slot that
  `resolve()` read, which made two concurrent `/api/def` calls answer from each other's index —
  observably, a phantom definition in a file that does not exist at that revision. `resolve()`
  now takes `(repoRoot, revision)` and is a pure function of its arguments. Do not reintroduce a
  "current" anything; if you need coordination, you have taken a wrong turn.
- **Async entry points claim an epoch.** `shell.ts` and `diff.ts` each have one, and they are not
  redundant: `openFile` only regains control *after* `createDiff` resolves, by which point
  `setModel` has already run. A stale call must also stay silent — the epoch holder owns the
  status line.
- **Tree collapse state is in memory only.** A stale persisted collapse can hide a changed file
  from a review, which is a correctness hazard. Sidebar width *is* persisted; that is a
  preference, not a view of the data.
- **Light mode is out of scope**, and `api.prewarm` was deleted rather than revived. Auto-prewarm
  on commit select stays disabled — see the comment in `selectCommit`; on a large repo behind a
  blobless partial clone it triggers thousands of on-demand blob fetches.

## Read-only, mechanically

This is a guarantee, not an aspiration, and the README states it publicly — so re-check it when
you touch the backend. Every git call goes through `git.ts`'s `run()` with an **argument array,
never a shell string**. The only subcommands invoked anywhere are `log`, `rev-parse`,
`diff-tree`, `ls-tree`, `for-each-ref`, `show`. There is no write-capable fs API in the backend
at all — the whole surface is `readFile`, `realpath`, `stat`, `readdir`, `existsSync`, `fs.watch`.
`listCommits` carries three redundant injection guards (leading-`-` rejection,
`--end-of-options`, trailing `--`) plus a route-level whitelist pattern; keep all of them.

## Commits

One concern per commit; refactors land separately from features. Conventional-commit subject,
then prose explaining **why**, naming concrete files and symbols. Review `git diff --cached`
before committing — and stage by explicit path, never `git add -A`.
