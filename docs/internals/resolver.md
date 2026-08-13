# The resolver, and the language registry

`packages/backend/src/resolver/` plus `packages/shared/src/languages.ts` — how a Ctrl/Cmd+click
becomes a set of declarations. Index: [`../../CLAUDE.md`](../../CLAUDE.md).

## The shape of the answer

**`SymbolResolver` is ONE method, and asking is the whole interface.** There used to be a
`buildIndex(repoRoot, revision)` beside `resolve`, whose only documented rule was that callers await
it first — a step that existed to be awaited. It was there because the tree-sitter implementation
could not answer without parsing every file at the revision, and that is a fact about *that
implementation*, not about the question. `POST /api/index` went with it (keeping a route whose whole
semantics is "index the revision" would be a live re-entry point into the bug), and
`listKtFilesAtRev` went too, so **`ls-tree` left the codebase**. An implementation that needs
preparation does it inside `resolve`, at the scale the query needs.

**The resolver's work is proportional to the identifier, not to the repository.** `git grep` names
the files that mention the name; only those are read and parsed. This is why there is no prewarm and
no first-click penalty to amortize. Candidates are partitioned same-file-first **before** the reads,
not after: the pool completes out of order, so ordering results afterwards would make the answer
depend on scheduling. `candidateFiles` sorts with a plain `sort()` and **not** `localeCompare`,
which would make the answer depend on the machine's `LANG`.

**The resolver holds one mutable field.** It used to keep an `activeRevision` slot that `resolve()`
read, which made two concurrent `/api/def` calls answer from each other's index — observably, a
phantom definition in a file that does not exist at that revision. `resolve()` now takes
`(repoRoot, revision)` and is a pure function of its arguments. Do not reintroduce a "current"
anything.

**`DefQuery.lang` was deleted rather than widened**, and the rule that replaced it is *a definition
is resolved within the language of the file you clicked in*. The field was a `'kotlin'` literal
carried by every layer and read by nothing. A declared language can disagree with the file it names;
a derived one cannot. A field that can be derived is a field to delete.

## Candidate discovery

**It ignores `import`, `package`, `//` and `*` lines, and those are filters, not heuristics.**
Boilerplate at the top of every file otherwise makes ordinary words cost a whole-repo parse. The
*package line*: `letsPlot` matched 2274 of lets-plot's 2646 files, 6.70 s. The *license header*,
which every file there carries: `Copyright`, `license`, `source`, `code`, `found`, `file`, `this`,
`that` matched ~2571 files **each**, 9.4–15.0 s. Both also thrashed the cache. Both sit at the top
of every file, exactly where a reader with the modifier held drags the pointer.

Measured with both excluded: `Copyright` 10.1 s → 0.040 s, `license` → 0.036 s, `file` 15.0 s →
0.204 s, `source` → 0.203 s, `code` → 0.077 s. Real identifiers barely move — `render` 57 → 51
candidate files, `apply` 348 → 335, `size` 696 → 662 — which is the point: this removes noise, not
signal, and hit counts are unchanged.

Nothing can be lost, because a declaration cannot appear on an `import`/`package` line nor on one
whose first non-space characters are `//` or `*`. Verified rather than argued: across eleven
identifiers, 15025 files were dropped and **every** line mentioning the name in them was a comment,
import or package line — 0 exceptions. An extension function (`fun Foo.bar()`) is on a `fun` line
and survives; `import a.b.C as render` is an alias, not a declaration, and is correctly gone.

**`/*` is deliberately not in the list, only `*`.** A line opening a block comment can legally close
it and then declare something (`/* note */ fun foo()`), so excluding it would stop being a filter; a
line *starting* with `*` is a continuation or terminator and cannot be anything else. Prefixes are
per language (`Language.nonDeclaringLinePrefixes`); a boundary is appended only to those ending in a
word character (after `//` it would demand a word boundary between two non-word characters and never
match), and the name is escaped because it reaches git as a regex.

The `git grep` flags themselves — including why it is `-E` and must never go back to `-P` — are in
[`git-and-backend.md`](git-and-backend.md).

## Caching, memory, and the pool

**The per-file symbol cache is bounded, and the bound is the point.** Key is
`(repoRoot, revision, path)`, ~6.2 KB an entry measured, capped at 2000 (~12 MB). The old
per-revision index had no cap and grew RSS ~320 MB *per revision*, so a ghost squash spanning ten
revisions cost ~3 GB. No TTL — `(repo, rev, path)` names immutable content, the same reason
`diff.ts` never disposes a model, so an entry cannot become wrong, only surplus. Entries are
**promises**, which buys in-flight coalescing for free and costs nothing because the promise is
infallible by construction. The cap must stay comfortably above the largest realistic candidate set:
it was 2000 against a *believed* worst of 264, and the real worst turned out to be 2274 (a package
segment), which thrashed until the import/package filter cut it to 57.

**Delete every tree-sitter tree, and let nothing derived from one outlive it.** Trees are WASM
pointers and are **not** garbage collected; the old whole-revision index leaked one per file per
revision, most of its ~320 MB. `readSymbols` deletes in a `finally`, and `toDefMatch` copies
`node.text` and `startPosition` out *before* that — `Node`, `QueryMatch` and `QueryCapture` all hold
into the tree's arena, so the natural refactor (return the match, classify it later) is a
use-after-free that typechecks perfectly. `Query` also has `.delete()`; **do not call it** — a query
is compiled once per language and reused, a tree belongs to one parse. One shared `Parser` per
language is safe under the read pool only because `parse()` is *synchronous*: the concurrency is on
the I/O. Do not add a parser pool.

