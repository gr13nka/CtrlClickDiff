# Theme, colour, and CSS

`packages/frontend/src/theme.ts` and the inline stylesheet in `packages/frontend/index.html`.
Index: [`../../CLAUDE.md`](../../CLAUDE.md).

**ALL CSS is inline in index.html**, with one deliberate exception: the stylesheet `peekscope.ts`
generates per gesture, whose selectors are built from paths only that module knows (see
[`peek.md`](peek.md)). It still uses index.html's `--ccd-*` tokens.

The governing rule, stated in index.html's palette comment: **chrome must never outshout the code.**
Every number below is a contrast ratio measured against the canvas, and the check that decides a
disagreement is the blur test — blur the screenshot and the dominant shape must be the changed
lines, not a border or a selection fill.

## The diff tint

**It is a constrained optimum with almost no slack, and three walls hold it there.** Line 13% /
word 6% puts an added line at 1.20:1 against the canvas and a removed one at 1.14:1 — up from 1.11
and 1.07, and that ~8% is the whole available win.

1. `comment` `#8b949e` is the darkest token in the theme and only 5.0:1 on bare canvas, and it must
   stay ≥4.5:1 read *through* line and word tints stacked. Swept in 1/255 steps the frontier is line
   `0x2c` / word `0x07`, and past line `0x2f` **no** word tint keeps AA.
2. Raising the line tint *costs* the word diff, which is read against the line under it: line
   `0x26`/word `0x0a` buys a 1.25:1 line and collapses the word highlight to 1.07:1, which is not a
   highlight.
3. The gutter looks like free contrast and is not — see below.

Two dead ends worth not re-walking: more alpha fails AA, and **no** alpha makes added and removed
distinguishable in greyscale (green and red at equal alpha land at the same luminance — 1.03:1 apart
at 8%, still only 1.13:1 at 28%), so the `+`/`−` glyph is the non-colour carrier and has to stay. The
one lever that would open real headroom is lightening `comment`, which changes how the theme reads
and needs its own commit. For calibration: GitHub dark's own added line is also 1.20:1 — a diff tint
simply *is* a low-contrast signal, so a "raise it to 3:1" instinct is wrong.

**The four `diffEditor.*Background` colours must be translucent 8-digit hex.** Monaco registers them
`needsTransparency`; an opaque tint paints over selection and search highlights inside a changed
line.

**`diffEditorGutter.*` stays at 15%.** Nothing but the line number `#6e7681` sits on it and it takes
20% before that drops under 3:1, so it looks like free contrast to spend. It was raised to 20% once
and put straight back: the gain on a modified file is marginal next to the line wash, and every point
also amplified the spacer bar below. Now that the spacers are painted, the argument is only the first
half — still not worth it, but re-measure rather than assume.

**`diffEditor.unchangedRegionBackground` defaults to `sideBar.background`**, a workbench colour
standalone Monaco never registers. Unset, the collapsed-region bars render unstyled.

## The alignment spacers

**Monaco paints its alignment spacers with the *removed*-line gutter colour, so a block of purely
added lines wore a red bar down its left edge** — both claims about the same rows at once, loudest in
inline mode where the bar sits directly against the green. A spacer is the margin view zone Monaco
inserts where one side has no line opposite the other; in the **original** editor that always means
the modified side gained lines, i.e. an addition (measured on `band.ts`: ten of them). A real
deletion is a *different* element (`cmdr gutter-delete`, and in inline mode
`inline-deleted-margin-view-zone`), which is what makes the fix targetable at all — there is no theme
key that separates them, since spacer and real deletion share `diffEditorGutter.removedLineBackground`.

**The fix is to paint the spacer with the *inserted* wash, not to clear it, and clearing it was tried
first and was half a fix.** Transparent removes the false red and leaves the added rows visibly
*shorter* than the removed ones, because a removed row's own `cmdr gutter-delete` does cover that
column. Measured on `diff.ts` at 1253px wide: removed spanned x=1..1252, added only x=43..1252, and
that 42px step is the original editor's line-number column. So the rule is
`.ccd-card .editor.original .margin-view-zones > .gutter-delete` with `var(--ccd-diff-inserted-line)`,
and **`theme.ts` publishes that custom property** at the foot of `installTheme` rather than the
stylesheet restating `#3fb95020` — the value's whole job is to equal
`diffEditor.insertedLineBackground`, and a spacer a shade off the block it belongs to is worse than
one left alone. Same reasoning that keeps `modelUri`/`parseModelUri` together. Check both edges when
touching this: added and removed must start at the same x, and in inline mode their right edges still
differ legitimately, because the word-diff spans end where the changed text does.

## The peek widget's colours

**An unset `peekView.border` is a saturated blue frame, because it is an alias of
`editorInfo.foreground`.** `peekView.js:232` registers it that way and the dark default is `#3794ff`
— measured **6.17:1** against the canvas, framing added lines that sit at **1.204:1**. Five times the
contrast of the content, spent on chrome. It is now `--ccd-border` at 1.55:1.

**The frame could not be quieted on its own**, and that pairing is the part not to undo:
`peekViewEditor.background` was `#0d1117`, bit-identical to `editor.background` (measured 1.000:1),
so the blue frame was the *only* thing saying "overlay". The peek now has its own raised surface
(`#161b22`, 1.094:1 against the editor behind it) with the list recessed to canvas under it, and
index.html carries the shadow — there is no theme key for one. Note the frame colour also paints
`.peekview-widget > .body`'s `border-top` and the arrow, via `_applyStyles`, so one key covers all
three. Raising the preview costs token contrast: `comment` `#8b949e` re-measured at **5.62:1** there.
Move that surface again and re-measure rather than assuming.

**Ten of Monaco's thirteen `peekView*` keys were unset for the whole life of the app**, so the widget
the tool is named after rendered half Primer and half VS Code — three different near-whites where
`--ccd-fg` was meant, `#3399ff33` on the selected row beside the app's own `#1f6feb`, and `#ff8f0099`
match highlighting, a 60%-alpha orange painted over the definition itself. Worth knowing when reading
that block: `peekViewResult.selectionBackground` applies **only** to a focused list and a row without
`.highlighted` (`referencesWidget.css:46`); outside that the generic `list.*` colours win, so setting
one without the other leaves two different selection colours.
