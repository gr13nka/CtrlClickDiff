# The shell, and the rest of the UI

`shell.ts` and the modules it delegates to: `deeplink.ts`, `topbar.ts`, the palettes, `modal.ts`,
`repopicker.ts`, `filetree.ts`, `storage.ts`, `resizer.ts`, `live.ts`, plus `tools/ccd-review.mjs`.
Index: [`../../CLAUDE.md`](../../CLAUDE.md).

`shell.ts` is the spine: it owns every piece of frontend state and nearly every change touches it.
New logic belongs in its own module with a small interface, so `shell.ts` gains a call site rather
than another screenful. `topbar.ts` in particular knows nothing about repos, branches or commits,
because its interface is `setCrumbs(Crumb[])` and a crumb is only a label, a tooltip and a click
handler. The rule applies to what is *already* in `shell.ts` too: the resizer lived at its foot for a
long time behind a comment claiming self-containment, and moving it to `resizer.ts` is what made a
module boundary enforce the claim.

## Ordering hazards

**`switchRepo` clears the outgoing repo's state BEFORE `adoptRepo`, and the order is the point.**
`adoptRepo` sets `repo` and calls `renderTrail()` **synchronously**, and `renderTrail` decides which
crumbs exist by reading `branches`/`selectedRef`/`commits`/`selection`. Clearing after it paints the
new repository's name beside the previous one's branch and commit selection, and nothing repaints
until `loadBranches` returns a round trip later. Measured over CDP with 1500 ms of emulated latency,
switching from a repo parked on `feature/wide`: the header read
`["ccd-sample-repo-2", "feature/wide", "4221baf · …"]` where it should read one crumb. The stale
crumbs cannot leak an old refname into a new-repo request — everything is cleared in the same
synchronous turn — but a crumb that opens an empty palette is the affordance-that-lies hazard
`renderTrail` already guards against for the selection crumb.

**`updateAddressBar` writes nothing until a repository is adopted, and that guard is what stops the
feature destroying its own input.** It hangs off `renderTrail()`, which `initShell()` calls
**synchronously before `void boot()`** — so an unconditional write would replace an incoming deep
link with an empty URL in that same tick, before `boot()`'s `parseDeepLink(location.search)` ever
ran. `repo` stays `null` until `adoptRepo()`, reached only after `parseDeepLink` has returned, so
every call that could clobber a link is by construction one with an empty `repoPath`. Do not
"simplify" this into an ordering rule at the call site: the no-op is also simply true (a review with
no repository is not worth linking to), and a structural guard cannot be undone by someone moving a
line.

**`selection` comes from `/api/preview`'s own records, not from `selectCommits`'s caller.** The
caller-supplied version worked exactly when the caller already had metadata — true for a palette
pick, false for a selection named from outside the app, where a fresh page load has nothing to look
anything up in. `orderCommits` had to run `git log --no-walk` over the selection anyway, so asking it
for the record format instead of `%H` adds no process and no round trip, and answers for any commit
in the object database — including one older than the ref's 100-commit page or no longer on the ref
at all. This is why `loadCommits(initialShas)` may hand `selectCommits` bare SHAs wearing empty
metadata: those placeholders cannot reach the screen.

**Live refresh follows the tip only from a selection of ONE that is the tip.** A multi-commit
selection is a deliberate act, and "the tip moved" says nothing about whether the new commit belongs
in a set assembled by hand.

## Deep links

**A deep link's repository never falls back to recents or `defaultRepoId`.** `boot()` branches once
(`link ? api.registerRepo(link.repoPath) : preferredRepo(await api.repos())`) and reports the
backend's own refusal text on failure. Falling through would open a *different* repository than the
one the reader followed a link to, with nothing on screen saying so. The regression is invisible to
any test that checks only "did something load", which is why `verify-deeplink.mjs` asserts the repo
crumb still reads `Choose repository…` after a refused link.

