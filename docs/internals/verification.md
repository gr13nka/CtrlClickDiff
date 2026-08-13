# Verification

How this project is checked, and the specific ways a check here lies to you.
Index: [`../../CLAUDE.md`](../../CLAUDE.md).

## What exists

There is **no test runner** and adding one has been deliberately deferred.

```bash
pnpm typecheck                      # tsc --noEmit, strict, all 3 packages
pnpm smoke                          # per-grammar matrix (see below)
bash fixtures/make-sample-repo.sh   # regenerates both fixture repos
node docs/capture-screenshots.mjs   # regenerates the README screenshots (app must be running)
node tools/verify-deeplink.mjs      # the deep-link contract, in a real browser (app must be running)
```

`pnpm smoke` (`packages/backend/src/smoke.ts`) is a matrix over every registered grammar key, not a
single check: for each it loads the wasm, compiles its `tags.scm`, and parses a tiny sample,
asserting the capture names it promises actually appear. **A registered language with no `SAMPLES`
row is itself a smoke failure**, naming the language — a grammar nothing exercises can ship broken
without this noticing.

## Anything about how the diff *looks* must be measured in a browser

And **the fixture repos will lie to you.** Their Kotlin lines are short enough to fit any pane, so
the single largest problem in the reading surface — every line of real code clipped at the pane
edge — was invisible in all three committed screenshots. Audit against a real repository (this one
works: register it and deep-link a few of its own commits) and read numbers, not impressions.

- `.view-line` truncation is **not** `scrollWidth`, which returns a 1e6 sentinel on a Monaco line.
  Measure where the line's last span ends against the scrollable viewport's right edge.
- `.editor.original` exists in the DOM in single-pane mode too — Monaco keeps both inner editors and
  collapses one — so its **width** is the question, never its presence.
- Wait for a `.line-insert`/`.line-delete` decoration, not just `.monaco-diff-editor`: the editor
  element exists before the diff is computed, and a shot taken in that window shows an undecorated
  file that looks exactly like a regression.
- `getComputedStyle` rounds alpha to 2dp (`0.1255` → `"0.13"`), so a contrast check reading colours
  back from the DOM is slightly pessimistic against the 8-digit hex the theme declares.
- **Do not pass `--hide-scrollbars` to a Chromium you are auditing with.**
  `docs/capture-screenshots.mjs` passes it so committed images stay stable, which is right for that
  job and wrong for every other: it meant nothing ever rendered a scrollbar, so an unstyled 15px
  native bar sat down the edge of the band unnoticed, and it makes the review column 15px wider than
  it really is.

The blur and greyscale passes catch misallocated weight and are worth more than any single ratio:
blur the screenshot and the dominant shape must be the changed lines.

## Driving a real browser (CDP)

Most of what matters — peek rendering inside a diff, region auto-expansion on a jump, drag-resize
relayout — has no meaningful assertion outside a browser. Drive Chromium over CDP; Node 22 has a
global `WebSocket`, so this needs no dependencies. `docs/capture-screenshots.mjs` is the worked
example: read it before writing a new check.

**Hold the page focused for the whole run.** `Input.dispatchKeyEvent` with Escape drops headless
Chromium to `visibilityState: "hidden"`, and a hidden page has no rendering lifecycle:
`requestAnimationFrame` stops and **IntersectionObserver stops delivering**. Every editor in the
band mounts from an observer callback, so the next `render()` appends its cards and mounts nothing.
Measured on `feature/wide`: 12 `.ccd-card`, **0** `.monaco-diff-editor`, 0 `.loading`, empty status
line, no console error — with `observe()` called 30 times and the callback run **zero** times, while
the band's own box stayed a healthy 1292×856. `Emulation.setFocusEmulationEnabled` fixes it: same
script, 9 editors mounted, 10 after a scroll.

That was first mis-diagnosed as "opening a peek poisons the next render", and the bisect that seemed
to prove it (no peek → 9 editors, peek → 0) was really tracking whether an **Escape** had been
dispatched. Two lessons worth more than the bug: a symptom that survives reverting your own commits
is not thereby an app defect — it can be the harness — and when a whole class of UI silently stops
working under CDP, check `document.visibilityState` and whether rAF is still firing *before* reading
any application code.

**Launching Chromium is platform-specific.** On Linux, snap Chromium needs `--no-sandbox` and a
profile dir it can reach — `~/.cache` is **not** one: it fails to create `SingletonLock` and aborts
before the debugger binds, so it looks like "chromium never came up". Use a `mkdtemp` under
`~/snap/chromium/common/`. macOS has neither constraint but no `chromium` on PATH, so the `.app`
must be named outright and the profile goes in `tmpdir()`. Both harnesses branch on
`process.platform`.

