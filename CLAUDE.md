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
packages/shared     git-types.ts (git wire shapes) repo-types.ts (registry + browse shapes)
                    types.ts (the SymbolResolver contract, documented on the interface)
packages/backend    Fastify. server.ts (routes) git.ts (all git) preview.ts (what a commit
                    selection means) repos.ts browse.ts watch.ts
                    resolver/TreeSitterResolver.ts (tree-sitter symbol index)
packages/frontend   Vite + Monaco. shell.ts (all UI state) band.ts (the review column)
                    diff.ts (one file's editor) defprovider.ts api.ts
                    topbar.ts (breadcrumb + view toggles) commitpalette.ts branchpalette.ts
                    filetree.ts repopicker.ts live.ts theme.ts
                    modal.ts (backdrop/aria/Escape for all three dialogs)
                    storage.ts (the one guarded localStorage) resizer.ts (the sidebar seam)
                    ALL CSS is inline in index.html
vendor/             prebuilt tree-sitter-kotlin.wasm (no upstream prebuild exists)
fixtures/           make-sample-repo.sh — generates the two test repos
docs/               README screenshots + capture-screenshots.mjs, which regenerates them
m1-spike/           throwaway CDN spike, kept as historical evidence. Not built or tested.
start.sh            runs both halves in one terminal; the launcher the README leads with
```

`shell.ts` is the spine: it owns every piece of frontend state and nearly every change touches
it. New logic belongs in its own module with a small interface, so `shell.ts` gains a call site
rather than another screenful. The header, both palettes, the repo picker and the sidebar
resizer each follow that rule — `topbar.ts` in particular knows nothing about repos, branches
or commits, because its interface is `setCrumbs(Crumb[])` and a crumb is only a label, a
tooltip and a click handler. The rule applies to what is *already* in `shell.ts` too: the
resizer lived at its foot for a long time behind a comment claiming self-containment, and
moving it to `resizer.ts` is what made a module boundary enforce the claim.

The unit of review is a **selection of commits**, not a commit. One commit selected is the
ordinary case; several is a "ghost squash" (see below). There is deliberately no second code
path for the single-commit case — `Preview` describes both.

The unit of *display* is the whole selection at once: `band.ts` stacks every changed file in one
scroller, one diff editor per file, and `diff.ts` makes those editors rather than owning one.
Nothing shows a single file any more, which is why `openFile` became `revealPath` — a click scrolls,
it does not load.

## Verification

There is **no test runner** and adding one has been deliberately deferred. What exists:

```bash
pnpm typecheck                      # tsc --noEmit, strict, all 3 packages
pnpm smoke                          # asserts the Kotlin WASM loads with a matching ABI
bash fixtures/make-sample-repo.sh   # regenerates both fixture repos
node docs/capture-screenshots.mjs   # regenerates the README screenshots (app must be running)
```

`docs/capture-screenshots.mjs` is a worked example of everything in the two paragraphs below —
it drives the repo picker, both palettes and a real Ctrl+click peek, and asserts on
`.zone-widget` and on the palette closing. Read it before writing a new CDP check. It also
exists because **the screenshots went stale silently**: the Primer dark theme and the breadcrumb
header shipped while the README still showed a light Monaco and a `<select>` sidebar, and nothing
caught it because an image cannot fail a typecheck. Re-run it after anything that changes the
chrome. It selects `ccd-sample-repo` itself rather than trusting `REPO_ROOT`, so whatever repo
the backend booted with cannot leak into a committed image.

Behaviour is verified **in a real browser**. Most of what matters here — peek rendering inside
a diff, region auto-expansion on a jump, drag-resize relayout — has no meaningful assertion
outside one. Drive Chromium over CDP; Node 22 has a global `WebSocket`, so this needs no
dependencies. Note snap-confined Chromium needs `--no-sandbox` and a profile dir it can reach —
and `~/.cache` is **not** one of them: it fails to create `SingletonLock` and aborts before the
debugger ever binds, so the failure looks like "chromium never came up" rather than a permission
error. Use a `mkdtemp` under `~/snap/chromium/common/`.

Two CDP details that cost time: a poll that straddles a `Page.reload` rejects with *"Inspected
target navigated or closed"*, which is normal and must be swallowed rather than treated as a
failure; and a modal driven by two separate `Runtime.evaluate` round trips is not the same test
as one driven by a single evaluate — an in-flight fetch can land in the gap and repaint what you
were about to click. Where a race is the thing under test, do the whole gesture in one evaluate.

**Peek can only be tested by the gesture.** `editor.getAction('editor.action.revealDefinition')`
returns **null** in this standalone Monaco build — the only definition-ish action it registers is
`showDefinitionPreviewHover`. Peek comes from `definitionLinkOpensInPeek` plus a real Ctrl+click,
so a CDP test must compute the word's viewport position
(`editor.getScrolledVisiblePosition()` plus `getDomNode().getBoundingClientRect()`) and dispatch
`Input.dispatchMouseEvent` with `modifiers: 2` — a `mouseMoved` first, which is what makes Monaco
resolve and underline the link, then the press/release. Assert on a `.zone-widget` appearing.
Testing an action id instead passes vacuously and proves nothing.

**Do not `import()` a frontend module from the CDP console to test it.** Vite serves HMR-updated
modules under a `?t=<stamp>` URL, so a fresh `import('/src/api.ts')` can hand back a *second*
instance with its own module state — `api.ts`'s `pathById` comes up empty and the 409 recovery
appears broken when it is not. Drive the real UI and let the app's own instance do the work.

**Three ways a CDP check silently measures the wrong thing now that every file has an editor**, all
three of which produced a confident false failure while building the band:

- **Waiting on `.view-line` (or `.ccd-card`) is not waiting for the file you mean.** A card exists
  for every changed file the moment the preview lands but is empty until its editor mounts, and cards
  mount lazily — so "lines are on screen" no longer implies *these* lines are. Wait on
  `.ccd-card[data-path="X"] .monaco-diff-editor`.
- **`window.__ccd.modifiedEditor` answers for the card at the top of the scroller**, which during a
  jump is not the destination. Measuring a reveal through it reported the cursor on line 1 of a
  different file. Measure inside the target card's own DOM.
- **A side-by-side card has TWO `.cursors-layer`s**, and `card.querySelector` returns the
  *original* pane's. Its cursor sits wherever the alignment view zones put it — that read as "the
  cursor landed on line 61" for a jump to line 100 that was in fact exactly right. Scope to
  `.editor.modified`.

The same trap in the other direction: **an assertion that passes because the fixture is too small
proves nothing.** `feature/wide` cannot demonstrate bounded mounting (see the constraint below), and
the three-file default selection cannot demonstrate centred reveal because its content is shorter
than the viewport and `scrollTop` cannot move at all. Check what the numbers *can* show before
believing them.

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
passed to `createDiffEditor`. The M1 spike proved they do not propagate from the option bag. An
editor built without them looks completely normal and simply never peeks — no error, nothing wrong
on screen, the one feature this tool is named after silently gone.

Editors are now created and disposed routinely, as cards scroll in and out of reach, so what keeps
that safe is that **`createFileDiff` is the only place `createDiffEditor` is called.** Keep it that
way; the guarantee is structural, not a habit. The side-by-side/inline toggle still goes through
`updateOptions` (now over `liveEditors`) and must keep doing so, and `viewOptions()` is *also*
spread into the construction bag — that is what makes a card mounted after a toggle come up in the
new mode instead of the stored one.

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
scroll against a layout that is about to move. Measured, not argued: on a collapsed 121-line file
`getTopForLineNumber` answers with the top of the *fold*, so lines 1 and 2 report identical tops and
a line-height probe there reads **0**. Measure after the cursor has expanded the region, never
before.

**`IDiffEditor` has no `onDidContentSizeChange`.** It extends `IEditor`, not `ICodeEditor`
(`monaco.d.ts:6410`), so a card's auto-height has to subscribe to *both inner* editors — which are
`ICodeEditor`s and do have it (`monaco.d.ts:6107`) — and take the max of their content heights.
Side-by-side pads the shorter pane with alignment view zones while inline carries the deletions as
view zones on the modified side; one of the two is always the full height and neither is always the
one.

**`getContentHeight()` does account for lines hidden by `hideUnchangedRegions`** — 1037px collapsed
against 3136px expanded on the same 121-line file — which is what lets it drive a card's box.
**`scrollBeyondLastLine: false` is not cosmetic there:** 837px of that 3136px was trailing viewport
padding (856px pane − 19px line height, exactly), so with it on every card would end in a screenful
of nothing *and* the height sync would recurse, because content height would then depend on viewport
height.

**What lets the wheel reach the outer scroller is `alwaysConsumeMouseWheel: false`,** not
`handleMouseWheel: false`. The former defaults to **true**, and on true Monaco swallows a wheel
event it cannot use rather than letting it bubble. Both are set; only one is the interesting half.

**A card freezes its measured height before disposing its editor, and models are never disposed.**
That pair is the whole reason scrolling is stable and cheap: the frozen box means nothing below an
unmounted card moves (measured drift 0px over seven samples; total content height held at 16410px
across a full round trip), and the surviving models mean coming back costs no request at all
(`/api/file` calls: 28 before a full descent-and-return, 28 after). Monaco guarantees the second
half — a model handed over via `setModel` rather than the construction bag survives the editor's
disposal.

**`revealLineInCenter` is unusable in the band** and `revealLine` is gone with it. A card's editor
is exactly as tall as its content, so it has no scroll room to move; the *outer* scroller does the
centring, from `getTopForLineNumber` plus the card's offset. A jump to `LongService.kt:100` puts the
cursor at 428px of an 856px viewport.

**Lazy mounting is bounded by the viewport, not the selection, and the fixtures cannot show it.**
`/api/preview` caps commits (`COMMIT_LOG_LIMIT`) and nothing caps files. `feature/wide`'s 12 cards
are ~3240px of content against a mount window of viewport + 2×1200px ≈ 3256px, so every card
legitimately stays mounted there and "bounded" is indistinguishable from "broken" — a real 28-file
selection is what proves it (peak 7 of 28, tracking the viewport up and down).

**`switchRepo` clears the outgoing repo's state BEFORE `adoptRepo`, and the order is the point.**
`adoptRepo` sets `repo` and calls `renderTrail()` **synchronously**, and `renderTrail` decides
which crumbs exist by reading `branches`/`selectedRef`/`commits`/`selection`. Clearing after it
paints the new repository's name beside the previous one's branch and commit selection, and
nothing repaints until `loadBranches` returns a round trip later. Measured over CDP with 1500ms
of emulated latency, switching from a repo parked on `feature/wide`: the header read
`["ccd-sample-repo-2", "feature/wide", "4221baf · …"]` where it should read one crumb. Note the
stale crumbs cannot leak an old refname into a new-repo request — everything is cleared in the
same synchronous turn, so a click in that window opened a palette of 0 rows — but a crumb that
opens an empty palette is the affordance-that-lies hazard `renderTrail` already guards against
for the selection crumb.

**`modelUri` and `parseModelUri` are an inverse pair and live together in `diff.ts`.** Splitting
them (the parse used to sit in `defprovider.ts`) makes the segment layout a two-file edit whose
half-done version fails **silently at runtime** — cross-file peek just stops rendering — and
never at typecheck. Same reasoning as `initResizer` reading its clamp bounds back from CSS
instead of retyping them.

**`COMMIT_LOG_LIMIT` is exported from `git.ts` and is the selection cap too.** A selection is
assembled out of commits the picker listed, so the log's page size *is* the ceiling
`/api/preview` enforces. These were two independent literal `100`s tied together only by a
comment; raising one without the other would have silently offered commits a selection was not
allowed to name.

**Do not watch `.git` recursively.** On Linux that is one inotify watch per subdirectory and
`.git/objects/` alone is 256 fanout dirs. `watch.ts` uses two narrow watchers (the git common
dir, plus `refs/` recursively) and dedupes with a change token so `.git/index` churn is silent.

**Vite's dev proxy does not propagate upstream death.** A stream read directly errors ~2.5s
after the backend dies; through the proxy it stays open 20s+ with no `error` event. That is why
the SSE heartbeat is a named `ping` event and not a `: ping` comment — EventSource never
surfaces comments to script, so a comment gives the client nothing to time out against.
`live.ts` runs a silence watchdog on it.

**`start.sh` runs `set -m` so each half is its own process group, and that is the whole reason
it exists.** Signalling the `pnpm dev:backend` wrapper alone does not reliably take its
`tsx watch` child — or the backend that child spawned — with it, so the orphan keeps :5178 bound
and the next start either fails to bind or, worse, looks fine while serving the old code. With
job control on, `$!` *is* the process group id (grandchildren inherit it, measured), so
`kill -- -$!` reaches the whole tree. Two consequences worth knowing before editing it: the
script waits for the port rather than printing a URL, because the backend loads the Kotlin WASM
and registers `REPO_ROOT` *before* it listens and both are fatal on failure; and Ctrl+C is
handled by a trap that `exit`s rather than falling back into the script, so the "exited on its
own" message stays true. Testing that trap needs a **real PTY** — bash sets SIGINT to `SIG_IGN`
for a job started with `&` from a shell without job control, and a signal ignored on entry
*cannot be trapped*, so backgrounding `start.sh` from a test script silently disables the very
handler under test and it hangs forever instead. SIGTERM is not ignored and is the cheap check.

**`PORT` is not fully wired, on purpose-for-now.** `packages/frontend/vite.config.ts` hardcodes
the proxy target `127.0.0.1:5178`, so setting `PORT` moves the backend out from under the
frontend. `start.sh` warns when the two disagree rather than silently "fixing" it, and the README
says so. Making `PORT` real means teaching the Vite config to read the environment — a separate
change, not a drive-by.

**No raw control bytes in source.** Three files have now had to be repaired: a literal NUL in
a template literal makes git classify the file as *binary*, so `git diff` and `grep` stop
working on it. Write the escape sequence (`\u0000`), never the byte. `grep` reporting
"binary file matches" on a `.ts` file is the symptom; this is the check, and it is worth
running before any commit that touched a template literal:

```bash
python3 -c "import io,glob;print([p for p in glob.glob('packages/**/*.ts',recursive=True) \
  if any(c<9 or (10<c<32 and c!=13) for c in io.open(p,'rb').read())] or 'clean')"
```

**`--not` is rejected after `--end-of-options`; `^<sha>` is not.** Both exclude commits from a
`git log` walk, but only the caret form is *revision* syntax — `--not` is an option, and
everything after `--end-of-options` is by definition not one (`fatal: bad revision '--not'`).
`commitSpan` needs both the fence and the exclusion, so it uses `^<sha>`.

**`git log --name-status` prints no files at all for a merge commit** unless
`--diff-merges=first-parent` (git >= 2.31) is passed. Without it a selected merge silently
contributes nothing to a preview, and an unselected one is never spotted as a source of leaked
edits — "invisible" is the wrong default for a review tool. First-parent because that is the
"what did this bring onto the branch" side, which is the question a reviewer is asking.

**`git log --no-walk` sorts a set of commits rather than walking history**, and fails the whole
invocation on the first unknown SHA. That is two jobs in one call — `orderCommits` uses it both
to put a selection in newest-first order and to prove every commit in it exists, so a stale tab
after a force-push produces one clean rejection instead of a preview computed from the
survivors. It is `log` and not `rev-list` purely to keep the permitted-subcommand list short.

## Decisions worth not undoing

- **A preview's revision pair is per FILE, not per selection.** For each path,
  `base = first parent of the earliest selected commit that touched it`, `head = the latest
  selected commit that touched it` (`preview.ts`). This is the whole reason commits can be
  skipped out of the middle of a range: everything the selection did to a path happened between
  those two points, so a path only unselected commits touched vanishes from the review, and a
  path an early selected commit touched is shown as *that* commit left it. A single span shared
  by every file would drag every unselected commit's edits into files the selection merely
  brackets — the docs-only commit would still be visible in the code files it never touched.
- **Both sides of a preview are revisions that already exist.** That is what keeps `/api/file`,
  the tree-sitter index and Ctrl+click peek ignorant of the whole feature — they take a rev and a
  path, and a preview hands them revs they already understand. Synthesising a tree for a
  selection would need `git merge-tree --write-tree`, which **writes objects into
  `.git/objects`** and would end the read-only guarantee. Do not reach for it.
- **A file touched by both a selected and a skipped commit is shown, and marked.**
  `A -> (unselected edit) -> A'` has no two-SHA representation, so those edits are unavoidably in
  that file's diff. `PreviewFile.skippedShas` names the commits responsible and both the sidebar row
  and the file's own card header get a ⚠ whose tooltip lists them by subject. On the card as well as
  the row because that is where the reader *is* when they wonder why a diff contains an edit the
  selection does not explain. Hiding the file instead would drop a changed file from a review, which
  is the same hazard that keeps tree-collapse state out of localStorage. Naming rather than counting
  is deliberate: a count says something is off without saying what to do about it.
- **Live refresh follows the tip only from a selection of ONE that is the tip.** A multi-commit
  selection is a deliberate act, and "the tip moved" says nothing about whether the new commit
  belongs in a set assembled by hand. The single-commit rule is unchanged and has its own
  reasoning in `refreshRefs`.
- **The two palettes still do not share a palette abstraction — but all three dialogs share a
  modal shell.** The distinction is the whole point. `modal.ts` owns the backdrop, the labelled
  `role=dialog` panel, the click-outside guard and the capture-phase Escape handler, and it
  handles Escape then hands every other key straight through. It owns **nothing** else: no row
  renderer, no search projection, no group predicate, no footer slot, and deliberately not the
  active index, the clamp or the scroll-into-view either — sharing those would need the shell to
  know each palette's `visible.length` and to call back into its renderer. The rows are still
  different shapes, the searches still match different fields, and choosing still means different
  things (a selection that may hold several commits, against a single ref).
  What triggered extracting the shell was not a third palette but a third *modal* (the repo
  picker) plus evidence the duplication had stopped being harmless: the three hand-written copies
  had drifted, two capturing Escape and consuming it while `repopicker.ts` bubbled and did not.
  The revisit trigger for the palette itself is unchanged — a **third palette**. The full
  argument, amended rather than replaced, is at the foot of `branchpalette.ts`.
- **One guarded `localStorage`, and it is guarded because the property access itself throws.**
  `storage.ts` is the only file that touches the API; in some privacy modes referencing
  `localStorage` raises a SecurityError before `getItem` is ever reached, so the access must be
  *inside* the try. It exports exactly `readStored`/`writeStored`/`removeStored`, all string-typed.
  Do not add `readNumber` or `readJson<T>(key, guard)`: each would have one caller and would drag
  that caller's decision into everybody's module — the resizer's blank-string guard exists so
  corrupt storage falls back to the *stylesheet* default rather than to 220px, and the recents
  validator exists because an older shape of this app may have written that key. Keys stay at
  their call sites, beside the value they name; `storage.ts` knows none of them.
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
- **Async entry points claim an epoch, and the band needs two levels of it.** `shell.ts` has one
  for the load chain (repo → branches → commits → preview). `band.ts` has its own, bumped by
  `render()`, **plus a token per card** bumped whenever that card stops wanting an editor. Both
  halves are load-bearing: a selection can change while a dozen mounts are in flight, and
  independently, a single card can be scrolled past while its own mount is still fetching. A mount
  that resolves against either a stale epoch or a stale token disposes its editor instead of
  adopting it — an orphan would keep laying itself out. This is where `diff.ts`'s old single
  `diffEpoch` went; same argument, at the granularity a column of independent editors needs. A stale
  call must also stay silent — the epoch holder owns the status line.
- **The sidebar follows the reader, not the other way round.** `activePath` is *reported by* the
  band from what is at the top of the scroller, via an IntersectionObserver whose negative bottom
  root margin turns the top 15% of the column into the "being read" zone. That is deliberately the
  whole mechanism: no scroll listener, no rAF throttle, and no measuring every card every frame,
  which on a several-hundred-card band is the difference between free and a forced layout per frame.
  When the zone lands in a gap between cards there is no candidate, and keeping the previous answer
  is correct — the reader has not moved to another file.
- **Per-file collapse is in memory only**, for exactly the reason tree-collapse state is: a stale
  persisted fold can hide a changed file from a review.
- **A cross-file jump to a file the selection did not change says so.** It has no card, so
  `revealPath` puts a message in the status line rather than doing nothing. The peek widget has
  already rendered that definition inline — it builds its own inner editor from the model
  `defprovider.ts` created — so the reader is not stuck. Worth knowing what the old single-editor
  view did here before reviving it: it fell back to the selection's span, whose two ends hold
  identical content for an untouched file, so it navigated to a diff of a file against itself with
  every line folded away.
- **Tree collapse state is in memory only.** A stale persisted collapse can hide a changed file
  from a review, which is a correctness hazard. Sidebar width *is* persisted; that is a
  preference, not a view of the data.
- **Light mode is out of scope**, and `api.prewarm` was deleted rather than revived. Auto-prewarm
  on commit select stays disabled — see the comment in `selectCommit`; on a large repo behind a
  blobless partial clone it triggers thousands of on-demand blob fetches.

## Read-only, mechanically

This is a guarantee, not an aspiration, and the README states it publicly — so re-check it when
you touch the backend. Every git call goes through `git.ts`'s `run()` with an **argument array,
never a shell string**. The only subcommands invoked anywhere are `log`, `rev-parse`, `ls-tree`,
`for-each-ref`, `show` — `diff-tree` left the codebase when `commitSpan` replaced the per-commit
`changedKtFiles`, and nothing should bring it back. There is no write-capable fs API in the
backend at all — the whole surface is `readFile`, `realpath`, `stat`, `readdir`, `existsSync`,
`fs.watch`. `listCommits` carries three redundant injection guards (leading-`-` rejection,
`--end-of-options`, trailing `--`) plus a route-level whitelist pattern; keep all of them.
`/api/preview` follows the same shape: `shas` is whitelisted at the route as
`^[0-9a-f]{40}(,[0-9a-f]{40})*$` before it can reach git's argv, and capped at 100 entries.

## Commits

One concern per commit; refactors land separately from features. Conventional-commit subject,
then prose explaining **why**, naming concrete files and symbols. Review `git diff --cached`
before committing — and stage by explicit path, never `git add -A`.