**Adding a deep-link parameter is five places, and the third is the one that gets forgotten.**
`deeplink.ts` (both halves — they are in one file precisely so this is one edit), the line in
`shell.ts` that consumes it and names *which default it overrides*, `deepLink()` in
`tools/ccd-review.mjs` if the opener should emit it, the README's deep-link block, and a check in
`tools/verify-deeplink.mjs` — a parameter nothing asserts is a parameter that can stop working
silently. **Do not validate its shape in `deeplink.ts`**: carry it through untouched and let the
route that owns it reject it, the way `ref` and `shas` already do. A second copy of a validation rule
is the drift hazard, and the error path already exists.

Two smaller facts in the same file. `replaceState`, never `pushState` — the URL mirrors state rather
than recording a navigation, and on push the Back button would rewind the reader's own selection
history instead of leaving the page (measured as `history.length` unchanged across two selections,
which `tools/verify-deeplink.mjs` asserts rather than trusting the source). And the query is built by
hand while it is *read* with `URLSearchParams`: reading, that class's `+`-means-space rule cannot
bite because every producer percent-encodes; writing, it would corrupt a filesystem path.

## The status line and the busy pointer

**`setStatus` carries a severity, and the colour is the redundant half.** One slot holds "Loading
commits…" and "Error loading diff: …", and at one colour a dead request looked exactly like a slow
one. Errors render in `--ccd-danger`; every message that passes `'error'` already begins with the
word, so the red confirms rather than carries. The element is `role=status` (polite, not assertive —
this slot carries routine progress and would otherwise interrupt on every fetch). Check *recovery*
when touching it: a sticky error class leaves the next "Loading…" painted as a failure.

**The busy pointer is the other half of that slot, and its set/clear pair is deliberately
asymmetric.** `setBusy` writes `data-busy` on `#app` and index.html paints `cursor: progress`; during
a preview load the status line is 12px of grey in the corner of a 300px sidebar while the review
column still shows the *previous* selection, so the words alone were somewhere the eye was not. A
cursor rather than a spinner element because it renders beside the pointer wherever it already is —
it cannot cover a line of the diff, and there is nothing to append to a band that `band.ts` empties
on every render. Two things not to tidy. The CSS needs `.ccd-app[data-busy='true'] *` **and**
`!important`: Monaco sets `cursor: text` on `.view-lines` from a stylesheet it injects into `<head>`
at runtime, i.e. after index.html's and at matching specificity, so the bare rule leaves an I-beam
over the whole review — measured by reading `getComputedStyle('.view-line').cursor` back, which says
`progress` as written. And busy is *set* only for a load the reader asked for (`refreshRefs` passes
`background: true`, on its own rule that an unrequested poll does not take over the UI) but *cleared*
by whichever call is newest even if it never set it — match the two and a background refresh that
supersedes a user-initiated load strands the pointer on, because the superseded call is stale and
must not clear.

## The sidebar

**The sidebar follows the reader, not the other way round.** `activePath` is *reported by* the band
from what is at the top of the scroller, via an IntersectionObserver whose negative bottom root
margin turns the top 15% of the column into the "being read" zone. That is deliberately the whole
mechanism: no scroll listener, no rAF throttle, and no measuring every card every frame, which on a
several-hundred-card band is the difference between free and a forced layout per frame. When the zone
lands in a gap between cards there is no candidate, and keeping the previous answer is correct — the
reader has not moved to another file.

**What the sidebar reports must never outshout what the diff shows.** `activePath` used to render as
a full-bleed accent fill — 4.08:1 against the canvas, against a diff at 1.20:1, so a passive
scroll-position marker carried 3.5× the contrast of the thing it pointed at and was the strongest
shape on a blurred screenshot. Now a subtle surface plus a 2px inset accent rule: ratio 1.0×. The
blur test decides this, not an opinion.

