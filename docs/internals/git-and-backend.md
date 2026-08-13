# git, and the rest of the backend

`packages/backend/src/git.ts`, `preview.ts`, `repos.ts`, `browse.ts`, `watch.ts`, `server.ts`.
Index: [`../../CLAUDE.md`](../../CLAUDE.md). The read-only guarantee itself is stated in the index —
this file is the detail behind it.

## `git grep`, which is where most of the traps are

**The grep is `-E`, and it must not go back to `-P`.** PCRE is an optional git build feature and
Apple's git — the only git on a stock macOS — does not have it: `git grep -P` answers `fatal: cannot
use Perl-compatible regexes when not compiled with USE_LIBPCRE` and exits **128**, which
`candidateFiles` rethrows because it only forgives exit 1. So on macOS every `/api/def` threw, no
definitions came back, and Ctrl/Cmd+click was silently dead — the whole feature, on a whole
platform, from one flag. The exclusion that used to need a lookahead is now `--and --not -e`, git
grep's own per-line boolean, and `\b` is now `[^A-Za-z0-9_]` brackets because BSD's `regcomp` has no
`\b` either; consuming the boundary rather than matching zero-width is invisible under `-l`.

**Probing `-P` with a plain word does not test `-P`.** git short-circuits a metacharacter-free
pattern to a fixed-string search before it ever reaches PCRE, so `git grep -P -e 'PEEK_OPTIONS'`
succeeds on a git that cannot do `-P` at all while `git grep -P -e 'PEEK.OPTIONS'` fatals. That
produced one confident "it works" before the real cause was found.

Equivalence was verified against lets-plot rather than argued, and should be re-run if this changes
again: the ERE form and the old PCRE pattern (applied through a Python oracle over the fixed-string
superset) select identical file sets — `PlotSvgExport` 8, `render` 52, `letsPlot` 51 of a 2280-file
superset, `file` 23 of 2584, `Copyright` 0 of 2576. The engine is not where the time goes: same walk
over 2651 `.kt` files, `-F` 81 ms / word only 90 ms / word plus exclusion 98 ms — matching is ~17 ms
against an 81 ms floor of reading the tree, so PCRE has nothing to win back.

**`git grep` accepts no `--end-of-options`, and that is why `/api/def` whitelists its rev.** It tries
to *resolve* the string as a revision (`fatal: unable to resolve revision: --end-of-options`). The
fence `listCommits` and `commitSpan` use does not exist for this subcommand, so `REV_PATTERN` at the
route is the only place the shape can be enforced. A second reason, measured on a blobless clone: a
bad rev is not a cheap local failure — `git grep` against a fabricated SHA answered `fatal: remote
error: upload-pack: not our ref`, having gone to the network first.

**Three more `git grep` facts, each of which silently does the wrong thing.** It **exits 1 when
nothing matches**, and no-match is the *common* case here (any word hovered that is not a symbol) —
`run()` rejects on non-zero, so `candidateFiles` catches code 1 and rethrows everything else. `-e` is
a **regex** unless you say otherwise: `Plot.vgExport` matched `PlotSvgExport`, so the identifier is
escaped before it goes in. And output records are `<rev>:<path>`, stripped by `rev.length + 1`
rather than by splitting on `:` because a path may contain one; `-z` avoids having to de-quote
`core.quotePath` escaping, and `--full-name` is what stops "`repoRoot` is the toplevel" from being
load-bearing.

Escaping is narrowed to exactly the ERE metacharacters. POSIX leaves `\` before an ordinary
character *undefined*, so escaping the harmless ones is not the safe side of the trade — it used to
also escape `/` and `-`, which GNU and BSD tolerate but no standard requires.

## `git log` and revision syntax

**`--not` is rejected after `--end-of-options`; `^<sha>` is not.** Both exclude commits from a walk,
but only the caret form is *revision* syntax — `--not` is an option, and everything after
`--end-of-options` is by definition not one (`fatal: bad revision '--not'`). `commitSpan` needs both
the fence and the exclusion, so it uses `^<sha>`.

**`git log --name-status` prints no files at all for a merge commit** unless
`--diff-merges=first-parent` (git ≥ 2.31). Without it a selected merge silently contributes nothing
to a preview, and an unselected one is never spotted as a source of leaked edits — "invisible" is
the wrong default for a review tool. First-parent because that is the "what did this bring onto the
branch" side, which is the question a reviewer is asking.

**`git log --no-walk` sorts a set of commits rather than walking history**, and fails the whole
invocation on the first unknown SHA. That is two jobs in one call — `orderCommits` uses it both to
put a selection in newest-first order and to prove every commit exists, so a stale tab after a
force-push produces one clean rejection instead of a preview computed from the survivors. It is
`log` and not `rev-list` purely to keep the permitted-subcommand list short.

**`COMMIT_LOG_LIMIT` is exported from `git.ts` and is the selection cap too.** A selection is
assembled out of commits the picker listed, so the log's page size *is* the ceiling `/api/preview`
enforces. These were two independent literal `100`s tied together only by a comment; raising one
without the other would have silently offered commits a selection was not allowed to name.

## What a preview means

**A preview's revision pair is per FILE, not per selection.** For each path,
`base = first parent of the earliest selected commit that touched it`, `head = the latest selected
commit that touched it` (`preview.ts`). This is the whole reason commits can be skipped out of the
middle of a range: everything the selection did to a path happened between those two points, so a
path only unselected commits touched vanishes from the review, and a path an early selected commit
touched is shown as *that* commit left it. A single span shared by every file would drag every
unselected commit's edits into files the selection merely brackets.

**Both sides of a preview are revisions that already exist.** That is what keeps `/api/file`, the
resolver and peek ignorant of the whole feature — they take a rev and a path, and a preview hands
them revs they already understand. Synthesising a tree would need `git merge-tree --write-tree`,
which **writes objects into `.git/objects`** and would end the read-only guarantee. Do not reach for
it.

**A file touched by both a selected and a skipped commit is shown, and marked.**
`A -> (unselected edit) -> A'` has no two-SHA representation, so those edits are unavoidably in that
file's diff. `PreviewFile.skippedShas` names the commits responsible and both the sidebar row and
the card header get a ⚠ whose tooltip lists them by subject — on the card as well as the row because
that is where the reader *is* when they wonder why a diff contains an edit the selection does not
explain. Hiding the file instead would drop a changed file from a review. Naming rather than
counting is deliberate: a count says something is off without saying what to do about it.

