# CtrlClickDiff — working notes

Read-only commit reviewer with Ctrl+click (Cmd on macOS) definitions. `README.md` explains what it
is and how to run it; this file is for changing it.

**This is an index.** The detail lives in `docs/internals/`, one file per subsystem, and those files
are where the hard-won facts are — the constraints that look arbitrary, the bugs already fixed once,
and the reasoning a reasonable person would otherwise undo. What stays here is what applies wherever
you are working.

## Open the file for what you are touching

Do not work from this page alone. Each of these records failures that are **silent** — a feature
that quietly stops existing, a number that is wrong without looking wrong — so the cost of not
reading one is not a compile error, it is a regression nobody notices.

| File | Open it when |
|---|---|
| [`docs/internals/verification.md`](docs/internals/verification.md) | Before writing or trusting **any** check. How to drive a browser over CDP and the many ways a check here measures the wrong thing, plus the recorded latency baselines and what each fixture branch exists to prove. |
| [`docs/internals/resolver.md`](docs/internals/resolver.md) | Touching how a click becomes a definition: tree-sitter, `tags/*.scm`, grammar assets, the read pool, the symbol cache, candidate discovery, or adding a language. |
| [`docs/internals/git-and-backend.md`](docs/internals/git-and-backend.md) | Touching anything that shells out to git, or `preview.ts`, repo registration, `/api/browse`, `watch.ts`, `start.sh`. Every subcommand here has a flag that silently does the wrong thing. |
| [`docs/internals/band-and-diff.md`](docs/internals/band-and-diff.md) | Touching the review column or a diff editor: card lifecycle, lazy mounting, heights, churn, reveal, the sticky header, split/inline, word wrap. |
| [`docs/internals/peek.md`](docs/internals/peek.md) | Touching anything Monaco renders in the peek widget, or the definition provider. Nearly every rule there fails invisibly — the widget just does not appear, or shows the wrong thing without complaint. |
| [`docs/internals/shell-and-ui.md`](docs/internals/shell-and-ui.md) | Touching `shell.ts` or what it drives: deep links, the status line and busy pointer, the sidebar, palettes and modals, `storage.ts`, the agent-facing opener. |
| [`docs/internals/theme-and-css.md`](docs/internals/theme-and-css.md) | Touching colour or CSS. The diff tint is a measured optimum with almost no slack, and "just raise the contrast" is the wrong instinct. |

The five traps most likely to bite someone who skipped the table, each with its full argument in the
file named:

- **`PEEK_OPTIONS` must be applied with `updateOptions` after construction**, never passed to
  `createDiffEditor`. An editor built without them looks entirely normal and simply never peeks —
  [`peek.md`](docs/internals/peek.md), [`band-and-diff.md`](docs/internals/band-and-diff.md).
- **The candidate grep is `-E`, and must never go back to `-P`.** Apple's git has no PCRE, so `-P`
  killed Ctrl+click on all of macOS — and probing it with a plain word wrongly passes —
  [`git-and-backend.md`](docs/internals/git-and-backend.md).
- **A CDP run must hold the page focused.** A dispatched Escape makes the page hidden, which stops
  IntersectionObserver, which stops every editor mounting — and it looks exactly like an app bug —
  [`verification.md`](docs/internals/verification.md).
- **`urilabel.ts` must be installed before anything else touches monaco**, or the peek's title prints
  a repo id and a SHA where the filename belongs — [`peek.md`](docs/internals/peek.md).
- **Repo ids must match `^[a-z0-9][a-z0-9-]*$`**, because Monaco lowercases a URI authority and model
  URIs are `file://<repoId>/<sha>/<path>` — [`git-and-backend.md`](docs/internals/git-and-backend.md).

## Shape

pnpm workspace, Node 22, ESM everywhere, TypeScript run directly by `tsx` — **the backend has no
build step**, and `packages/shared` is consumed as raw `.ts` source (`"exports": "./src/index.ts"`).
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
                    ALL CSS is inline in index.html — except peekscope.ts's
vendor/             12 prebuilt grammar wasms + build-grammars.sh, provenance in vendor/README.md
fixtures/           make-sample-repo.sh — generates the two test repos
docs/               README screenshots + capture-screenshots.mjs, and internals/ (above)
tools/              ccd-review.mjs (what an agent runs at the end of an iteration) +
                    ccd-session-start.sh (the base it measures from) + verify-deeplink.mjs
