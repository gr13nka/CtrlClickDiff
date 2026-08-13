# The band and the diff editors

`packages/frontend/src/band.ts` (the review column) and `diff.ts` (one file's editor).
Index: [`../../CLAUDE.md`](../../CLAUDE.md).

The unit of *display* is the whole selection at once: `band.ts` stacks every changed file in one
scroller, one diff editor per file, and `diff.ts` makes those editors rather than owning one.
Nothing shows a single file any more, which is why `openFile` became `revealPath` — a click scrolls,
it does not load.

## Construction

**`PEEK_OPTIONS` is applied with `updateOptions` to both inner editors after construction**, not
passed to `createDiffEditor`. The M1 spike proved they do not propagate from the option bag. An
editor built without them looks completely normal and simply never peeks — no error, nothing wrong
on screen, the one feature this tool is named after silently gone.

Editors are created and disposed routinely as cards scroll in and out of reach, so what keeps that
safe is that **`createFileDiff` is the only place `createDiffEditor` is called.** Keep it that way;
the guarantee is structural, not a habit. The side-by-side/inline toggle still goes through
`updateOptions` (over `liveEditors`) and must keep doing so, and `viewOptions()` is *also* spread
into the construction bag — that is what makes a card mounted after a toggle come up in the new mode
rather than the stored one.

**An added or deleted file must not render side by side.** There is no "before", so one pane holds
nothing and Monaco fills it with diagonal hatch: measured on `deeplink.ts`, **1,195,936 px² of hatch
against 1,141,200 px² of visible card**, with all the content squeezed into the other 633px pane.
`viewOptions` therefore takes the file's status, and `liveEditors` is a `Map` from editor to status
rather than a `Set` — that pairing is the point, because `applyViewOptions` would otherwise push a
bare `renderSideBySide: sideBySide` over the override on the next toggle and put the empty pane
back. After: hatch is 3.7% of the card. Verify both directions: an added file must hold 42/1224
across a full Split→Inline→Split trip, and a modified file must still swing 633/633 ↔ 42/1224.

**Word wrap is on by default because the cap plus a sidebar leaves 633px a pane.**
`--ccd-content-w-max` used to claim it was "wide enough that neither pane wraps"; true of the
fixture repos, false of real code — this project's own `shell.ts` has 899px lines, so **113 of 113**
rendered lines of `deeplink.ts` were clipped, and Monaco's horizontal scrollbar is `opacity: 0`
until hovered so nothing said text was missing. The consequence: content height now depends on pane
*width*, so dragging the sidebar re-wraps and re-fires `onDidContentSizeChange`. That is not a loop
— measured across a full drag of the clamp and back, 20 writes, 14 distinct heights,
4667px → 5275px → back to exactly 4667px, zero further writes after release — because the guard in
`syncHeight` is against height→height and `scrollBeyondLastLine: false` keeps content height
independent of viewport height.

## Heights

**`IDiffEditor` has no `onDidContentSizeChange`.** It extends `IEditor`, not `ICodeEditor`
(`monaco.d.ts:6410`), so a card's auto-height subscribes to *both inner* editors — which are
`ICodeEditor`s and do have it (`monaco.d.ts:6107`) — and takes the max. Side-by-side pads the
shorter pane with alignment view zones while inline carries deletions as view zones on the modified
side; one of the two is always the full height and neither is always the one.

**`getContentHeight()` does account for lines hidden by `hideUnchangedRegions`** — 1037px collapsed
against 3136px expanded on the same 121-line file — which is what lets it drive a card's box.
**`scrollBeyondLastLine: false` is not cosmetic there:** 837px of that 3136px was trailing viewport
padding (856px pane − 19px line height, exactly), so with it on every card would end in a screenful
of nothing *and* the height sync would recurse, because content height would then depend on viewport
height.

**A card freezes its measured height before disposing its editor, and models are never disposed.**
That pair is the whole reason scrolling is stable and cheap: the frozen box means nothing below an
unmounted card moves (measured drift 0px over seven samples; total content height held at 16410px
across a full round trip), and the surviving models mean coming back costs no request at all
(`/api/file` calls: 28 before a full descent-and-return, 28 after). Monaco guarantees the second
half — a model handed over via `setModel` rather than the construction bag survives the editor's
disposal.

**`overflow: hidden` on a card is what stopped its sticky header sticking, for the whole life of the
band.** Any overflow other than `visible` gives an element a scrolling box, and a sticky descendant
sticks within its *nearest* such box — so `.ccd-card { overflow: hidden }` made the card its own
header's scrollport, and a card never scrolls, so `top: 0` resolved to the card's own top and the
header rode away with it. Measured before the fix, header top at scrollTop 400/1400/2400:
**−343 / −1343 / −2343**, never pinned once, while both the README and the rule's own comment
claimed it worked. The clip that rounds the editor's corners now lives on `.ccd-card-body`, which is
not an ancestor of the header. Two related facts: the header's `top` is the band's padding
**negated** (`--ccd-band-pad`, because a scroll container paints scrolled content over its padding,
so pinning at the content edge leaves a 12px strip of the previous lines showing above it), and
Chrome resolves a sticky offset against the scroll container's **content** box.

## Mounting and scrolling

**Lazy mounting is bounded by the viewport, not the selection, and the fixtures cannot show it.**
`/api/preview` caps commits (`COMMIT_LOG_LIMIT`) and nothing caps files. `feature/wide`'s 12 cards
are ~3240px of content against a mount window of viewport + 2×1200px ≈ 3256px, so every card
legitimately stays mounted there and "bounded" is indistinguishable from "broken" — a real 28-file
selection is what proves it (peak 7 of 28, tracking the viewport up and down).

Every editor mounts from an **IntersectionObserver** callback, which is worth knowing when the whole
column comes up empty: a page with no rendering lifecycle delivers no callbacks and mounts nothing.
See the visibility trap in [`verification.md`](verification.md).

**What lets the wheel reach the outer scroller is `alwaysConsumeMouseWheel: false`,** not
`handleMouseWheel: false`. The former defaults to **true**, and on true Monaco swallows a wheel event
it cannot use rather than letting it bubble. Both are set; only one is the interesting half.

**`revealLineInCenter` is unusable in the band** and `revealLine` is gone with it. A card's editor is
exactly as tall as its content, so it has no scroll room to move; the *outer* scroller does the
centring, from `getTopForLineNumber` plus the card's offset. A jump to `LongService.kt:100` puts the
cursor at 428px of an 856px viewport.

**`onDidUpdateDiff` is not "the diff is ready".** It is `Event.fromObservableLight` over the diff
model, so it fires on every transition including `result → undefined` during a `setModel`. The
readiness check is `getLineChanges() !== null`. Also: cursor move *before* reveal — it is
`onDidChangeCursorPosition` that expands a collapsed region, so revealing first computes a scroll
against a layout that is about to move. Measured: on a collapsed 121-line file `getTopForLineNumber`
answers with the top of the *fold*, so lines 1 and 2 report identical tops and a line-height probe
there reads **0**.

**Async entry points claim an epoch, and the band needs two levels of it.** `shell.ts` has one for
the load chain; `band.ts` has its own, bumped by `render()`, **plus a token per card** bumped
whenever that card stops wanting an editor. Both halves are load-bearing: a selection can change
while a dozen mounts are in flight, and independently a single card can be scrolled past while its
own mount is still fetching. A mount that resolves against either a stale epoch or a stale token
disposes its editor instead of adopting it — an orphan would keep laying itself out. This is where
`diff.ts`'s old single `diffEpoch` went. A stale call must also stay silent: the epoch holder owns
the status line.

## Churn, and model URIs

**Per-file churn comes from Monaco, not git, and will not equal `git diff --numstat`.**
`FileDiff.churn()` reads `getLineChanges()`, the same list the `.line-insert` tinting is drawn from
— so the header agrees with the coloured lines under it, which is the property that matters. On
`shell.ts` it reports +98/−14 where *every* git algorithm says +96/−12: both are valid diffs with
different hunk boundaries, and matching git would print a number contradicting the pixels. Two
counting bugs already fixed that would come back if the clamp is removed: a text model counts the
empty string after a trailing newline as a line and git does not (a whole-file add read "+113" for
112 lines), and `loadModels` hands an added file `''` for its original — one empty line — so the
same file read "−1". Both fall out of clamping each side to its own real line count.

**`modelUri` and `parseModelUri` are an inverse pair and live together in `diff.ts`.** Splitting them
(the parse used to sit in `defprovider.ts`) makes the segment layout a two-file edit whose half-done
version fails **silently at runtime** — cross-file peek just stops rendering — and never at
typecheck. Same reasoning as `initResizer` reading its clamp bounds back from CSS instead of
retyping them.

**A cross-file jump to a file the selection did not change says so.** It has no card, so
`revealPath` puts a message in the status line rather than doing nothing. The peek widget has
already rendered that definition inline, so the reader is not stuck. Worth knowing what the old
single-editor view did here before reviving it: it fell back to the selection's span, whose two ends
hold identical content for an untouched file, so it navigated to a diff of a file against itself
with every line folded away.

**Per-file collapse is in memory only**, for the same reason tree-collapse state is: a stale
persisted fold can hide a changed file from a review.