## Repos, browsing, watching

**Repo scoping is stateless.** There is no "current repo" on the server; every data route takes
`?repo=<id>`. That removes cache invalidation, cross-tab interference and the restart-to-switch
problem in one move. The registry is an append-only *validated-path* store, not active-repo state.

**`register()`'s validation order is the security property.** realpath → is-directory →
`rev-parse --show-toplevel` → containment checked **on the canonicalized toplevel**. Checking
containment on the input instead would let a caller name an allowed-looking subdirectory of a repo
that lives outside the browse root. Both sides are realpathed; that is what defeats a symlink.
`REPO_ROOT` skips the check on purpose — the trust boundary is the HTTP surface.

**`/api/browse` returns directory names only.** Never file names, contents, sizes or mtimes.
Symlinked directories are excluded outright (`Dirent.isDirectory()` is lstat-like).

**Monaco lowercases a URI's authority** in `Uri.toString()` (`vs/base/common/uri.js:546`), which is
what its model registry keys on. Model URIs are `file://<repoId>/<sha>/<path>`, so **repo ids must
match `^[a-z0-9][a-z0-9-]*$`** or a model is stored under one string and looked up under another.
`repos.ts` asserts this. The id is in the *authority* because an authority cannot contain `/`, which
is exactly why it is an opaque id rather than a path.

**Do not watch `.git` recursively.** On Linux that is one inotify watch per subdirectory and
`.git/objects/` alone is 256 fanout dirs. `watch.ts` uses two narrow watchers (the git common dir,
plus `refs/` recursively) and dedupes with a change token so `.git/index` churn is silent.

**Vite's dev proxy does not propagate upstream death.** A stream read directly errors ~2.5 s after
the backend dies; through the proxy it stays open 20 s+ with no `error` event. That is why the SSE
heartbeat is a named `ping` event and not a `: ping` comment — EventSource never surfaces comments
to script, so a comment gives the client nothing to time out against. `live.ts` runs a silence
watchdog on it.

## Process and configuration

**`start.sh` runs `set -m` so each half is its own process group, and that is the whole reason it
exists.** Signalling the `pnpm dev:backend` wrapper alone does not reliably take its `tsx watch`
child — or the backend that child spawned — with it, so the orphan keeps :5178 bound and the next
start either fails to bind or, worse, looks fine while serving the old code. With job control on,
`$!` *is* the process group id (grandchildren inherit it, measured), so `kill -- -$!` reaches the
whole tree. Two consequences before editing it: the script waits for the port rather than printing a
URL, because the backend loads the grammars and registers `REPO_ROOT` *before* it listens and both
are fatal on failure; and Ctrl+C is handled by a trap that `exit`s rather than falling back into the
script, so the "exited on its own" message stays true. Testing that trap needs a **real PTY** — bash
sets SIGINT to `SIG_IGN` for a job started with `&` from a shell without job control, and a signal
ignored on entry *cannot be trapped*, so backgrounding `start.sh` from a test script silently
disables the very handler under test and it hangs forever. SIGTERM is not ignored and is the cheap
check.

**`PORT` is not fully wired, on purpose-for-now.** `packages/frontend/vite.config.ts` hardcodes the
proxy target `127.0.0.1:5178`, so setting `PORT` moves the backend out from under the frontend.
`start.sh` warns when the two disagree rather than silently "fixing" it, and the README says so.
Making `PORT` real means teaching the Vite config to read the environment — a separate change.