.claude/skills/     open-review — the wrapper that makes an agent run the opener. No logic.
m1-spike/           throwaway CDN spike, kept as historical evidence. Not built or tested.
start.sh            runs both halves in one terminal; the launcher the README leads with
```

`shell.ts` is the spine: it owns every piece of frontend state and nearly every change touches it.
New logic belongs in its own module with a small interface, so `shell.ts` gains a call site rather
than another screenful — see [`shell-and-ui.md`](docs/internals/shell-and-ui.md).

The unit of review is a **selection of commits**, not a commit. One commit selected is the ordinary
case; several is a "ghost squash". There is deliberately no second code path for the single-commit
case — `Preview` describes both.

## Verifying a change

There is **no test runner** and adding one has been deliberately deferred.

```bash
pnpm typecheck                      # tsc --noEmit, strict, all 3 packages
pnpm smoke                          # per-grammar matrix: every grammar loads, tags compile, samples capture
bash fixtures/make-sample-repo.sh   # regenerates both fixture repos
node docs/capture-screenshots.mjs   # regenerates the README screenshots (app must be running)
node tools/verify-deeplink.mjs      # the deep-link contract, in a real browser (app must be running)
```

Two standing rules, whatever you are changing:

- **Anything about how the diff looks has to be measured in a real browser, and the fixture repos
  will lie to you** — their lines are short enough to fit any pane, which is how every line of real
  code came to be clipped without a single screenshot showing it.
- **When you fix a bug, reproduce it first and record the numbers.** "The reveal is wrong" means
  nothing next to "it scrolled to 1862px when the line was at 2622px".

Both are expanded, with the specific traps, in
[`verification.md`](docs/internals/verification.md).

**No raw control bytes in source.** Three files have had to be repaired: a literal NUL in a template
literal makes git classify the file as *binary*, so `git diff` and `grep` stop working on it. Write
the escape sequence (`\u0000`), never the byte. `grep` reporting "binary file matches" on a `.ts`
file is the symptom; run this before any commit that touched a template literal:

```bash
python3 -c "import io,glob;print([p for p in glob.glob('packages/**/*.ts',recursive=True) \
  if any(c<9 or (10<c<32 and c!=13) for c in io.open(p,'rb').read())] or 'clean')"
```

## Read-only, mechanically

This is a guarantee, not an aspiration, and the README states it publicly — so re-check it when you
touch the backend. Every git call goes through `git.ts`'s `run()` with an **argument array, never a
shell string**. The only subcommands invoked anywhere are `log`, `rev-parse`, `for-each-ref`, `show`,
`grep` — `diff-tree` left the codebase when `commitSpan` replaced the per-commit `changedKtFiles`,
and `ls-tree` left with `listKtFilesAtRev` when the resolver stopped indexing whole revisions;
nothing should bring either back. `grep` is read-only like the rest, but it is the one that
**cannot** be fenced with `--end-of-options`, which is why `/api/def`'s `rev` is whitelisted as
`^[0-9a-f]{40}$` at the route and its `name` is both length-capped and regex-escaped before it
reaches argv. There is no write-capable fs API in the backend at all — the whole surface is
`readFile`, `realpath`, `stat`, `readdir`, `existsSync`, `fs.watch`. `listCommits` carries three
redundant injection guards (leading-`-` rejection, `--end-of-options`, trailing `--`) plus a
route-level whitelist pattern; keep all of them. `/api/preview` follows the same shape: `shas` is
whitelisted at the route as `^[0-9a-f]{40}(,[0-9a-f]{40})*$` and capped at 100 entries.

Synthesising a tree for a selection would need `git merge-tree --write-tree`, which **writes objects
into `.git/objects`** and would end this guarantee. Do not reach for it —
[`git-and-backend.md`](docs/internals/git-and-backend.md).

## Commits

One concern per commit; refactors land separately from features. Conventional-commit subject, then
prose explaining **why**, naming concrete files and symbols. Review `git diff --cached` before
committing — and stage by explicit path, never `git add -A`.
