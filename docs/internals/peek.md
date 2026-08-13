# The peek widget

`defprovider.ts`, `urilabel.ts`, `peeklayout.ts`, `peekscope.ts`, and the Monaco internals they lean
on. Index: [`../../CLAUDE.md`](../../CLAUDE.md). The colour keys are in
[`theme-and-css.md`](theme-and-css.md); testing the gesture is in [`verification.md`](verification.md).

Nearly everything here fails **silently** when it is wrong — a peek that does not open, a title that
prints a SHA, a marking selector that matches nothing all look like "no feature" rather than "a
bug". That is why each of these has a measurement attached.

## Getting the widget at all

`PEEK_OPTIONS` must be applied after construction — see
[`band-and-diff.md`](band-and-diff.md#construction).

**Disabling Monaco's TypeScript language service means turning off every flag, not just
diagnostics.** `main.ts` calls `setModeConfiguration` on both `typescriptDefaults` and
`javascriptDefaults` with every field false (`completionItems`, `hovers`, `definitions`, …). Left
partially on, the service registers its own definition provider beside `defprovider.ts`'s — and its
"project" is every `.ts`/`.js` model in Monaco's registry, which deliberately spans multiple
revisions, so its answers cross revisions and are wrong by construction. Measured: a Ctrl+click on
`render` in `App.tsx` peeked `Definitions (2)` before every flag was off. Monarch colorization is
unaffected (it isn't the worker), `ts.worker` never spawns with everything off, and `monaco-env.ts`'s
worker routing stays as the guard if one ever does.

## The label service

**A `getUriLabel` override is what stops the peek printing the repo id and the SHA, and where it is
called is load-bearing.** Standalone Monaco answers `uri.fsPath` for any `file:` URI
(`standaloneServices.js:584-589`), and ours are `file://<repoId>/<rev>/<path>`, so the peek's title
read `//ctrlclickdiff-66caac9c/c3ebf28e…/packages/frontend/src` — 89 characters where the directory
belonged. It ellipsizes, so at the default width the noise pushed the *filename* off its own title
bar (`storag…  //ctrlclickdiff-…  - Definitio…`). `urilabel.ts` replaces the service and `main.ts`
calls it **first, before anything else touches monaco**. Not a style preference:
`StandaloneServices.initialize` is `if (initialized) return`, and it is not the only initializer —
`StandaloneServices.get` initializes with no overrides when it arrives first
(`standaloneServices.js:716-719`), and `registerDefinitionProvider` (`standaloneLanguages.js:375`),
`registerEditorOpener` and every `createModel` all go through it. Placed beside `installTheme()` it
had already lost, silently, and only the peek-marking check caught it.

## Sizing

**`peekViewLayout` in the storage service is the supported way to size a peek.** The controller reads
`{ratio, heightInLines}` from `IStorageService` on **every** open (`referencesController.js:85-86`)
and writes it back on close, so seeding that key is how `peeklayout.ts` gives a single-definition
peek its width back (preview 428px → 512px) without touching the private `_splitView`. CSS alone
cannot do it — SplitView calls `preview.layout({width})` with the width it computed, so restyling the
box leaves Monaco's editor laid out to the old one. Two limits: the list's `minimumSize: 100`
survives any ratio, and the controller's write-back means a reader's sash drag is overwritten (which
is why `heightInLines` is read back and preserved, and only the ratio is decided).

**The rule that hides that 100px remnant is keyed on the widget's own content, and a flag there
races.** The first version set an attribute on `<html>` from the definition provider. Monaco resolves
on modifier+**hover** as well as on click, and the peek's preview is itself an editor with the
provider registered — so a hover *inside* an open peek rewrote the flag and the hidden list
reappeared under the reader. Reproduced over CDP, not theorised. The selector is now
`.ref-tree:has(.monaco-list-rows > .monaco-list-row:only-child)`, which cannot disagree with the
widget it describes. No `:has()` circularity, because `display: none` changes the box tree while
selectors match the DOM tree — verified, since getting that wrong flip-flops rather than fails.

## Which candidate the peek opens on

**Peek chooses its own first candidate, and it is not the one the provider returned first.**
`provideDefinition`'s array is re-sorted by URI (`referencesModel.js:120`), so the list is
alphabetical by path; the candidate the widget *opens on* is `nearestReference` — longest common URI
prefix with the clicked file, i.e. directory proximity (`referencesController.js:152`, reached
because Ctrl+click builds `DefinitionAction` with `openInPeek: true`,
`goToDefinitionAtPosition.js:246`). Our order still decides `firstReference()`
(`goToCommands.js:143`), which is the *jump* a click inside the peek preview takes — so the
in-review-first partition in `defprovider.ts` is not decoration, it just does not do what a reader
assumes. **Do not try to fix the peek's choice by reordering there; it has no effect at all.** The
lever that would work, `definitionLinkOpensInPeek: false` + `gotoAndPeek`, jumps the band to the
target file *before* peeking, which loses the reader's place. `peekscope.ts` nudges the selection
instead.

**A peek row's path is in `aria-label`, not `title`, and one candidate file means no file rows.** The
rows are `IconLabel`s with `custom-hover="true"`, so the native title the label API implies is never
written; `aria-label` is built from the `title` option (`iconLabel.js:88-93,124`), which
`referencesTree.js:113` fills with `ILabelService.getUriLabel(uri)` — so it holds exactly whatever
`urilabel.ts` answers. **That is why `peekscope.ts`'s `rowLabel` IS `urilabel.ts`'s `modelUriLabel`,
not a second implementation of it** — same inverse-pair hazard as `modelUri`/`parseModelUri`, and it
fails the same silent way: a selector that matches nothing looks exactly like a peek with nothing to
mark. With a single candidate file the tree's input is that group (`referencesWidget.js:451`) and
the list is bare reference rows, so there is nothing to mark — which is also why
`docs/screenshot-peek.png` (a `shout` peek, one file) is unaffected by any of this. Marking is CSS
rather than classes set from an observer because `monaco-list` recycles rows: a class outlives the
file it was set for, an attribute selector cannot. That generated stylesheet is the one exception to
"ALL CSS is inline in index.html"; it still uses index.html's `--ccd-*` tokens.

**Nudging peek's selection is two clicks, and the second needs the frame after the first.** Monaco
expands only the group it revealed into, so the target's reference row does not exist yet: clicking
the file row creates it, and only a click on a *reference* row moves the preview (a file row is
ignored — `referencesWidget.js:360-378`; a single click is `show`, which the controller does not act
on). The expand is a tree re-render, not a synchronous insert — reading the rows back in the same
turn finds the list unchanged, which is how the first version selected the right file row, clicked
nothing, and left the preview where it was. And the nudge waits three frames after `.selected`
appears: acting the moment it does cuts across the reveal Monaco still has in flight, which surfaced
as an unhandled `Canceled: Canceled`. All three were found by measuring, in that order.

**An out-of-review peek row is greyed, not labelled, and that was measured rather than chosen.** A
"· not in this commit" suffix was written and taken out: the tree pane is ~150px, a filename needs
~52px and the note ~95px, so the two cannot both render. Pinning the note clipped the *filename* to
"L…" — a row that no longer says which file it is has given up its whole job — and leaving it
unpinned ellipsized the note itself to "· not in this…", which reads as broken. Dimming plus italic
says the same thing in no space at all. If the grey ever needs words, the place with room is the
title bar, not the row.

## The provider

**`/api/def` is memoized on the client, bounded, and the bound is why it may persist.** Monaco calls
`provideDefinition` twice per Ctrl+click. An in-flight-only map was written first and measured: it
left the count at **two**, because the two calls do not overlap — the hover resolves about a second
before the mouse goes down. Only a retained answer removes the second request; storing the promise
still covers the overlapping case. Retaining is sound because `(repoId, rev, file, line, name)` names
immutable content, so a bound (256, LRU) rather than an expiry keeps it honest. Rejections are
evicted — a failed fetch is not an answer, and caching it would make one network blip permanent for
that word. It memoizes the **fetch** only: both provider bodies must still run, because each calls
`applyPeekScope`, and returning early from the second would silently break the out-of-review nudge.

**The review scope reaches the gesture through one predicate, `shell.isInReview`.** The band uses it
to decide a path has no card and `defprovider.ts` uses it to split the candidate list; they are the
same question and must never answer differently. It is passed into `registerDefinitions` rather than
imported, so that file keeps no ambient state of its own — a resolution belongs to the model it
started from, the review it is judged against belongs to the shell.

## Two known, unfixed defects in `peekscope.ts`

Found in an audit, recorded rather than fixed — both are on the backlog in
[`../../TO-DOS.md`](../../TO-DOS.md), with the reasoning and how to verify a fix:

- `labelSelector()` comma-joins selectors and its callers append ` .label-name`, which CSS binds to
  the **last** item only. With ≥2 in-review candidates, all but one get `font-weight: 600` on the
  whole label instead of just the filename.
- `watching` is a latch cleared only inside a rAF callback. If rAF stops (backgrounded tab) it stays
  `true` and every later nudge is skipped for the rest of the session, with no recovery path.