**The read pool interleaves read and parse, and 8 is a measured plateau, not a preference.** On 264
candidates: sequential 557 ms; concurrency 4/8/16/32/64 gives 267/260/267/267/274 ms. Reads plateau
at 4 because libuv spawns processes on the loop thread, so every `execFile` costs ~1 ms of
*main-thread* work however many are in flight. 8 rather than 4 because end-to-end, reads overlapping
parses, it measured 803 ms against 1007 ms. The tempting tidy-up — await every read, then parse in a
loop — is a single 313 ms synchronous block, because the await on each subprocess is the only thing
yielding the event loop (measured max lag as written: 27 ms).

**`git cat-file --batch` was measured and declined.** 264 blobs: 24 ms batched against 260 ms as
individual `git show` spawns. An 11× ratio on a number that is *not* the bottleneck — parse is
313 ms in the same query — so it would take the worst identifier from 803 ms to ~570 ms and the
typical one from 37 ms to ~35 ms, in exchange for a new subcommand, the first place the backend
writes to a subprocess's stdin, a length-prefixed protocol parser, and bypassing `run()`. The
trigger to revisit is a number: a p95 over ~1 s that profiling attributes to blob reads.

## Tags queries

**Tree-sitter's query language has no "else", and an unconstrained fallback double-captures rather
than losing to the specific pattern.** A function-valued `variable_declarator` →
`@definition.function` and any `variable_declarator` → `@definition.constant` both match the SAME
node when the general pattern carries no negative constraint — `query.matches()` fires both, and the
resolver does not dedupe by location, so one declaration answers twice. `tags/typescript.scm` and
`tags/javascript.scm` enumerate the *complement* of the function-ish expression types straight out
of each grammar's `node-types.json` instead. Measured: before that negative list,
`const arrow = () => {}` produced two captures at the identical location.

**An upstream tags.scm pattern can compile clean and capture nothing.** tree-sitter-python's own
`tags.scm` wraps a top-level assignment in `(expression_statement (assignment ...))`, but
`expression_statement` is a `supertype` in the grammar — supertype rules are elided from the
concrete tree, so the wrapper never appears and the pattern matches zero nodes, silently, with no
compile error. `tags/python.scm` anchors on `assignment` directly. The lesson generalises: verify a
pattern's captures empirically against the built wasm, upstream-authored or not.

**web-tree-sitter 0.26 renamed its runtime wasm, and that was silently masked.** It used to publish
as `tree-sitter.wasm`; 0.26 renamed it to `web-tree-sitter.wasm`. `treeSitterRuntimeWasm()`
(`resolver/grammars.ts`) looked for the old name on both resolution paths and had been returning
`undefined` on every 0.26.x install — masked because `Parser.init()`'s default `locateFile` falls
back to fetching the wasm next to the loaded JS, which happens to still work under `tsx`. Check it
again on the next upgrade; this is exactly the kind of rename that fails both paths silently.

## The language registry

`packages/shared/src/languages.ts` held one entry (kotlin) for a long time, having already replaced
thirteen literals across three packages that were drifting in *kind* (`'.kt'` as a suffix test,
`'*.kt'` as a git pathspec, `'kotlin'` as a Monaco language id, `'kotlin'` as an HTTP enum). It named
**a second grammar** as the trigger to revisit. That fired once, for TypeScript; the other nine
languages needed nothing new. Ten languages in, the seam itself has not moved: a language is a row
here, an assets row in `resolver/grammars.ts`, a hand-authored tags file, a vendored wasm with
recorded provenance, and a `smoke.ts` sample. **`Language.id` still IS Monaco's language id**,
deliberately — that identity is what makes `registerDefinitionProvider` and `createModel` agree by
construction, and there is still no `monacoId` that would always equal `id`.

What the second grammar actually forced:

- **`Language.grammar?`** — one Monaco language id can cover two tree-sitter grammars. `.ts` and
  `.tsx` are both Monaco's `typescript`, but tree-sitter-typescript ships two wasms because the
  plain grammar cannot parse JSX; `grammarKeyFor(lang)` (`lang.grammar ?? lang.id`) is the only
  place that fallback may live.
- **`resolve()` greps every same-id sibling's extensions**, not just the clicked entry's own, so a
  definition in either extension is findable from the other; each candidate is then parsed with its
  own path-derived grammar, never the clicked file's. `TreeSitterResolver.init` boot-asserts that
  every group of same-id entries declares element-wise identical `nonDeclaringLinePrefixes` — if a
  `.ts`/`.tsx` pair disagreed, the same identifier would be filtered differently depending on which
  file the click started in, silently, since the filter only narrows and never errors.
- **`assertDefinitionKinds` runs at boot**, not at the first unlucky click. Any `definition.<kind>`
  outside `{class, function, constant, type}` fails boot, naming the grammar and the capture.
  Upstream conventions use kinds this resolver doesn't recognise (`definition.method`, …); every
  tags file here is authored against these four and normalised, never copied verbatim.
- **Registry row order is load-bearing in exactly one way:** `languageForPath` is first-match-wins on
  extension suffixes. Every extension set is disjoint today, so order is only convention — except
  `.h`, which `cpp` claims alone, deliberately: a `.c` file's click on a macro declared in a `.h`
  cannot find it, an accepted limitation recorded on the `c` entry rather than a bug.
