# TO-DOS

Three small items open, all found by audit rather than by anyone hitting them — see below. The
backlog captured on 2026-07-23 is fully implemented; the sections after that record what each item
became, and `CLAUDE.md` — with `docs/internals/` behind it — holds the constraints that fell out of
building them.

## Open — found 2026-08-13

Each was found while auditing the macOS Ctrl/Cmd+click work and deliberately left alone: none was in
scope, and none is causing a problem today. Ordered by how much they actually matter. None needs
more than one session.

- **`peekscope.ts`'s `watching` latch can stick, silently disabling the peek nudge for the rest of
  the session.** `watching` is set `true` when a gesture starts watching for the widget, and cleared
  only from inside a `requestAnimationFrame` callback — either when the widget is found or when the
  1500 ms deadline passes. If rAF stops delivering before either (the tab is backgrounded, the
  window hidden, the page bfcached), it stays `true` forever, and `if (watching) return;` then makes
  every later `applyPeekScope` skip the watch. The reader loses the "prefer the in-review candidate"
  nudge with no symptom except that peek starts opening on the wrong file; only a reload clears it.
  The rendering-lifecycle behaviour behind this is the same one documented in
  `docs/internals/verification.md` — a hidden page stops rAF and IntersectionObserver both. A
  `visibilitychange` listener or a wall-clock fallback would do it; the fix should be *verified by
  making rAF stop*, not by reading the code.
  <br>**The only one of these three I would call a real bug.**

- **`peekscope.ts`'s `labelSelector()` loses its suffix on all but the last selector.** It returns a
  comma-joined selector *list*, and two callers concatenate ` .label-name` onto the string CSS binds
  a descendant combinator to the **last** item only. So with two or more in-review candidates, every
  one but the last gets `font-weight: 600` (and the italic rule) applied to the whole
  `.monaco-icon-label` — filename *and* directory — instead of just the filename span, which the
  code's own comment says is not what was wanted. Cosmetic, and invisible with a single candidate,
  which is the common case and why it was never noticed. Fix is to map the suffix onto each selector
  before joining. Needs a peek with ≥2 in-review candidate files to see: `feature/scoped-defs` in
  repo B is the fixture that has one.

- **`band.ts:213` discards a mount failure entirely.** In `mount()`'s rejection handler, the stale
  guard (`e !== bandEpoch || token !== card.token`) returns before `hooks.onError`, so a card whose
  editor failed to build while the reader scrolled past it produces no log, no status line and no
  trace of any kind — indistinguishable from a card that simply never mounted. Latent: nothing
  triggers it today, and it is *not* what caused the empty-band symptom investigated on 2026-08-13
  (that was a CDP harness artifact — see `docs/internals/verification.md`). Worth closing anyway
  because the whole class of "the review rendered no code and said nothing" is expensive to
  diagnose: log on the discarded path even when it is too stale to show the reader, and consider
  reporting a *count* of failures rather than letting each `setStatus` overwrite the last.

## Shipped — 2026-07-29 (ghost squash)

- **Ghost squash** — select several commits and read them as one combined diff, **skipping any
  of them**. Nothing is rewritten; both sides of every file's diff are revisions already in the
  object database, which is why peek and the symbol index needed no changes. Commits may be left
  out of the middle of a range: a docs-only commit disappears from a review of the code around
  it. The one case that cannot be exact — a file edited by both a selected and a skipped commit —
  is shown and marked ⚠ rather than hidden. See `preview.ts` and the design notes in
  `docs/internals/git-and-backend.md`.
- **The sidebar's four stacked pickers became a header breadcrumb** — `repo › branch › selection`
  — with the view toggles on the right. The sidebar is now only the changed-file tree.
- **Both `<select>`s became searchable palettes.** The app contains no `<select>` at all. The
  commit palette searches sha/subject/author at once and is where ghost squash is armed; the
  branch palette groups Local before Remote and marks the checked-out ref.
- **`/api/commit/:sha/files` became `/api/preview?shas=<csv>`.** A selection of one commit is the
  ordinary single-commit review, so there is no per-commit route beside it.

Known and deliberate: a ghost squash whose files sit at different head revisions builds one
tree-sitter index per distinct revision rather than one. The index is lazy and cached per rev, so
the cost is only paid for revisions actually Ctrl+clicked into.

## Shipped — 2026-07-29

### Navigation & Repo/Branch/Commit Selection

- **Repo picker** — a directory browser in the sidebar, sandboxed to `CCD_BROWSE_ROOT`
  (default `$HOME`), with a localStorage recents list. `REPO_ROOT` became optional and now only
  names the repo to open on first load. The backend holds no "current repo": every data route
  takes `?repo=<id>` against a validated, append-only registry with deterministic ids, so
  switching repos never needs a restart and two tabs cannot fight each other.
- **Branch selector** — `GET /api/branches` via `git for-each-ref`, grouped local/remote,
  defaulting to the checked-out branch, and coping with a detached HEAD.
- **Branch-aware commit picker** — `?ref=` threaded through `git log`, with commits now labelled
  `sha · date · subject` so refs months apart are distinguishable.

### Sidepanel / File List UX

- **Resizable sidebar** — drag handle on a real grid track, pointer capture, clamped 220–640px,
  width persisted. Monaco relayouts by itself (`automaticLayout` is `ResizeObserver`-backed).
- **Filename-only rows** — fell out of the tree: leaves render basenames, full path stays in the
  row's `title`. The remaining real bug was CSS — `.ccd-file-path` could not ellipsise without
  `min-width: 0`.
- **Tree view** — `filetree.ts` builds it client-side and collapses single-child directory
  chains, so a six-level Kotlin package renders as one row instead of six.

### Theming

- **GitHub Primer dark** across the chrome and Monaco. This also fixed a real bug: no theme was
  ever set, so the diff editor had been running Monaco's default *light* theme inside dark
  chrome. Syntax colours are Primer's, and the word-diff tint was lowered to 10% to keep every
  token above WCAG AA over the diff backgrounds.

### Diff View Modes

- **Inline / side-by-side toggle** — via `updateOptions`, never by re-creating the editor, which
  would silently drop peek.
- **Collapsed unchanged regions** — on by default at `git diff -U3` context, with a toolbar
  escape hatch.

### Added during the work, not in the original backlog

- **Live updates** — the backend watches the selected repo's refs and pushes changes over SSE, so
  a commit made in another terminal reaches the picker in ~200ms. It follows HEAD only if you
  were already on the tip; an older selection is left alone.

### Fixes uncovered along the way

Each of these was reproduced before being fixed:

- The symbol resolver kept a single `activeRevision` slot that `resolve()` read, so two
  concurrent `/api/def` calls answered from each other's index — including a phantom definition
  in a file that did not exist at that revision.
- `selectCommit` and `createDiff` had no in-flight guard, so a slow earlier response could
  overwrite a newer one and leave the diff showing a different file than the sidebar highlighted.
- Cross-file jumps revealed before moving the cursor, and before the diff had been computed —
  scrolling to 1862px for a line that turned out to be at 2622px, and leaving the target entirely
  off screen once regions could collapse.
- Live updates died permanently after any backend restart: Vite's proxy does not propagate
  upstream death, and the SSE heartbeat was a comment, which `EventSource` never surfaces.
- Two source files carried literal control bytes, which made git treat them as binary.