Two more CDP details that cost time: a poll straddling a `Page.reload` rejects with *"Inspected
target navigated or closed"*, which is normal and must be swallowed; and a modal driven by two
separate `Runtime.evaluate` round trips is not the same test as one driven by a single evaluate — an
in-flight fetch can land in the gap and repaint what you were about to click. **Where a race is the
thing under test, do the whole gesture in one evaluate.**

**Do not `import()` a frontend module from the CDP console to test it.** Vite serves HMR-updated
modules under a `?t=<stamp>` URL, so a fresh `import('/src/api.ts')` can hand back a *second*
instance with its own module state — `api.ts`'s `pathById` comes up empty and the 409 recovery
appears broken when it is not. Drive the real UI.

## Testing the peek gesture

**Peek can only be tested by the gesture.** `editor.getAction('editor.action.revealDefinition')`
returns **null** in this standalone build — re-verified against monaco 0.55.1: of 55 supported
actions the only definition-ish one is `showDefinitionPreviewHover`, and `peekDefinition` is absent
too. Note the context menu *does* render "Go to Definition ⌘F12", so seeing it there is **not**
evidence the action is reachable from `getAction`. Peek comes from `definitionLinkOpensInPeek` plus
a real modifier+click, so a CDP test must compute the word's viewport position
(`editor.getScrolledVisiblePosition()` plus `getDomNode().getBoundingClientRect()`) and dispatch
`Input.dispatchMouseEvent` — a `mouseMoved` first, which is what makes Monaco resolve and underline
the link, then press/release. Assert on a `.zone-widget` appearing. Testing an action id passes
vacuously.

**Which modifier is platform-dependent, and Monaco decides it, not us.** `clickLinkGesture.js:59-70`
maps the default `multiCursorModifier: 'altKey'` through `isMacintosh`, so the trigger is **Cmd on
macOS** (CDP `modifiers: 4`) and **Ctrl everywhere else** (`modifiers: 2`).
`docs/capture-screenshots.mjs` derives it from `process.platform`. Nothing in `packages/frontend`
sets `multiCursorModifier` and it should stay that way. Two ways to read the platform off a running
instance: Monaco renders macOS keybinding glyphs in its context menu (`⌘F12`), and on macOS
Ctrl+click never reaches the page as a left click at all — the OS makes it a secondary click.

**A modifier-hover only underlines when a definition actually comes back**, so a broken resolver is
indistinguishable from a wrong modifier by eye — both are "nothing happens". Check `/api/def` with
curl before touching anything about the gesture. That mistake has been made once already: a dead
`git grep -P` was reported, reasonably, as "Cmd+click doesn't work".

**Two ways a peek assertion lies**, both of which produced a confident false failure. The peek's
rows are not the only things carrying an `aria-label`: each reference also has a description
(`"1 symbol in Label.kt, full path …"`). Selecting by `aria-label` *containing* a path finds one of
those first, and they are never marked — so a dimming check compares 1.0 with 1.0 and "fails" while
the feature works. Filter to labels that **are** the row label. Second: in the repo picker a single
click *selects* and `Open` acts on the selection, so clicking both in one turn opens whatever was
selected before. Wait for the header crumb to name the repo before continuing.

## Three ways a CDP check silently measures the wrong thing

All three produced a confident false failure while building the band:

- **Waiting on `.view-line` (or `.ccd-card`) is not waiting for the file you mean.** A card exists
  for every changed file the moment the preview lands but is empty until its editor mounts, and
  cards mount lazily. Wait on `.ccd-card[data-path="X"] .monaco-diff-editor`.
- **`window.__ccd.modifiedEditor` answers for the card at the top of the scroller**, which during a
  jump is not the destination. Measure inside the target card's own DOM.
- **A side-by-side card has TWO `.cursors-layer`s** and `card.querySelector` returns the *original*
  pane's, whose cursor sits wherever the alignment view zones put it. Scope to `.editor.modified`.

The same trap in the other direction: **an assertion that passes because the fixture is too small
proves nothing.** `feature/wide` cannot demonstrate bounded mounting, and the three-file default
selection cannot demonstrate centred reveal because its content is shorter than the viewport and
`scrollTop` cannot move at all. Check what the numbers *can* show before believing them.

**When you fix a bug, reproduce it first and record the numbers.** Several fixes would have been
unfalsifiable otherwise — "the reveal is wrong" means nothing next to "it scrolled to 1862px when
the line was at 2622px". The rule catches claims too: a commit message said the client now issued
one `/api/def` per Ctrl+click, and counting requests over CDP said two.

## Recorded baselines

**Ctrl+click latency has a baseline; beat it or explain why.** Against `~/lets-plot` (2646 `.kt`,
9.6 MB, blobless clone), one `/api/def` per identifier from `AestheticsUtil.kt` at `44db1f1a`:

