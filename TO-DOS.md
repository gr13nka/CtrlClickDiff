# TO-DOS

Nothing open. The backlog captured on 2026-07-23 is fully implemented — see the sections below
for what each item became, and `CLAUDE.md` — with `docs/internals/` behind it — for the constraints
that fell out of building them.

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
