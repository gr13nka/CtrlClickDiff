# CtrlClickDiff — working notes

Read-only commit reviewer with Ctrl+click definitions. `README.md` explains what it is and how
to run it; this file
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
                    languages.ts (the language registry — 12 grammars behind 11 languages)
packages/backend    Fastify. server.ts (routes) git.ts (all git) preview.ts (what a commit
                    selection means) repos.ts browse.ts watch.ts
                    resolver/TreeSitterResolver.ts (grep for candidates, parse only those)
                    resolver/grammars.ts (grammar asset paths, keyed by grammar key)
                    resolver/tags/<key>.scm (one hand-authored declarations query per grammar)
packages/frontend   Vite + Monaco. shell.ts (all UI state)
                    band.ts (the review column — cards, plus the summary above them
                      and the empty state that replaces them)
                    diff.ts (one file's editor) defprovider.ts api.ts
                    peekscope.ts (the review, as seen by peek's candidate list)
                    peeklayout.ts (how much of the peek goes to the answer)
                    urilabel.ts (how a model URI is spelled out to a human)
                    monaco-internal.d.ts (types for the one monaco internal we import)
                    deeplink.ts (the review as a URL — parse and serialize, an inverse pair)
                    topbar.ts (breadcrumb + view toggles) commitpalette.ts branchpalette.ts
                    filetree.ts repopicker.ts live.ts theme.ts
                    modal.ts (backdrop/aria/Escape for all three dialogs)
                    storage.ts (the one guarded localStorage) resizer.ts (the sidebar seam)
                    ALL CSS is inline in index.html — except peekscope.ts's, and see below
vendor/             12 prebuilt grammar wasms + build-grammars.sh, provenance in vendor/README.md
fixtures/           make-sample-repo.sh — generates the two test repos
docs/               README screenshots + capture-screenshots.mjs, which regenerates them
tools/              ccd-review.mjs (what an agent runs at the end of an iteration) +
                    ccd-session-start.sh (the base it measures from) + verify-deeplink.mjs
.claude/skills/     open-review — the wrapper that makes an agent run the opener. No logic.
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
pnpm smoke                          # per-grammar matrix: every registered grammar loads, tags compile, sample captures
bash fixtures/make-sample-repo.sh   # regenerates both fixture repos
node docs/capture-screenshots.mjs   # regenerates the README screenshots (app must be running)
node tools/verify-deeplink.mjs      # the deep-link contract, in a real browser (app must be running)
```

`pnpm smoke` (`packages/backend/src/smoke.ts`) is one matrix over every registered grammar key, not
a single check: for each it loads the wasm, compiles its `tags.scm`, and parses a tiny sample,
asserting the capture names it promises actually appear. A registered language with no `SAMPLES`
row is itself a smoke failure, naming the language — a grammar nothing exercises can break, or ship
broken, without this ever noticing.

**Anything about how the diff *looks* has to be measured in a browser, and the fixture repos will
lie to you.** Their Kotlin lines are short enough to fit any pane, so the single largest problem in
the reading surface — every line of real code clipped at the pane edge — was invisible in all three
committed screenshots. Audit against a real repository (this one works: register it and deep-link a
few of its own commits) and read the numbers rather than the impression:

- `.view-line` truncation is **not** `scrollWidth`, which returns a 1e6 sentinel on a Monaco line.
  Measure where the line's last span actually ends against the scrollable viewport's right edge.
- `.editor.original` exists in the DOM in single-pane mode too — Monaco keeps both inner editors and
  collapses one — so its **width** is the question, never its presence.
- Wait for a `.line-insert`/`.line-delete` decoration, not just `.monaco-diff-editor`: the editor
  element exists before the diff is computed, and a screenshot taken in that window shows an
  undecorated file that looks exactly like a regression. This produced a confident false failure
  while auditing, on top of the three traps already listed below.
- `getComputedStyle` rounds alpha to 2dp (`0.1255` → `"0.13"`), so a contrast check reading colours
  back from the DOM is slightly pessimistic against the 8-digit hex the theme declares.
- **Do not pass `--hide-scrollbars` to a Chromium you are auditing with.**
  `docs/capture-screenshots.mjs` passes it so the committed images stay stable, which is right for
  that job and wrong for every other one: it meant nothing that ever looked at this app rendered a
  scrollbar, and an unstyled 15px native bar sat down the edge of the band unnoticed. It also makes
  the review column 15px wider than it really is, so pane widths measured under it are optimistic.

The blur and greyscale passes are the ones that catch misallocated weight, and they are worth more
here than any single ratio: blur the screenshot and the dominant shape must be the changed lines.

**Ctrl+click latency has a recorded baseline; beat it or explain why.** Measured against
`~/lets-plot` (2646 `.kt`, 9.6 MB, blobless clone), backend at `REPO_ROOT=~/lets-plot`, one
`/api/def` per identifier from `AestheticsUtil.kt` at `44db1f1a`:

| | whole-revision index | grep-scoped, cold | warm |
|---|---|---|---|
| `PlotSvgExport` (7 candidate files) | 11.56 s | 0.067 s | 0.040 s |
| `render` (60 candidates, 45 hits) | 11.56 s | 0.337 s | 0.032 s |
| `letsPlot` (a package segment) | 11.56 s | 0.230 s | 0.034 s |
| a word that is not a symbol | 11.56 s | 0.031 s | 0.029 s |
| RSS after one revision | +353 MB | +32 MB | |
| RSS after a second revision | +319 MB | **+0 MB** | |

End-to-end in a browser (mousePressed → `.zone-widget`) that is **51–100 ms**, including a
45-definition peek. The warm column is the one trade: it used to be 0.001 s off a resident index,
and the grep now runs every time. 30 ms is imperceptible in a gesture and it is what buys the
bounded memory.

**Boot now loads twelve grammars instead of one, and the cost is bounded.** Three runs each:
kotlin-only boot ~670 ms → all 12 grammars ~875 ms (resolver init 61 ms → 251 ms), against a
self-imposed budget of +1 s. RSS after boot: ~141–147 MB → ~186–194 MB. The vendor wasms add up to
≈25 MB on disk, each read once at boot and never again.

**The Kotlin numbers above still hold, and re-measuring is what proves the multi-language work
didn't touch the resolve path.** Re-run against a fresh blobless `~/lets-plot` clone at `4e92397b`
(the original `44db1f1a` is no longer reachable upstream; 2723 `.kt` files against the original
2646 — the repo grew in between): `PlotSvgExport` 86 ms cold / 53 ms warm (7 candidates), `render`
330 ms / 41 ms (52 candidates, 45 hits), `letsPlot` 298 ms / 44 ms, a non-symbol word 45 ms / 42 ms.
That matches the recorded table within repo growth and run-to-run noise. Kotlin still has exactly
one `LANGUAGES` row, so `siblings` resolves to `[kotlin]` and the single-entry path is unchanged by
the sibling-scoping added for `.ts`/`.tsx` — proven bit-identical, not just similar: the same
resolver log line, byte for byte, before and after the siblings change landed.

**The per-resolve log is the first thing to look at when a click feels slow**, and it is why the
license-header case was found at all:

```
[resolver] render in 89ms (grep 42ms -> 51 candidates, 44 cached, parse 47ms) -> 45 hits
```

A high candidate count means the identifier really is everywhere (check the line filter above); a
high `cached` next to a high parse time means the cache is thrashing and `FILE_SYMBOL_LIMIT` is
below the candidate set; a grep far above a few tens of ms on a partial clone means a lazy blob
fetch, i.e. the network rather than this code.

The fixtures carry cases that only exist to be verified, and deleting one silently removes the
only way to see a behaviour fail. Repo B's **`feature/scoped-defs`** is the newest: `render` is
declared in both `near/Label.kt` and `far/Label.kt` and called from `near/Caller.kt`, arranged so
that selecting only its second commit leaves the *nearer* of the two definitions outside the
review — which is the one Monaco's peek prefers on its own. Nothing else in either repo can show
Ctrl+click choosing between an in-review and an out-of-review candidate.

Repo A's **`feature/polyglot`** is the only branch in either fixture repo that is not all-Kotlin,
and it is the only place three things can be shown. **A mixed-language preview**: one selection,
four cards, four different Monaco languages (`tools/report.py`, `web/render.ts`, `web/App.tsx`,
`cmd/hello.go`). **Per-file-language scoping**: `render` is declared in both `tools/report.py` and
`web/render.ts` on purpose, so a Ctrl+click on `render` in `tools/cli.py` (which calls the Python
one) must resolve only the Python definition — `TreeSitterResolver.resolve` scopes candidates to
the clicked file's Monaco language id, and Python and TypeScript are different ids. **The `.tsx` →
`.ts` sibling case**: `render` clicked in `web/App.tsx` (grammar `tsx`) must still find
`web/render.ts`'s definition (grammar `typescript`), because `.tsx` and `.ts` share the Monaco id
`typescript` and `resolve()` draws candidates from every `LANGUAGES` entry sharing it (`siblings`).
Resolver log lines from this fixture: `render` from `tools/cli.py` — 17 ms, 2 candidates → 1 hit,
Python only; `render` from `web/App.tsx` — 13 ms, 2 candidates → 1 hit, the `.ts` sibling; `Greet`
— 9 ms.

**`make-sample-repo.sh` edits in place with `perl -i -pe`, and `sed -i` is not a portable
alternative to it.** The two invocations that build `feature/wide`'s second commit were written in
GNU sed's spelling and had only ever run on Linux: BSD sed (macOS) reads the argument after `-i` as
a *mandatory* backup suffix, so it consumed the following `-e` and died with `sed: -e: No such file
or directory`, and `\b` is a GNU extension it lacks, so even `sed -i ''` would have renamed nothing
and written wrong content rather than failed. perl ships with macOS, its `-i` needs no suffix and
`\b` is native. **Moving the patterns from BRE to PCRE is a silent-corruption trap, not a syntax
one:** `(`, `)` and `+` are literals in BRE and metacharacters in perl, and the first attempt left
`+` unescaped in `return base + if (order.status == …)` — perl read it as a quantifier on the
preceding space, matched nothing and exited **0**, so that line stayed unedited and the commit made
below it carried content no one had asked for. Escape `( ) +` in any future edit to those two calls,
and check the *bytes* rather than the exit code: what caught this compared all 12 files the edit
touches against an oracle that applied the original sed scripts to the parent revision under
faithful BRE semantics.

**The generator is deterministic, so a frozen SHA is a real check — but only `feature/wide`'s tip is
the one that bites.** Dates are pinned, and three consecutive runs produce identical tips for all
seven branches across both repos. Repo A's `main` is `4221baf` (the SHA the `switchRepo` note below
quotes) and `feature/wide` *branches from* it, so it is upstream of the in-place edits and
reproduces whether or not they worked — it was misleading enough to make one frozen-SHA check pass
vacuously. The tip that moves is `feature/wide`'s, `339b80a` ("Rename log() to trace() package-wide;
reweight priorityScore()", 12 files); compare that one after touching the generator.

`docs/capture-screenshots.mjs` is a worked example of everything in the two paragraphs below —
it drives the repo picker, both palettes and a real Ctrl+click peek, and asserts on
`.zone-widget` and on the palette closing. Read it before writing a new CDP check. It also
exists because **the screenshots went stale silently**: the Primer dark theme and the breadcrumb
header shipped while the README still showed a light Monaco and a `<select>` sidebar, and nothing
caught it because an image cannot fail a typecheck. Re-run it after anything that changes the
chrome. It selects `ccd-sample-repo` itself rather than trusting `REPO_ROOT`, so whatever repo
the backend booted with cannot leak into a committed image.

**A CDP run must hold the page focused, or it stops mounting editors and looks exactly like an app
bug.** `Input.dispatchKeyEvent` with Escape drops headless Chromium to `visibilityState: "hidden"`,
and a hidden page has no rendering lifecycle: `requestAnimationFrame` stops and — the part that
matters here — **IntersectionObserver stops delivering**. Every editor in the band is mounted from
an observer callback, so the next `render()` appends its cards and mounts nothing. Measured on
`feature/wide`: 12 `.ccd-card`, **0** `.monaco-diff-editor`, 0 `.loading`, empty status line, no
console error, no failed request — with `observe()` called 30 times and the callback run **zero**
times, while the band's own box stayed a healthy 1292x856. `Emulation.setFocusEmulationEnabled`
fixes it: same script, same gesture, 9 editors mounted and 10 after a scroll.

This was first mis-diagnosed as "opening a peek poisons the next render", and the bisect that
appeared to prove it (no peek → 9 editors, peek → 0) was really tracking whether an **Escape** had
been dispatched, since the peek step was the only one that pressed one. Two lessons worth more than
the bug: a symptom that survives reverting your own commits is not thereby an app defect — it can be
the harness — and when a whole class of UI silently stops working in CDP, check
`document.visibilityState` and whether `requestAnimationFrame` is still firing before reading any
application code.

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
`Input.dispatchMouseEvent` with the trigger modifier — a `mouseMoved` first, which is what makes
Monaco resolve and underline the link, then the press/release. Assert on a `.zone-widget` appearing.
Testing an action id instead passes vacuously and proves nothing.

**Which modifier that is depends on the platform, and Monaco decides it, not us.**
`clickLinkGesture.js:59-70` maps the default `multiCursorModifier: 'altKey'` through `isMacintosh`,
so the trigger is **Cmd on macOS** (CDP `modifiers: 4`) and **Ctrl everywhere else** (`modifiers: 2`).
`docs/capture-screenshots.mjs` derives it from `process.platform`; a hardcoded `2` cannot produce a
peek on a Mac at all. Nothing in `packages/frontend` sets `multiCursorModifier`, and it should stay
that way — Monaco's own answer is right, and the app has no platform detection to disagree with it.
Two ways to read the platform off a running instance rather than guessing: Monaco renders macOS
keybinding glyphs in its context menu (`Go to Definition ⌘F12`), and on macOS Ctrl+click never
reaches the page as a left click at all — the OS turns it into a secondary click, so it can only
raise that menu.

**A modifier-hover only underlines when a definition actually comes back**, which means a broken
resolver is indistinguishable from a wrong modifier by eye: both are "nothing happens". Check
`/api/def` with curl before touching anything about the gesture. That mistake has been made once
already — a dead `git grep -P` (see below) was reported, reasonably, as "Cmd+click doesn't work".

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

**Two more ways a peek assertion lies, both of which produced a confident false failure.** The
peek's rows are not the only things carrying an `aria-label`: each reference also has a
description (`"1 symbol in Label.kt, full path …"`, `"fun render(…) on line 5 at column 5"`).
Selecting by `aria-label` *containing* a path finds one of those first, and they are never marked —
so a dimming check against them compares 1.0 with 1.0 and "fails" while the feature works.
Filter to labels that **are** `uri.fsPath` (they start with `//`), which is what `peekscope.ts`'s
generated CSS keys on. Second: in the repo picker, a single click *selects* and `Open` acts on the
selection, so clicking both in the same turn opens whatever was selected before — the test opened
the wrong repository and reported a missing branch. Wait for the header crumb to name the repo
before continuing.

When you fix a bug, **reproduce it first and record the numbers**. Several fixes in the history
would have been unfalsifiable otherwise — "the reveal is wrong" means nothing next to "it
scrolled to 1862px when the line was at 2622px". The same rule caught a claim in *this* work: a
commit message said the client now issued one `/api/def` per Ctrl+click, and counting the requests
over CDP said two.

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

**Disabling Monaco's TypeScript language service means turning off every flag, not just
diagnostics.** `main.ts` calls `setModeConfiguration` on both `typescriptDefaults` and
`javascriptDefaults` with every field false (`completionItems`, `hovers`, `definitions`, …), not
merely `diagnostics`. Left partially on, the service registers its own definition provider beside
`defprovider.ts`'s — and its "project" is every `.ts`/`.js` model in Monaco's registry, which
deliberately spans multiple revisions, so its answers cross revisions and are wrong by
construction. Measured: a Ctrl+click on `render` in `App.tsx` peeked `Definitions (2)` before every
flag was off — this resolver's answer plus the service's duplicate. Monarch colorization is
unaffected (it isn't the worker), `ts.worker` never spawns with everything off, and
`monaco-env.ts`'s worker routing stays in place as the guard if one ever does.

**The four `diffEditor.*Background` colours must be translucent 8-digit hex.** Monaco registers
them `needsTransparency`; an opaque tint paints over selection and search highlights inside a
changed line.

**An unset `peekView.border` is a saturated blue frame, because it is an alias of
`editorInfo.foreground`.** `peekView.js:232` registers it that way and the dark default is
`#3794ff` — measured **6.17:1** against the canvas, framing added lines that sit at **1.204:1**.
Five times the contrast of the content, spent on chrome, which is exactly the rule index.html's
palette comment states and the same defect the sidebar's `activePath` fill already had. It is now
`--ccd-border` at 1.55:1. **The frame could not be quieted on its own**, and that pairing is the
part to not undo: `peekViewEditor.background` was `#0d1117`, bit-identical to `editor.background`
(measured 1.000:1), so the blue frame was the *only* thing saying "overlay". The peek now has its
own raised surface (`#161b22`, 1.094:1 against the editor behind it) with the list recessed to
canvas under it, and index.html carries the shadow — there is no theme key for one. Note the frame
colour also paints `.peekview-widget > .body`'s `border-top` and the arrow, via `_applyStyles`, so
one key covers all three. Raising the preview costs token contrast: `comment` `#8b949e` re-measured
at **5.62:1** there. Move that surface again and re-measure it rather than assuming.

**Ten of Monaco's thirteen `peekView*` keys were unset for the whole life of the app**, so the
widget the tool is named after rendered half Primer and half VS Code — three different near-whites
where `--ccd-fg` was meant, `#3399ff33` on the selected row beside the app's own `#1f6feb`, and
`#ff8f0099` match highlighting, a 60%-alpha orange painted over the definition itself. Worth
knowing when reading that block: `peekViewResult.selectionBackground` applies **only** to a focused
list and a row without `.highlighted` (`referencesWidget.css:46`); outside that the generic
`list.*` colours win, so setting one without the other leaves two different selection colours.

**A `getUriLabel` override is what stops the peek printing the repo id and the SHA, and where it is
called is load-bearing.** Standalone Monaco answers `uri.fsPath` for any `file:` URI
(`standaloneServices.js:584-589`), and ours are `file://<repoId>/<rev>/<path>`, so the peek's title
read `//ctrlclickdiff-66caac9c/c3ebf28e…/packages/frontend/src` — 89 characters where the directory
belonged. It ellipsizes, so at the default side-by-side width the noise pushed the *filename* off
its own title bar (`storag…  //ctrlclickdiff-…  - Definitio…`). `urilabel.ts` replaces the service;
`main.ts` calls it **first, before anything else touches monaco**. Not a style preference:
`StandaloneServices.initialize` is `if (initialized) return`, and it is not the only initializer —
`StandaloneServices.get` initializes with no overrides when it arrives first
(`standaloneServices.js:716-719`), and `registerDefinitionProvider` (`standaloneLanguages.js:375`),
`registerEditorOpener` and every `createModel` all go through it. Placed beside `installTheme()` it
had already lost, silently, and only the peek-marking check caught it.

**`peekViewLayout` in the storage service is the supported way to size a peek.** The controller
reads `{ratio, heightInLines}` from `IStorageService` on **every** open
(`referencesController.js:85-86`) and writes it back on close, so seeding that key is how
`peeklayout.ts` gives a single-definition peek its width back (preview 428px → 512px) without
touching the private `_splitView`. CSS alone cannot do it — SplitView calls
`preview.layout({width})` with the width it computed, so restyling the box leaves Monaco's editor
laid out to the old one. Two limits: the list's `minimumSize: 100` survives any ratio, and the
controller's write-back means a reader's sash drag is overwritten (which is why `heightInLines` is
read back and preserved, and only the ratio is decided).

**The rule that hides that 100px remnant is keyed on the widget's own content, and a flag there
races.** The first version set an attribute on `<html>` from the definition provider. Monaco
resolves on Ctrl+**hover** as well as on click, and the peek's preview is itself an editor with the
provider registered — so a Ctrl+hover *inside* an open peek rewrote the flag and the hidden list
reappeared under the reader. Reproduced over CDP, not theorised. The selector is now
`.ref-tree:has(.monaco-list-rows > .monaco-list-row:only-child)`, which cannot disagree with the
widget it describes. No `:has()` circularity, because `display: none` changes the box tree while
selectors match the DOM tree — verified, since getting that wrong flip-flops rather than fails.

**The diff tint is a constrained optimum with almost no slack, and three walls hold it there.**
Line 13% / word 6% puts an added line at 1.20:1 against the canvas and a removed one at 1.14:1 —
up from 1.11 and 1.07, and that ~8% is the whole available win. (1) `comment` `#8b949e` is the
darkest token in the theme and only 5.0:1 on bare canvas, and it must stay ≥4.5:1 read *through*
line and word tints stacked; swept in 1/255 steps the frontier is line `0x2c` / word `0x07`, and
past line `0x2f` **no** word tint keeps AA. (2) Raising the line tint *costs* the word diff, which
is read against the line under it: line `0x26`/word `0x0a` buys a 1.25:1 line and collapses the
word highlight to 1.07:1, which is not a highlight. (3) The gutter looks like free contrast and is
not — see the next paragraph. Two dead ends worth not re-walking: more alpha fails AA, and **no**
alpha makes added and removed distinguishable in greyscale (green and red at equal alpha land at
the same luminance — 1.03:1 apart at 8%, still only 1.13:1 at 28%), so the `+`/`−` glyph is the
non-colour carrier and has to stay. The one lever that would open real headroom is lightening
`comment`, which changes how the theme reads and needs its own commit. For calibration: GitHub
dark's own added line is also 1.20:1 — a diff tint simply *is* a low-contrast signal, so a
"raise it to 3:1" instinct is wrong.

**Monaco paints its alignment spacers with the *removed*-line gutter colour, so a block of purely
added lines wore a red bar down its left edge** — both claims about the same rows at once, loudest
in inline mode where the bar sits directly against the green. A spacer is the margin view zone
Monaco inserts where one side has no line opposite the other; in the **original** editor that always
means the modified side gained lines, i.e. an addition (measured on `band.ts`: ten of them). A real
deletion is a *different* element (`cmdr gutter-delete`, and in inline mode
`inline-deleted-margin-view-zone`), which is what makes the fix targetable at all — there is no
theme key that separates them, since the spacer and the real deletion share
`diffEditorGutter.removedLineBackground`.

**The fix is to paint the spacer with the *inserted* wash, not to clear it, and clearing it was
tried first and was half a fix.** Transparent removes the false red and leaves the added rows
visibly *shorter* than the removed ones, because a removed row's own `cmdr gutter-delete` does cover
that column. Measured on `diff.ts` at 1253px wide: removed spanned x=1..1252, added only
x=43..1252, and that 42px step is the original editor's line-number column. So the rule is
`.ccd-card .editor.original .margin-view-zones > .gutter-delete` with
`var(--ccd-diff-inserted-line)`, and **`theme.ts` publishes that custom property** at the foot of
`installTheme` rather than the stylesheet restating `#3fb95020` — the value's whole job is to equal
`diffEditor.insertedLineBackground`, and a spacer a shade off the block it belongs to is worse than
one left alone. Same reasoning that keeps `modelUri`/`parseModelUri` together. Check both edges when
touching this: added and removed must start at the same x, and in inline mode their right edges
still differ legitimately, because the word-diff spans end where the changed text does.

**`diffEditorGutter.*` stays at 15%.** Nothing but the line number `#6e7681` sits on it and it takes
20% before that drops under 3:1, so it looks like free contrast to spend. It was raised to 20% once
and put straight back: the gain on a modified file is marginal next to the line wash, and every
point of it also amplified the spacer bar above. Now that the spacers are transparent the argument
is only the first half — still not worth it, but re-measure rather than assume if you try.

**`diffEditor.unchangedRegionBackground` defaults to `sideBar.background`**, a workbench colour
standalone Monaco never registers. Unset, the collapsed-region bars render unstyled.

**`overflow: hidden` on a card is what stopped its sticky header sticking, for the whole life of
the band.** Any overflow other than `visible` gives an element a scrolling box, and a sticky
descendant sticks within its *nearest* such box — so `.ccd-card { overflow: hidden }` made the card
its own header's scrollport, and a card never scrolls, so `top: 0` resolved to the card's own top
and the header rode away with it. Measured before the fix, header top at scrollTop 400/1400/2400:
**−343 / −1343 / −2343**, never pinned once, while both the README and the rule's own comment
claimed it worked. The clip that rounds the editor's corners now lives on `.ccd-card-body`, which is
not an ancestor of the header. Two related facts: the header's `top` is the band's padding
**negated** (`--ccd-band-pad`, because a scroll container paints scrolled content over its padding,
so pinning at the content edge leaves a 12px strip of the previous lines showing above it), and
Chrome resolves a sticky offset against the scroll container's **content** box — measured, `top: 0`
pinned at band-top + padding, not at band-top.

**An added or deleted file must not render side by side.** There is no "before" to compare, so one
pane holds nothing and Monaco fills it with diagonal hatch: measured on `deeplink.ts`, **1,195,936
px² of hatch against 1,141,200 px² of visible card**, with all the content squeezed into the other
633px pane. `viewOptions` therefore takes the file's status, and `liveEditors` is a `Map` from
editor to status rather than a `Set` — that pairing is the point, because `applyViewOptions` would
otherwise push a bare `renderSideBySide: sideBySide` over the override on the next toggle and put
the empty pane back. After: hatch is 3.7% of the card. Verify both directions when touching this —
an added file must hold 42/1224 across a full Split→Inline→Split trip, and a modified file must
still swing 633/633 ↔ 42/1224.

**Word wrap is on by default because the cap plus a sidebar leaves 633px a pane.** `--ccd-content-w-max`
used to claim it was "wide enough that neither pane wraps"; true of the fixture repos, false of real
code — this project's own `shell.ts` has 899px lines, so **113 of 113** rendered lines of
`deeplink.ts` were clipped, and Monaco's horizontal scrollbar is `opacity: 0` until hovered so
nothing said text was missing. The consequence to know: content height now depends on pane *width*,
so dragging the sidebar re-wraps and re-fires `onDidContentSizeChange`. That is not a loop —
measured across a full drag of the clamp and back, 20 writes, 14 distinct heights,
4667px → 5275px → back to exactly 4667px, zero further writes after release — because the guard in
`syncHeight` is against height→height and `scrollBeyondLastLine: false` keeps content height
independent of viewport height.

**Per-file churn comes from Monaco, not git, and will not equal `git diff --numstat`.**
`FileDiff.churn()` reads `getLineChanges()`, which is the same list the `.line-insert` tinting is
drawn from — so the header agrees with the coloured lines under it, which is the property that
matters. On `shell.ts` it reports +98/−14 where *every* git algorithm (myers, minimal, patience,
histogram, with and without the indent heuristic) says +96/−12: both are valid diffs, drawn with
different hunk boundaries. Matching git would print a number contradicting the pixels. Two counting
bugs that are already fixed and would come back if the clamp is removed: a text model counts the
empty string after a trailing newline as a line and git does not (a whole-file add read "+113" for
112 lines), and `loadModels` hands an added file `''` for its original — one empty line — so the
same file read "−1", the absence of the file counted as a deletion. Both fall out of clamping each
side to its own real line count, which is a true invariant rather than two special cases.

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

**`updateAddressBar` writes nothing until a repository is adopted, and that guard is what stops
the feature from destroying its own input.** It hangs off `renderTrail()`, which `initShell()` calls
**synchronously before `void boot()`** — so an unconditional write would replace an incoming deep
link with an empty URL in that same tick, before `boot()`'s `parseDeepLink(location.search)` line
ever ran. `repo` stays `null` until `adoptRepo()`, which is reached only after `parseDeepLink` has
already returned, so every call that could clobber a link is by construction one with an empty
`repoPath`. Do not "simplify" this into an ordering rule at the call site: the no-op is also simply
true (a review with no repository is not worth linking to), and a structural guard cannot be
undone by someone moving a line.

Two smaller facts in the same file. `replaceState`, never `pushState` — the URL mirrors state
rather than recording a navigation, and on push the Back button would rewind the reader's own
selection history instead of leaving the page (measured as `history.length` unchanged across two
selections, which is what `tools/verify-deeplink.mjs` asserts rather than trusting the source).
And the query is built by hand while it is *read* with `URLSearchParams`: reading, that class's
`+`-means-space rule cannot bite because every producer percent-encodes; writing, it would corrupt
a filesystem path.

**Adding a deep-link parameter is five places, and the third is the one that gets forgotten.**
`deeplink.ts` (both halves — they are in one file precisely so this is one edit), the line in
`shell.ts` that consumes it and names *which default it overrides*, `deepLink()` in
`tools/ccd-review.mjs` if the opener should emit it, the README's deep-link block, and a check in
`tools/verify-deeplink.mjs` — a parameter nothing asserts is a parameter that can stop working
silently, which is the failure mode this whole feature is prone to. **Do not validate its shape in
`deeplink.ts`**: carry it through untouched and let the route that owns it reject it, the way `ref`
and `shas` already do. A second copy of a validation rule is the drift hazard, and the error path
already exists.

Where the opener is extended is `open()` in `ccd-review.mjs` — one function, currently Orca then
`xdg-open`, and the only place that knows how a review reaches a human. Adding an editor or a
different browser goes there and nowhere else; note that failing to open is deliberately a warning
rather than an error, because the URL on stdout is the part a caller can act on.

**A deep link's repository never falls back to recents or `defaultRepoId`.** `boot()` branches once
(`link ? api.registerRepo(link.repoPath) : preferredRepo(await api.repos())`) and reports the
backend's own refusal text on failure. Falling through would open a *different* repository than the
one the reader followed a link to, with nothing on screen saying so — the same class of wrong-answer
-dressed-as-right as the pre-`--diff-merges` merge commit. The regression is invisible to any test
that checks only "did something load", which is why `verify-deeplink.mjs` asserts the repo crumb
still reads `Choose repository…` after a refused link.

**`modelUri` and `parseModelUri` are an inverse pair and live together in `diff.ts`.** Splitting
them (the parse used to sit in `defprovider.ts`) makes the segment layout a two-file edit whose
half-done version fails **silently at runtime** — cross-file peek just stops rendering — and
never at typecheck. Same reasoning as `initResizer` reading its clamp bounds back from CSS
instead of retyping them.

**Peek chooses its own first candidate, and it is not the one the provider returned first.**
`provideDefinition`'s array is re-sorted by URI (`referencesModel.js:120`), so the list is
alphabetical by path; the candidate the widget *opens on* is `nearestReference` — longest common
URI prefix with the clicked file, i.e. directory proximity (`referencesController.js:152`, reached
because Ctrl+click builds `DefinitionAction` with `openInPeek: true`,
`goToDefinitionAtPosition.js:246`). Our order still decides `firstReference()`
(`goToCommands.js:143`), which is the *jump* a Ctrl+click inside the peek preview takes — so the
in-review-first partition in `defprovider.ts` is not decoration, it just does not do what a reader
assumes. Do not try to fix the peek's choice by reordering there; it has no effect at all.
The lever that would work, `definitionLinkOpensInPeek: false` + `gotoAndPeek`, jumps the band to
the target file *before* peeking, which loses the reader's place. `peekscope.ts` nudges the
selection instead.

**A peek row's path is in `aria-label`, not `title`, and one candidate file means no file rows.**
The rows are `IconLabel`s with `custom-hover="true"`, so the native title the label API implies is
never written; `aria-label` is built from the `title` option (`iconLabel.js:88-93,124`), which
`referencesTree.js:113` fills with `ILabelService.getUriLabel(uri)` — so it holds exactly whatever
`urilabel.ts` answers, which is what `peekscope.ts`'s generated CSS keys on. **That is why
`peekscope.ts`'s `rowLabel` IS `urilabel.ts`'s `modelUriLabel`, not a second implementation of
it** — same inverse-pair hazard as `modelUri`/`parseModelUri`, and it fails the same silent way:
a selector that matches nothing looks exactly like a peek with nothing to mark. It used to be
`uri.fsPath`, which was correct only while nothing overrode the label service. With a single candidate file the
tree's input is that group (`referencesWidget.js:451`) and the list is bare reference rows — there
is nothing to mark, which is also why `docs/screenshot-peek.png` (a `shout` peek, one file) is
unaffected by any of this. Marking is CSS rather than classes set from an observer because
`monaco-list` recycles rows: a class outlives the file it was set for, an attribute selector
cannot. That generated stylesheet is the one exception to "ALL CSS is inline in index.html" —
the selectors are built per gesture from paths only that module knows, so the alternative is one
decision split across two files. It still uses index.html's `--ccd-*` tokens.

**Nudging peek's selection is two clicks, and the second needs the frame after the first.**
Monaco expands only the group it revealed into, so the target's reference row does not exist yet:
clicking the file row creates it, and only a click on a *reference* row moves the preview (a file
row is ignored — `referencesWidget.js:360-378`; a single click is `show`, which the controller
does not act on, so nothing navigates or closes). The expand is a tree re-render, not a
synchronous insert — reading the rows back in the same turn finds the list unchanged, which is how
the first version of this selected the right file row, clicked nothing, and left the preview where
it was. And the nudge waits three frames after `.selected` appears: acting the moment it does cuts
across the reveal Monaco still has in flight, which surfaced as an unhandled `Canceled: Canceled`
in the console. All three were found by measuring, in that order.

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

**`git grep` accepts no `--end-of-options`, and that is why `/api/def` whitelists its rev.** It
tries to *resolve* the string as a revision — `fatal: unable to resolve revision:
--end-of-options`. The fence `listCommits` and `commitSpan` bracket their revs with does not exist
for this subcommand, so `REV_PATTERN` at the route is the only place the shape can be enforced.
Same trap family as `--not` vs `^<sha>`; here no fence is available at all. A second reason,
measured on a blobless clone: a bad rev is not a cheap local failure — `git grep` against a
fabricated SHA answered `fatal: remote error: upload-pack: not our ref`, having gone to the
network first.

**Three more `git grep` facts, each of which silently does the wrong thing.** It **exits 1 when
nothing matches**, and no-match is the *common* case here (any word Ctrl+hovered that is not a
symbol) — `run()` rejects on non-zero, so `candidateFiles` catches code 1 and rethrows everything
else. `-e` is a **regex** unless you say otherwise: `Plot.vgExport` matched `PlotSvgExport`, so the
identifier is escaped before it goes in. And output records are `<rev>:<path>`, stripped by
`rev.length + 1` rather than by splitting on `:` because a path may contain one; `-z` is what
avoids having to de-quote `core.quotePath` escaping, and `--full-name` is what stops
"`repoRoot` is the toplevel" from being load-bearing.

**Candidate discovery ignores `import`, `package`, `//` and `*` lines, and those are filters, not
heuristics.** Boilerplate at the top of every file otherwise makes ordinary words cost a whole-repo
parse, and Kotlin has two kinds of it. The *package line*: `letsPlot` matched 2274 of lets-plot's
2646 files, 6.70 s. The *license header comment*, which every file in that repo carries: its words —
`Copyright`, `license`, `source`, `code`, `found`, `file`, `this`, `that` — matched ~2571 files
**each**, 9.4–15.0 s. Both were also thrashing the cache (2000-entry cap against 2500+ candidates
means a query evicts its own earlier files, so repeats never got cheaper — the per-resolve log shows
this as a high `cached` count next to a high parse time). Package lines and license headers both sit
at the top of every file, which is exactly where a reader with Ctrl held drags the pointer.

Measured, with both excluded: `Copyright` 10.1 s → 0.040 s, `license` → 0.036 s, `file` 15.0 s →
0.204 s, `source` → 0.203 s, `code` → 0.077 s. Real identifiers barely move — `render` 57 → 51
candidate files, `apply` 348 → 335, `size` 696 → 662 — which is the point: this removes noise, not
signal, and their hit counts are unchanged.

Nothing can be lost, because a declaration cannot appear on an `import`/`package` line nor on one
whose first non-space characters are `//` or `*`. Verified rather than argued: across eleven
identifiers, 15025 files were dropped and **every** line mentioning the name in them was a comment,
import or package line — 0 exceptions. An extension function (`fun Foo.bar()`) is on a `fun` line
and survives; `import a.b.C as render` is an alias, not a declaration, and is correctly gone.

**`/*` is deliberately not in the list, only `*`.** A line that opens a block comment can legally
also close it and then declare something (`/* note */ fun foo()`), so excluding it would stop being
a filter; a line *starting* with `*` is a continuation or terminator and cannot be anything else.
The prefixes are per language (`Language.nonDeclaringLinePrefixes`), a boundary is appended only to
those ending in a word character (after `//` it would demand a word boundary between two non-word
characters and never match), and the name is escaped because it reaches git as a regex.

**The grep is `-E`, and it must not go back to `-P`.** PCRE is an optional git build feature and
Apple's git — the only git on a stock macOS — does not have it: `git grep -P` answers `fatal: cannot
use Perl-compatible regexes when not compiled with USE_LIBPCRE` and exits **128**, which
`candidateFiles` rethrows because it only forgives exit 1. So on macOS every `/api/def` threw, no
definitions ever came back, and Ctrl/Cmd+click was silently dead — the whole feature, on a whole
platform, from one flag. The exclusion that used to need a lookahead is now `--and --not -e`, git
grep's own per-line boolean, and `\b` is now `[^A-Za-z0-9_]` brackets because BSD's `regcomp` has no
`\b` either; consuming the boundary rather than matching zero-width is invisible under `-l`.

**Probing `-P` with a plain word does not test `-P`.** git short-circuits a metacharacter-free
pattern to a fixed-string search before it ever reaches PCRE, so `git grep -P -e 'PEEK_OPTIONS'`
succeeds on a git that cannot do `-P` at all while `git grep -P -e 'PEEK.OPTIONS'` fatals. That
produced one confident "it works" here before the real cause was found.

Equivalence was verified against lets-plot rather than argued, and re-run it if this changes again:
the ERE form and the old PCRE pattern (applied through a Python oracle over the fixed-string
superset) select identical file sets — `PlotSvgExport` 8, `render` 52, `letsPlot` 51 of a 2280-file
superset, `file` 23 of 2584, `Copyright` 0 of 2576. The engine is not where the time goes: same walk
over 2651 `.kt` files, `-F` 81ms / word only 90ms / word plus exclusion 98ms, so matching is ~17ms
against an 81ms floor of reading the tree, and PCRE has nothing to win back.

**Tree-sitter's query language has no "else", and an unconstrained fallback pattern double-captures
rather than losing to the specific one.** A specific pattern (a function-valued
`variable_declarator` → `@definition.function`) and a general one (any `variable_declarator` →
`@definition.constant`) both match the SAME node when the general pattern carries no negative
constraint — `query.matches()` fires both, and the resolver does not dedupe by location, so one
declaration answers twice. `tags/typescript.scm` and `tags/javascript.scm` avoid it by enumerating
the *complement* of the function-ish expression types straight out of each grammar's
`node-types.json`, instead of writing an unconstrained catch-all. Measured, not hypothetical: before
that negative list existed, `const arrow = () => {}` produced two captures — one
`@definition.function`, one `@definition.constant` — at the identical location.

**An upstream tags.scm pattern can compile clean and capture nothing.** tree-sitter-python's own
`tags.scm` wraps a top-level assignment in `(expression_statement (assignment ...))`, but
`expression_statement` is declared a `supertype` in the grammar's `grammar.js` — supertype rules are
elided from the concrete tree, so the wrapper node the pattern expects never appears and the pattern
matches zero nodes, silently, with no compile error. `tags/python.scm` here anchors on `assignment`
directly instead. The lesson generalises past Python: verify a pattern's captures empirically
against the built wasm before trusting it, upstream-authored or not.

**Delete every tree-sitter tree, and let nothing derived from one outlive it.** Trees are WASM
pointers and are **not** garbage collected; the old whole-revision index leaked one per file per
revision, which is most of its ~320 MB. `readSymbols` deletes in a `finally`, and `toDefMatch`
copies `node.text` and `startPosition` out *before* that — `Node`, `QueryMatch` and `QueryCapture`
all hold into the tree's arena, so the natural refactor (return the match, classify it later) is a
use-after-free that typechecks perfectly. `Query` also has `.delete()`; **do not call it** — a
query is compiled once per language and reused, a tree belongs to one parse. One shared `Parser`
per language is safe under the read pool only because `parse()` is *synchronous*: the concurrency
is on the I/O. Do not add a parser pool.

**web-tree-sitter 0.26 renamed its runtime wasm, and that had been silently masked.** It used to
publish as `tree-sitter.wasm` alongside `tree-sitter.js`; 0.26 renamed it to
`web-tree-sitter.wasm`. `treeSitterRuntimeWasm()` (`resolver/grammars.ts`) looked for the old name
on both of its resolution paths and had been silently returning `undefined` on every 0.26.x
install — masked because `Parser.init()`'s own default `locateFile` falls back to fetching the wasm
next to the loaded JS, which happens to still work under `tsx`. Fixed to check the current
filename; check it again on the next upgrade, since this is exactly the kind of rename that fails
both paths silently.

**The read pool interleaves read and parse, and 8 is a measured plateau, not a preference.** On
264 candidates: sequential 557 ms; concurrency 4/8/16/32/64 gives 267/260/267/267/274 ms. Reads
plateau at 4 because libuv spawns processes on the loop thread, so every `execFile` costs ~1 ms of
*main-thread* work however many are in flight. 8 rather than 4 because end-to-end, reads
overlapping parses, it measured 803 ms against 1007 ms. The tempting tidy-up — await every read,
then parse in a loop — is a single 313 ms synchronous block, because the await on each subprocess
is the only thing yielding the event loop (measured max lag as written: 27 ms).

**`git cat-file --batch` was measured and declined.** 264 blobs: 24 ms batched against 260 ms as
individual `git show` spawns. An 11× ratio on a number that is *not* the bottleneck — parse is
313 ms in the same query — so it would take the worst identifier from 803 ms to ~570 ms and the
typical one from 37 ms to ~35 ms, in exchange for a new subcommand, the first place the backend
writes to a subprocess's stdin, a length-prefixed protocol parser, and bypassing `run()`. The
trigger to revisit is a number, not a taste: a p95 Ctrl+click over ~1 s that profiling attributes
to blob reads rather than parses.

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

- **`SymbolResolver` is ONE method, and asking is the whole interface.** There used to be a
  `buildIndex(repoRoot, revision)` beside `resolve`, whose only documented rule was that callers
  await it first — a step that existed to be awaited. It was there because the tree-sitter
  implementation could not answer without parsing every file at the revision, and that is a fact
  about *that implementation*, not about the question; the contract already said per-implementation
  setup does not belong on the interface. `POST /api/index` went with it (no caller since
  `api.prewarm` was deleted, and keeping a route whose whole semantics is "index the revision"
  would be a live re-entry point into the bug), and `listKtFilesAtRev` went too, so **`ls-tree`
  left the codebase** — a sibling to `diff-tree` leaving when `commitSpan` replaced
  `changedKtFiles`. An implementation that needs preparation does it inside `resolve`, at the scale
  the query needs.
- **The resolver's work is proportional to the identifier, not to the repository.** `git grep`
  names the files that mention the name; only those are read and parsed. This is why there is no
  prewarm and no first-click penalty to amortize, and why `shell.ts` no longer has a comment
  explaining a disabled one. Candidates are partitioned same-file-first **before** the reads, not
  after: the pool completes out of order, so ordering the results would make the answer depend on
  scheduling. `candidateFiles` sorts with a plain `sort()` and **not** `localeCompare`, which would
  make the answer depend on the machine's `LANG`.
- **The per-file symbol cache is bounded, and the bound is the point.** Key is
  `(repoRoot, revision, path)`, ~6.2 KB an entry measured, capped at 2000 (~12 MB). The old
  per-revision index had no cap and grew RSS ~320 MB *per revision*, so a ghost squash spanning ten
  revisions cost ~3 GB; this holds ~12 MB however many revisions a selection spans. No TTL —
  `(repo, rev, path)` names immutable content, the same reason `diff.ts` never disposes a model, so
  an entry cannot become wrong, only surplus. Entries are **promises**, which buys in-flight
  coalescing for free and costs nothing because the promise is infallible by construction. The cap
  must stay comfortably above the largest realistic candidate set: it was 2000 against a *believed*
  worst of 264, and the real worst turned out to be 2274 (a package segment), which thrashed until
  the import/package filter cut it to 57.
- **`DefQuery.lang` was deleted rather than widened, and the rule that replaced it is
  "a definition is resolved within the language of the file you clicked in."** The field was a
  `'kotlin'` literal carried by every layer and read by nothing. Deriving beats declaring: a
  declared language can disagree with the file it names, a derived one cannot. A field that can be
  derived is a field to delete.
- **The language registry's revisit trigger fired, and the seam held.**
  `packages/shared/src/languages.ts` held one entry (kotlin) for a long time — it had already
  replaced thirteen literals across three packages that were drifting in *kind* (`'.kt'` as a
  suffix test, `'*.kt'` as a git pathspec, `'kotlin'` as a Monaco language id, `'kotlin'` as an HTTP
  enum), the same hazard class as splitting `modelUri`/`parseModelUri` — and named **a second
  grammar** as the trigger to revisit it. It fired once, for TypeScript; the other nine languages
  that followed it needed nothing new from the seam. Ten new languages in, nothing about the seam
  itself moved: a language is still a row here, an assets row in the backend's
  `resolver/grammars.ts`, a hand-authored tags file, a vendored wasm with recorded provenance, and a
  `smoke.ts` sample. `Language.id` still **is** Monaco's language id, deliberately — that identity
  is what makes `registerDefinitionProvider` and `createModel` agree by construction — and there is
  still no `monacoId` that would always equal `id`. What the second grammar actually forced:
  - **`Language.grammar?`** — one Monaco language id can now cover two tree-sitter grammars. `.ts`
    and `.tsx` are both Monaco's `typescript`, but tree-sitter-typescript ships two separate wasms
    because the plain grammar cannot parse JSX; `grammarKeyFor(lang)` (`lang.grammar ?? lang.id`)
    is the only place that fallback is allowed to live.
  - **`resolve()` greps every same-id sibling's extensions, not just the clicked entry's own.** A
    `.tsx` click and a `.ts` click share a `siblings` list (every `LANGUAGES` row with that Monaco
    id), so a definition in either extension is findable from the other; each candidate is then
    parsed with its own path-derived grammar, never the clicked file's. `TreeSitterResolver.init`
    boot-asserts that every group of same-id entries declares element-wise identical
    `nonDeclaringLinePrefixes` — if a `.ts`/`.tsx` pair disagreed, the same identifier would be
    filtered differently depending on which file the click started in, silently, since the filter
    only narrows grep results and never errors.
  - **`assertDefinitionKinds` runs at boot, not at the first unlucky Ctrl+click.** Any
    `definition.<kind>` capture outside `{class, function, constant, type}` fails boot, naming the
    grammar and the offending capture. Upstream tags.scm conventions use kinds this resolver
    doesn't recognise (`definition.method`, `definition.interface`, …) — every tags file here is
    authored against this resolver's four kinds and normalised to them, never copied verbatim from
    upstream.
  - **Registry row order is load-bearing in exactly one way:** `languageForPath` is first-match-wins
    on extension suffixes. Every extension set is disjoint today, so order is only convention —
    except `.h`, which `cpp` claims alone, deliberately: a `.c` file's Ctrl+click on a macro
    declared in a `.h` cannot find it, an accepted limitation recorded on the `c` entry rather than
    a bug.
- **`/api/def` is memoized on the client, bounded, and the bound is why it is allowed to persist.**
  Monaco calls `provideDefinition` twice per Ctrl+click. An in-flight-only map was written first
  and measured: it left the count at **two**, because the two calls do not overlap — the hover
  resolves about a second before the mouse goes down. Only a retained answer removes the second
  request; storing the promise still covers the overlapping case. Retaining is sound because
  `(repoId, rev, file, line, name)` names immutable content, so a bound (256, LRU) rather than an
  expiry is what keeps it honest. Rejections are evicted — a failed fetch is not an answer, and
  caching it would make one network blip permanent for that word. It memoizes the **fetch** only:
  both provider bodies must still run, because each calls `applyPeekScope`, and returning early
  from the second would silently break the out-of-review nudge.
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
- **What the sidebar reports must never outshout what the diff shows.** `activePath` is *reported*
  by the band's IntersectionObserver, not chosen by a click, and it used to render as a full-bleed
  accent fill — 4.08:1 against the canvas, against a diff at 1.20:1, so a passive scroll-position
  marker carried 3.5× the contrast of the thing it pointed at and was the strongest shape on a
  blurred screenshot. Now a subtle surface plus a 2px inset accent rule: ratio 1.0×, and the accent
  is free to mean "something changed here". The blur test is what decides this, not an opinion —
  squint at it, and the dominant shape must be the changed lines.
- **Every row of the sidebar is a control, both kinds.** `dirItem` had `role=button` + `tabIndex 0`
  from the start and `fileRow` did not, so the tab order could expand a directory and then reach
  nothing inside it — the destinations of the app's primary navigation were mouse-only. Making a row
  a control also makes its accessible name audible, which is why the one-letter badge is
  `aria-hidden` and the row is labelled "`<path>`, added": the letter is a glyph, and a glyph is a
  poor thing to hear. The badge stays one letter, because that is the entire reason it is one.
  Deliberately *not* a full `role=tree` with roving tabindex — matching the sibling pattern is what
  removes the blocker; tree semantics are their own change.
- **The empty state lives in the band and carries an action.** "No reviewable source files changed"
  used to be one muted 12px line in the corner of the sidebar beside 1290×850 of empty canvas —
  easy to miss, and it named a fault without a remedy, so it read as a broken tool. It is now a
  block where the reader is looking, with why it happened and a button into the commit palette
  (`BandHooks.onChooseCommits`, a hook because the palette needs state only the shell has). The
  languages are still named as a *category*: `641f86e` removed the extension list because a sentence
  spelling out a dozen suffixes stops being a sentence, and moving the sentence did not change that.
- **`setStatus` carries a severity, and the colour is the redundant half.** One slot holds
  "Loading commits…" and "Error loading diff: …", and at one colour a dead request looked exactly
  like a slow one. Errors render in `--ccd-danger`; every message that passes `'error'` already
  begins with the word, so the red confirms rather than carries. The element is `role=status`
  (polite, not assertive — this slot carries routine progress and would otherwise interrupt on
  every fetch). Check *recovery* when touching it: a sticky error class leaves the next "Loading…"
  painted as a failure.
- **The busy pointer is the other half of that slot, and its set/clear pair is deliberately
  asymmetric.** `setBusy` writes `data-busy` on `#app`, and index.html paints `cursor: progress`;
  during a preview load the status line is 12px of grey in the corner of a 300px sidebar while the
  review column still shows the *previous* selection, so the words alone were somewhere the eye was
  not. A cursor rather than a spinner element because it renders beside the pointer wherever it
  already is — it cannot cover a line of the diff, and there is nothing to append to a band that
  `band.ts` empties on every render. Two things not to tidy. The CSS needs
  `.ccd-app[data-busy='true'] *` **and** `!important`: Monaco sets `cursor: text` on `.view-lines`
  from a stylesheet it injects into `<head>` at runtime, i.e. after index.html's and at matching
  specificity, so the bare rule leaves an I-beam over the whole review — measured by reading
  `getComputedStyle('.view-line').cursor` back, which says `progress` as written. And busy is *set*
  only for a load the reader asked for (`refreshRefs` passes `background: true`, on its own rule
  that an unrequested poll does not take over the UI) but *cleared* by whichever call is newest even
  if it never set it — match the two and a background refresh that supersedes a user-initiated load
  strands the pointer on, because the superseded call is stale and must not clear.
- **An out-of-review peek row is greyed, not labelled, and that was measured rather than chosen.**
  A "· not in this commit" suffix was written and taken out: the peek's tree pane is ~150px, a
  filename needs ~52px and the note ~95px, so the two cannot both render. Pinning the note clipped
  the *filename* to "L…" — a row that no longer says which file it is has given up its whole job —
  and leaving it unpinned ellipsized the note itself to "· not in this…", which reads as broken.
  Dimming plus italic says the same thing in no space at all. If the grey ever needs words, the
  place with room is the peek's title bar, not the row.
- **The review scope reaches Ctrl+click through one predicate, `shell.isInReview`.** The band uses
  it to decide a path has no card and `defprovider.ts` uses it to split the candidate list; they
  are the same question and must never answer differently. It is passed into
  `registerDefinitions` rather than imported, so that file keeps having no ambient state of
  its own — a resolution belongs to the model it started from, the review it is judged against
  belongs to the shell.
- **`selection` comes from `/api/preview`'s own records, not from `selectCommits`'s caller.** The
  caller-supplied version worked exactly when the caller already had metadata — true for a palette
  pick, false for a selection named from outside the app, where a fresh page load has nothing to look
  anything up in. `orderCommits` had to run `git log --no-walk` over the selection anyway (that call
  is what sorts it and proves each sha exists), so asking it for the record format instead of `%H`
  adds no process and no round trip, and answers for any commit in the object database — including
  one older than the ref's 100-commit page or no longer on the ref at all. This is why
  `loadCommits(initialShas)` may hand `selectCommits` bare SHAs wearing empty metadata: those
  placeholders cannot reach the screen.
- **The end-of-iteration opener is a CLI, and the skill is a wrapper with no logic in it.**
  `tools/ccd-review.mjs` is what an agent runs when it finishes; `.claude/skills/open-review/`
  only says to run it and how to read its exit codes. An MCP server was considered and declined —
  every agent can already run a shell command, so it would buy a second process, a config entry per
  agent and another thing to be down, for nothing. Exit **2** (no commits) is not a failure and must
  stay distinct from **1**: both sides of a preview are revisions that already exist, so an
  uncommitted tree is genuinely not reviewable here, and an agent needs to say that rather than
  invent a range. One coupling to know about: `ccd-session-start.sh` (a `sh` hook) and
  `ccd-review.mjs` (Node) must agree on `XDG_CACHE_HOME` **and** on the 16-hex-digit sha256 of the
  worktree path, or the writer files the session base where the reader never looks and the base
  silently degrades to `merge-base` — verified by running both, not by reading them.
- **Light mode is out of scope**, and `api.prewarm` was deleted rather than revived. Auto-prewarm
  on commit select stays disabled — see the comment in `selectCommit`; on a large repo behind a
  blobless partial clone it triggers thousands of on-demand blob fetches.

## Read-only, mechanically

This is a guarantee, not an aspiration, and the README states it publicly — so re-check it when
you touch the backend. Every git call goes through `git.ts`'s `run()` with an **argument array,
never a shell string**. The only subcommands invoked anywhere are `log`, `rev-parse`,
`for-each-ref`, `show`, `grep` — `diff-tree` left the codebase when `commitSpan` replaced the
per-commit `changedKtFiles`, and `ls-tree` left with `listKtFilesAtRev` when the resolver stopped
indexing whole revisions; nothing should bring either back. `grep` is read-only like the rest, but
it is the one that **cannot** be fenced with `--end-of-options` (see the constraint above), which
is why `/api/def`'s `rev` is whitelisted as `^[0-9a-f]{40}$` at the route and its `name` is both
length-capped and regex-escaped before it reaches argv. There is no write-capable fs API in the
backend at all — the whole surface is `readFile`, `realpath`, `stat`, `readdir`, `existsSync`,
`fs.watch`. `listCommits` carries three redundant injection guards (leading-`-` rejection,
`--end-of-options`, trailing `--`) plus a route-level whitelist pattern; keep all of them.
`/api/preview` follows the same shape: `shas` is whitelisted at the route as
`^[0-9a-f]{40}(,[0-9a-f]{40})*$` before it can reach git's argv, and capped at 100 entries.

## Commits

One concern per commit; refactors land separately from features. Conventional-commit subject,
then prose explaining **why**, naming concrete files and symbols. Review `git diff --cached`
before committing — and stage by explicit path, never `git add -A`.