| | whole-revision index | grep-scoped, cold | warm |
|---|---|---|---|
| `PlotSvgExport` (7 candidate files) | 11.56 s | 0.067 s | 0.040 s |
| `render` (60 candidates, 45 hits) | 11.56 s | 0.337 s | 0.032 s |
| `letsPlot` (a package segment) | 11.56 s | 0.230 s | 0.034 s |
| a word that is not a symbol | 11.56 s | 0.031 s | 0.029 s |
| RSS after one revision | +353 MB | +32 MB | |
| RSS after a second revision | +319 MB | **+0 MB** | |

End-to-end in a browser (mousePressed → `.zone-widget`) that is **51–100 ms**, including a
45-definition peek. The warm column is the one trade: it used to be 0.001 s off a resident index and
the grep now runs every time. 30 ms is imperceptible in a gesture and it is what buys bounded memory.

**Boot loads twelve grammars and the cost is bounded.** Kotlin-only boot ~670 ms → all 12 ~875 ms
(resolver init 61 ms → 251 ms), against a self-imposed budget of +1 s. RSS after boot ~141–147 MB →
~186–194 MB. The vendor wasms are ≈25 MB on disk, each read once at boot.

**Re-measuring is what proves the multi-language work didn't touch the resolve path.** Against a
fresh blobless clone at `4e92397b` (2723 `.kt`; `44db1f1a` is no longer reachable upstream):
`PlotSvgExport` 86 ms cold / 53 ms warm, `render` 330/41 (52 candidates, 45 hits), `letsPlot`
298/44, a non-symbol word 45/42 — within repo growth and noise. Kotlin has one `LANGUAGES` row so
`siblings` is `[kotlin]`, proven bit-identical before and after the siblings change by the same
resolver log line, byte for byte.

**The per-resolve log is the first thing to look at when a click feels slow:**

```
[resolver] render in 89ms (grep 42ms -> 51 candidates, 44 cached, parse 47ms) -> 45 hits
```

High candidate count means the identifier really is everywhere (check the line filter); a high
`cached` next to a high parse time means the cache is thrashing and `FILE_SYMBOL_LIMIT` is below the
candidate set; a grep far above a few tens of ms on a partial clone means a lazy blob fetch, i.e.
the network rather than this code.

## The fixtures carry cases that exist only to be verified

Deleting one silently removes the only way to see a behaviour fail.

**Repo B's `feature/scoped-defs`**: `render` is declared in both `near/Label.kt` and `far/Label.kt`
and called from `near/Caller.kt`, arranged so selecting only its second commit leaves the *nearer*
definition outside the review — the one Monaco's peek prefers on its own. Nothing else can show
Ctrl+click choosing between an in-review and an out-of-review candidate.

**Repo A's `feature/polyglot`** is the only non-Kotlin branch, and the only place three things show.
*A mixed-language preview*: one selection, four cards, four Monaco languages. *Per-file-language
scoping*: `render` is declared in both `tools/report.py` and `web/render.ts`, so a click on `render`
in `tools/cli.py` must resolve only the Python one. *The `.tsx` → `.ts` sibling case*: `render`
clicked in `web/App.tsx` (grammar `tsx`) must still find `web/render.ts` (grammar `typescript`).
Log lines: `render` from `tools/cli.py` — 17 ms, 2 candidates → 1 hit; from `web/App.tsx` — 13 ms,
2 → 1; `Greet` — 9 ms.

**`make-sample-repo.sh` edits in place with `perl -i -pe`, and `sed -i` is not a portable
alternative.** The two invocations building `feature/wide`'s second commit were GNU sed spellings
that had only run on Linux: BSD sed reads the argument after `-i` as a *mandatory* backup suffix, so
it consumed the following `-e` and died, and `\b` is a GNU extension it lacks, so even `sed -i ''`
would have written wrong content rather than failed. **Moving BRE patterns to PCRE is a
silent-corruption trap, not a syntax one:** `(`, `)` and `+` are literals in BRE and metacharacters
in perl, and the first attempt left `+` unescaped in `return base + if (order.status == …)` — perl
read it as a quantifier, matched nothing and exited **0**, so the commit carried content no one
asked for. Escape `( ) +` in any future edit there, and check the *bytes*, not the exit code.

**The generator is deterministic, so a frozen SHA is a real check — but only `feature/wide`'s tip
bites.** Dates are pinned and three runs produce identical tips for all seven branches. Repo A's
`main` is `4221baf` and `feature/wide` *branches from* it, so it is upstream of the in-place edits
and reproduces whether or not they worked — misleading enough to make one frozen-SHA check pass
vacuously. The tip that moves is `feature/wide`'s `339b80a` (12 files); compare that one.

**The screenshots went stale silently once**: the Primer dark theme and breadcrumb header shipped
while the README still showed a light Monaco and a `<select>` sidebar, and nothing caught it because
an image cannot fail a typecheck. Re-run the capture after anything that changes the chrome. It
selects `ccd-sample-repo` itself rather than trusting `REPO_ROOT`, so whatever repo the backend
booted with cannot leak into a committed image.
