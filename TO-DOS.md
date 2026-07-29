# TO-DOS

Nothing open. The backlog captured on 2026-07-23 is fully implemented — see the section below
for what each item became, and `CLAUDE.md` for the constraints that fell out of building them.

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