**Every row of the sidebar is a control, both kinds.** `dirItem` had `role=button` + `tabIndex 0`
from the start and `fileRow` did not, so the tab order could expand a directory and then reach
nothing inside it — the destinations of the app's primary navigation were mouse-only. Making a row a
control also makes its accessible name audible, which is why the one-letter badge is `aria-hidden`
and the row is labelled "`<path>`, added": the letter is a glyph, and a glyph is a poor thing to
hear. The badge stays one letter, because that is the entire reason it is one. Deliberately *not* a
full `role=tree` with roving tabindex — matching the sibling pattern is what removes the blocker.

**Tree collapse state is in memory only.** A stale persisted collapse can hide a changed file from a
review, which is a correctness hazard. Sidebar width *is* persisted; that is a preference, not a view
of the data.

**The empty state lives in the band and carries an action.** "No reviewable source files changed"
used to be one muted 12px line in the corner of the sidebar beside 1290×850 of empty canvas — easy to
miss, and it named a fault without a remedy, so it read as a broken tool. It is now a block where the
reader is looking, with why it happened and a button into the commit palette
(`BandHooks.onChooseCommits`, a hook because the palette needs state only the shell has). The
languages are named as a *category*: a sentence spelling out a dozen suffixes stops being a sentence.

## Dialogs and storage

**The two palettes still do not share a palette abstraction — but all three dialogs share a modal
shell.** The distinction is the point. `modal.ts` owns the backdrop, the labelled `role=dialog`
panel, the click-outside guard and the capture-phase Escape handler, and it handles Escape then hands
every other key straight through. It owns **nothing** else: no row renderer, no search projection, no
group predicate, no footer slot, and deliberately not the active index, the clamp or the
scroll-into-view either — sharing those would need the shell to know each palette's `visible.length`
and to call back into its renderer. The rows are different shapes, the searches match different
fields, and choosing means different things. What triggered extracting the shell was not a third
palette but a third *modal* (the repo picker) plus evidence the duplication had stopped being
harmless: the three hand-written copies had drifted, two capturing Escape and consuming it while
`repopicker.ts` bubbled and did not. The revisit trigger for the palette itself is unchanged — a
**third palette**. The full argument is at the foot of `branchpalette.ts`.

**One guarded `localStorage`, and it is guarded because the property access itself throws.**
`storage.ts` is the only file that touches the API; in some privacy modes referencing `localStorage`
raises a SecurityError before `getItem` is ever reached, so the access must be *inside* the try. It
exports exactly `readStored`/`writeStored`/`removeStored`, all string-typed. Do not add `readNumber`
or `readJson<T>(key, guard)`: each would have one caller and would drag that caller's decision into
everybody's module — the resizer's blank-string guard exists so corrupt storage falls back to the
*stylesheet* default rather than to 220px, and the recents validator exists because an older shape of
this app may have written that key. Keys stay at their call sites; `storage.ts` knows none of them.

## The end-of-iteration opener

**It is a CLI, and the skill is a wrapper with no logic in it.** `tools/ccd-review.mjs` is what an
agent runs when it finishes; `.claude/skills/open-review/` only says to run it and how to read its
exit codes. An MCP server was considered and declined — every agent can already run a shell command,
so it would buy a second process, a config entry per agent and another thing to be down, for nothing.
Exit **2** (no commits) is not a failure and must stay distinct from **1**: both sides of a preview
are revisions that already exist, so an uncommitted tree is genuinely not reviewable here. One
coupling to know: `ccd-session-start.sh` (a `sh` hook) and `ccd-review.mjs` (Node) must agree on
`XDG_CACHE_HOME` **and** on the 16-hex-digit sha256 of the worktree path, or the writer files the
session base where the reader never looks and the base silently degrades to `merge-base` — verified
by running both, not by reading them.

Where the opener is extended is `open()` — one function, currently Orca then `xdg-open`, and the only
place that knows how a review reaches a human. Failing to open is deliberately a warning rather than
an error, because the URL on stdout is the part a caller can act on.

**Light mode is out of scope**, and `api.prewarm` was deleted rather than revived. Auto-prewarm on
commit select stays disabled — on a large repo behind a blobless partial clone it triggers thousands
of on-demand blob fetches.
