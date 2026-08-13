// shell.ts — Milestone 4 "usable shell": commit picker + changed-file
// switcher. See peekdiff-mvp-iterative-wind.md, "Milestone 4 — Usable
// shell". Vanilla DOM, no framework.
//
// revealPath() is the single "take the reader to this path" entry point. Both
// sidebar row clicks (below) and defprovider.ts's registerEditorOpener (via
// window.__ccd.openPath, wired in main.ts) call it — so a cross-file F12 jump
// and a manual sidebar click behave identically.
//
// The diff itself lives in band.ts: every changed file is stacked in one
// continuous scroll, so the sidebar no longer picks *which* file is shown, only
// where in the column to jump to. Which file is "active" therefore comes back
// the other way, from the band's report of what the reader has scrolled to.

import type * as monaco from 'monaco-editor';
import {
  type BranchInfo,
  type CommitInfo,
  type FileStatus,
  type Preview,
  type PreviewFile,
  type RepoEntry,
  type ReposListing,
} from '@ctrlclickdiff/shared';
import { api } from './api';
import { initBand, type Band } from './band';
import { openBranchPalette } from './branchpalette';
import { openCommitPalette } from './commitpalette';
import { parseDeepLink, updateAddressBar, type DeepLinkRequest } from './deeplink';
import { buildFileTree, type TreeNode } from './filetree';
import { watchRepo, type LiveStream } from './live';
import { forgetRecent, openRepoPicker, readRecents, rememberRecent } from './repopicker';
import { initResizer } from './resizer';
import { createTopBar, type Crumb, type TopBar } from './topbar';

// The repository every request below is scoped to. Null only before boot()
// has resolved one — there is no "no repo" state the UI can reach afterwards.
//
// The whole entry is kept, not just the id, because the *path* is what
// survives a backend restart: ids are handed out by an in-memory registry,
// paths are what re-create them (POST /api/repos is idempotent). api.ts uses
// that for its own 409 recovery; here it is what a repo can be re-selected by
// on a later boot.
let repo: RepoEntry | null = null;

// The ref the commit picker is currently listing, as a **full** refname
// ('refs/heads/main'). Empty only before the first branch load; after that it
// is whatever the branch crumb shows, and every api.commits() call names it.
//
// The full refname and not the display name, because the display name does not
// identify a ref: a local branch may be called `origin/main`, which renders
// exactly as the remote-tracking `refs/remotes/origin/main` does. Only one of
// those two is the one the user picked, and only the full form says which.
let selectedRef = '';

// The commits being previewed, newest-first, and what that preview contains.
// Empty until the first selection loads.
//
// A selection rather than a single sha because a review is not always one
// commit: several commits read as one combined diff is the "ghost squash", and
// a selection of exactly one is the ordinary single-commit case. Keeping one
// field for both is what stops the two from drifting into two code paths.
//
// Each file carries its OWN base/head pair (see PreviewFile) — there is
// deliberately no module-level headSha/baseSha, because with commits skipped
// out of the middle of a range there is no single pair that describes every
// file honestly, and the band diffs each card at its file's own pair. `spanRevs`
// below is the only thing entitled to speak for the selection as a whole, and
// its one consumer is the debug hook (see getHeadSha).
//
// CommitInfo, not bare SHAs, and that is load-bearing: a selection has to
// outlive the log it came from. A ref's log is capped at 100 commits and a
// force-push can drop one sooner, so the commit a reviewer is sitting on may
// stop being in anything we fetch — at which point its own metadata is the only
// place its subject still exists. Carrying it here is what lets the header and
// the palette keep naming it correctly instead of going blank.
let selection: CommitInfo[] = [];
let files: PreviewFile[] = [];
let spanRevs = { headSha: '', baseSha: '' };
let activePath = '';

// What the two palettes list. Held here rather than fetched when a palette
// opens, so opening one is instant and so a live refs event keeps both current
// whether either is open or not.
let commits: CommitInfo[] = [];
let branches: BranchInfo[] = [];

// Guards the fields above against out-of-order async completions.
// Nothing serialises the async entry points below: picking a commit just fires
// selectCommits(), so switching twice on a slow repo leaves two api.preview()
// calls in flight — and a slow
// *earlier* response can land *after* a fast later one and overwrite it,
// leaving the file list and diff disagreeing with the picker. So each entry
// point claims an epoch on the way in and abandons itself after any await
// once a newer caller has claimed one. An abandoned call must also stay
// silent (no setStatus, no rethrow): the caller holding the current epoch
// owns the status line and the state.
//
// Entry points nest — selectBranch hands off to loadCommits, which hands off
// to selectCommits, and each handoff claims a fresh epoch. That's deliberate,
// and the reason no entry point checks staleness after awaiting another one.
//
// revealPath is deliberately NOT one of them: it starts no fetch of its own and
// owns no state here. What guards the mounts it triggers is band.ts's own epoch
// plus a token per card — the same argument as this one, at the granularity a
// column of independent editors actually needs.
let epoch = 0;

function beginEpoch(): number {
  return ++epoch;
}

function stale(e: number): boolean {
  return e !== epoch;
}

let statusEl: HTMLElement | null = null;
let fileListEl: HTMLUListElement | null = null;
let topBar: TopBar | null = null;
let band: Band | null = null;
const rowsByPath = new Map<string, HTMLLIElement>();

export function getRepoId(): string {
  return repo?.id ?? '';
}

/**
 * The current repo's id, for the code paths that cannot run before boot() has
 * picked one. Throws rather than falling back to the backend's default repo:
 * a request that quietly went to a different repository than the sidebar shows
 * is a wrong answer, and a wrong answer is worse than a visible error.
 */
function requireRepoId(): string {
  if (!repo) throw new Error('shell: no repository selected yet');
  return repo.id;
}

/**
 * The selection's outer revision pair, for main.ts's `window.__ccd` debug hook.
 *
 * The *span's* pair, not any one file's: with a multi-commit selection those
 * differ, and a debug hook that named one file's revisions would be answering a
 * question nobody asked. What a given file is actually rendered at is its own
 * `PreviewFile.baseSha`/`headSha`, which the band reads straight off `files`.
 */
export function getHeadSha(): string {
  return spanRevs.headSha;
}

export function getBaseSha(): string {
  return spanRevs.baseSha;
}

/** The commits currently being previewed, newest-first. */
export function getSelectedShas(): string[] {
  return selection.map((c) => c.sha);
}

/**
 * Whether `path` is one of the files this selection changed — the line between
 * "part of the review" and "merely part of the repository".
 *
 * The band draws it (a path outside the set has no card, see revealPath) and
 * Ctrl+click's candidate list draws it too, which is why it is a named predicate
 * rather than a `files.some` at each site: those two are answering the same
 * question, and they must never answer it differently.
 */
export function isInReview(path: string): boolean {
  return files.some((f) => f.path === path);
}

/**
 * The modified pane of the file the reader is on, for main.ts's debug hook.
 *
 * There is no single editor to hand back any more — the band holds one per
 * mounted file — so "the" editor is defined as the active card's, which is the
 * one a coordinate-math check means when it says "the editor".
 */
export function getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return band?.activeEditor() ?? null;
}

/**
 * Builds the header, the changed-file sidebar and the diff pane inside
 * `rootEl`, then kicks off loading the commit log. Call once at boot.
 */
export function initShell(rootEl: HTMLElement): void {
  rootEl.innerHTML = '';
  rootEl.classList.add('ccd-app');

  // Spans the full width above everything else, because what it names scopes
  // everything else: the files below belong to this repository, this ref and
  // these commits, and a reader who misses that reads the wrong history.
  topBar = createTopBar();
  renderTrail();

  const sidebar = document.createElement('div');
  sidebar.className = 'ccd-sidebar';

  const status = document.createElement('div');
  status.className = 'ccd-status';
  // role=status is a polite live region, so a message written here is announced
  // without interrupting. Polite and not assertive deliberately: this slot
  // carries "Loading commits…" as often as it carries a failure, and an
  // assertive region would cut across the reader on every routine fetch.
  status.role = 'status';
  statusEl = status;

  const list = document.createElement('ul');
  list.className = 'ccd-file-list';
  fileListEl = list;

  // The sidebar is now only the changed-file tree and the line above it that
  // says what is happening to it. Everything that narrows the subject moved to
  // the header, which is what gives the tree the whole column height.
  sidebar.append(status, list);

  // Occupies the middle grid track between the two panes (see index.html's
  // .ccd-content). The tooltip is the only place the double-click reset is
  // discoverable — a 6px seam has nowhere to put a label.
  const resizer = document.createElement('div');
  resizer.className = 'ccd-resizer';
  resizer.title = 'Drag to resize · double-click to reset';

  // The scroller every changed file is stacked in. It is the app's only vertical
  // scroll region now — each card's editor is exactly as tall as its content, so
  // no editor scrolls on its own.
  const bandEl = document.createElement('div');
  bandEl.className = 'ccd-band';

  // The three columns live in their own box below the header rather than being
  // rows of #app's grid. initResizer is handed *this* element and not rootEl
  // because both things it does are relative to the grid it drives: it writes
  // --ccd-sidebar-w on it, and it converts a pointer's clientX into a track
  // width by subtracting the grid's own left edge. Point it at #app and the
  // drag is offset by however far the columns start in from the viewport.
  const content = document.createElement('div');
  content.className = 'ccd-content';
  content.append(sidebar, resizer, bandEl);

  rootEl.append(topBar.el, content);

  initResizer(content, resizer);

  band = initBand(bandEl, {
    // The band reports which file is being read; the sidebar follows. This is
    // the reverse of the old direction, where a click decided the active file
    // and the diff pane obeyed — with everything on one scroll, where the reader
    // is is a fact to be observed rather than a choice to be recorded.
    onActivePath: (path) => {
      activePath = path;
      highlightActiveRow();
      rowsByPath.get(path)?.scrollIntoView({ block: 'nearest' });
    },
    describeSkipped,
    // The same palette the selection crumb opens, reached from the empty
    // state's own button so a reader who has landed on nothing does not have to
    // find their way back up to the breadcrumb to get out of it.
    onChooseCommits: () =>
      openCommitPalette({
        commits,
        selected: selection,
        onApply: (next) => void selectCommits(next)
      }),
    onError: (path, err) => setStatus(`Error loading ${path}: ${errorMessage(err)}`, 'error')
  });

  void boot();
}

/**
 * Resolves which repository this session works against, then loads its commits.
 *
 * The backend serves many repos and names none of them implicitly, so the id
 * has to come from somewhere before the first request: `GET /api/repos` reports
 * the boot REPO_ROOT as `defaultRepoId`, which is what keeps single-repo
 * behaviour identical to before any of this existed — start the backend with
 * REPO_ROOT, get that repo.
 *
 * A deep link overrides all of that, and does NOT fall back to it. A link that
 * names a repository this backend refuses must not quietly open a different one
 * — the reader would be reviewing something other than what they followed a
 * link to, with nothing on screen saying so. The backend's own refusal text is
 * reported instead, and the repo crumb still offers the picker.
 */
async function boot(): Promise<void> {
  const e = beginEpoch();
  setStatus('Loading repository…');

  // Read before anything can overwrite it. updateAddressBar() hangs off
  // renderTrail(), which initShell() has already called once by now — it no-ops
  // while no repo is adopted, and this line is why that guard matters.
  const link = parseDeepLink(window.location.search);

  let entry: RepoEntry | null;
  try {
    // A link and "the repository I had open last" are mutually exclusive
    // intents; merging them is how a link silently opens the wrong repo.
    entry = link ? await api.registerRepo(link.repoPath) : await preferredRepo(await api.repos());
  } catch (err) {
    if (stale(e)) return;
    setStatus(
      link
        ? `Cannot open ${link.repoPath} from the link: ${errorMessage(err)}`
        : `Error loading repositories: ${errorMessage(err)}`,
    );
    return;
  }
  if (stale(e)) return;
  if (!entry) {
    setStatus('No repository configured. Start the backend with REPO_ROOT set.');
    return;
  }

  adoptRepo(entry);
  await loadRepoRefs(link);
}

/**
 * The repo to open on a fresh page: whatever was open last, else the backend's
 * default.
 *
 * The stored *path* is re-registered rather than the stored id reused. Ids are
 * stable for a path, but the registry that hands them out is memory-only, so a
 * remembered id may name nothing at all in this backend process — while the
 * path always re-derives it. A repo that has since moved or been deleted is
 * dropped from recents and the boot falls through to the default, because
 * "your last repository is gone" must not be a dead end the user has to clear
 * their storage to escape.
 */
async function preferredRepo(listing: ReposListing): Promise<RepoEntry | null> {
  const recent = readRecents()[0];
  if (recent) {
    try {
      return await api.registerRepo(recent.path);
    } catch (err) {
      console.warn(`[ccd] last repo ${recent.path} no longer registers: ${errorMessage(err)}`);
      forgetRecent(recent.path);
    }
  }
  return listing.repos.find((r) => r.id === listing.defaultRepoId) ?? null;
}

/** Makes `entry` the current repo, in state, in recents, on screen and on the wire. */
function adoptRepo(entry: RepoEntry): void {
  repo = entry;
  rememberRecent(entry);
  renderTrail();
  connectLive();
}

// The watch stream for the current repo, or null before boot has resolved one.
let live: LiveStream | null = null;

/**
 * Points the watch stream at the current repo, closing whatever it was on.
 *
 * Closing first is not tidiness. An EventSource that is merely dropped keeps its
 * connection open and keeps delivering, so a repo switch would leave the old
 * repo's stream alive — and every commit in a repository the user has left would
 * refresh the sidebar of the one they are looking at, against a ref list that
 * has nothing to do with it.
 */
function connectLive(): void {
  live?.close();
  live = null;

  const repoId = repo?.id;
  if (!repoId) return;

  live = watchRepo(repoId, () => {
    // close() stops delivery, but an event already queued when it ran can still
    // arrive here. Cheap to check, and the alternative is a cross-repo refresh.
    if (repo?.id !== repoId) return;
    void refreshRefs();
  });
}

/**
 * Points the whole shell at another repository and reloads its commit log.
 *
 * Claims an epoch before touching anything: a commit or file load still in
 * flight belongs to the *old* repo, and letting it land would paint that repo's
 * files over this one's. (loadCommits claims another one on the way in — entry
 * points nest here, as they already do for selectBranch -> loadCommits.)
 *
 * Monaco's models for the old repo are deliberately left alive. They are keyed
 * by a URI whose authority is the repo id, so nothing this repo creates can
 * collide with them, and disposing them would only cost a re-fetch if the user
 * switches back.
 */
async function switchRepo(entry: RepoEntry): Promise<void> {
  if (repo?.id === entry.id) return;

  beginEpoch();

  // Cleared BEFORE adoptRepo, which is not tidiness. adoptRepo repaints the
  // breadcrumb synchronously, and renderTrail() reads the bindings below to
  // decide which crumbs exist. Clearing after it leaves the header naming the
  // new repository beside the *previous* one's branch and commit selection
  // until loadBranches lands, a full round trip later — and both of those
  // crumbs are clickable throughout, opening the empty palettes this block has
  // already produced. shell's own rule for the selection crumb says why that is
  // not survivable: a crumb that opens an empty palette is an affordance that
  // lies.
  //
  // Collapse state is keyed by directory path, and those paths describe a tree
  // that does not exist in the new repo.
  resetFileTreeState();

  selection = [];
  commits = [];
  branches = [];
  spanRevs = { headSha: '', baseSha: '' };
  files = [];
  activePath = '';
  rowsByPath.clear();
  if (fileListEl) fileListEl.innerHTML = '';
  // Emptied for the same reason as the tree beside it: these cards describe the
  // outgoing repository's files, and every one of them holds a live editor.
  band?.clear();

  // Not carried over: a refname is only meaningful inside the repo that has it,
  // and `refs/heads/main` naming a branch in both repos is a coincidence, not a
  // reason to open the new repo on it. loadRepoRefs() picks the new repo's HEAD.
  selectedRef = '';

  adoptRepo(entry);

  await loadRepoRefs();
}

/**
 * Repaints the header breadcrumb from current state. Cheap and idempotent, so
 * every place that changes what is being reviewed can just call it rather than
 * reason about which crumb it invalidated.
 *
 * Each crumb shows the short form and carries the long one as its tooltip: a
 * header has room for a repo *name* but not a checkout path, and two repos can
 * share a basename — so the path has to stay reachable somewhere.
 */
function renderTrail(): void {
  const crumbs: Crumb[] = [
    {
      key: 'repo',
      icon: '▤',
      label: repo?.name ?? 'Choose repository…',
      title: repo ? `${repo.path} — click to switch repository` : 'Click to choose a repository',
      onClick: () => openRepoPicker({ onPick: (entry) => void switchRepo(entry) })
    }
  ];

  const branch = branches.find((b) => b.ref === selectedRef);
  if (branch) {
    crumbs.push({
      key: 'branch',
      icon: '⑂',
      label: branch.name,
      // The full refname, because the display name does not identify a ref: a
      // local branch may be called `origin/main`, which renders exactly as the
      // remote-tracking `refs/remotes/origin/main` does.
      title: linkRefMissing
        ? `${branch.ref} — the link named ${linkRefMissing}, which this repository does not have`
        : `${branch.ref} — click to switch branch`,
      onClick: () =>
        openBranchPalette({
          branches,
          selectedRef,
          onPick: (ref) => void selectBranch(ref)
        })
    });
  }

  // Only once there is a log to open it on: a crumb that opens an empty palette
  // is an affordance that lies.
  if (commits.length > 0 || selection.length > 0) {
    crumbs.push({
      key: 'selection',
      // The ghost is the standing reminder that what is on screen is not a
      // commit. A reviewer who forgets that could quote a sha for a diff no sha
      // produces.
      icon: selection.length > 1 ? '👻' : '◇',
      label: selectionLabel(),
      title: selectionTitle(),
      onClick: () =>
        openCommitPalette({
          commits,
          selected: selection,
          onApply: (next) => void selectCommits(next)
        })
    });
  }

  topBar?.setCrumbs(crumbs);

  // The same funnel, for the same reason: every entry point that can change what
  // is under review already ends here, so this is where the URL naming it stays
  // true without a second set of hooks to keep in sync. It writes nothing until
  // a repository is adopted — see updateAddressBar, where that guard is what
  // stops initShell's first paint from erasing an incoming link.
  updateAddressBar({ repoPath: repo?.path ?? '', ref: selectedRef, shas: selection.map((c) => c.sha) });
}

/** `4221baf · Add User.email…`, or how many commits when it is more than one. */
function selectionLabel(): string {
  const first = selection[0];
  if (!first) return 'Select commit…';
  if (selection.length > 1) return `${selection.length} commits`;
  return `${first.sha.slice(0, 7)} · ${first.subject}`;
}

/** Every selected commit, one per line — the crumb only has room for a count. */
function selectionTitle(): string {
  if (selection.length === 0) return 'Click to choose a commit';
  const lines = selection.map((c) => `${c.sha.slice(0, 7)} · ${c.subject}`).join('\n');
  if (selection.length === 1) return lines;
  // Says it out loud rather than leaving the ghost glyph to carry it: this is
  // the tooltip of the control that names what the diff pane is showing, and
  // what it is showing is not any commit in this list.
  const impure = files.filter((f) => f.skippedShas.length > 0).length;
  const caveat = impure === 0 ? '' : `\n${impure} file(s) marked ⚠ — see the file list.`;
  return `Ghost squash of ${selection.length} commits (nothing is rewritten):\n${lines}${caveat}`;
}

/**
 * Scrolls the band to `path`, and to `line` within it when one is given.
 *
 * Named for what now happens: every changed file is already in the band, so
 * there is nothing to open. A sidebar click and a cross-file peek jump both land
 * here, which is what keeps them identical.
 *
 * A path the selection did not change has no diff, so it is opened as a
 * read-only reference card instead — which is what `rev` is for. Callers that
 * can only name reviewed paths (the sidebar) omit it.
 */
export async function revealPath(path: string, line?: number, rev?: string): Promise<void> {
  if (selection.length === 0) {
    throw new Error('shell.revealPath: no commit selected yet');
  }

  // A definition in a file the selection never changed has no diff to scroll to,
  // so the band opens it as a read-only *reference* card instead. `rev` is what
  // makes that possible and why it is threaded through from the peek: an
  // untouched file has no base/head pair, only the revision the definition was
  // resolved against.
  //
  // This used to be a refusal with a status message, on the grounds that the
  // peek had already rendered the definition inline. It is worth knowing what
  // the refusal was protecting against, because the fix must not reintroduce it:
  // the ORIGINAL single-editor view did navigate, by falling back to the
  // selection's span — whose two ends hold identical content for an untouched
  // file — so the reader arrived at a diff of a file against itself, every line
  // folded behind an unchanged-region bar. A reference card is not that: it is a
  // plain editor over one revision (see createFileView), which is why it can
  // show the file at all.
  //
  // Without a rev there is still nothing to open, so the message survives for
  // that case — a sidebar click, which names a reviewed path and never this one.
  if (!isInReview(path)) {
    if (!rev) {
      setStatus(`${path} is not changed by this selection — showing its definition inline only.`);
      return;
    }
    setStatus(`${path} is not changed by this selection — opened for reference.`);
    await band?.openContext(path, rev, line);
    return;
  }

  // No epoch claim, and no rollback either. Both existed to stop two model swaps
  // racing to one editor; a scroll has no such hazard — the band's own epoch and
  // per-card tokens guard the mounts, and `activePath` is now reported *by* the
  // band from where the reader actually is rather than guessed before a load.
  await band?.revealPath(path, line);
}

/**
 * Everything a newly-current repository needs listed: its branches, then the
 * commits of whichever one HEAD is on.
 *
 * One function and not two calls at each site, because the order is an
 * invariant rather than a convenience — `loadCommits()` names `selectedRef`,
 * and only `loadBranches()` can establish it. Skipping the commit load when the
 * branch load failed is the same invariant seen from the other side: there is no
 * ref to ask for.
 *
 * `link`, when a deep link named one, overrides the two defaults that sequence
 * would otherwise pick: HEAD's branch and its newest commit. It rides through as
 * a parameter rather than as a second load path — every request below is the one
 * the app already makes, so a link's bad ref or bad SHA lands in the error
 * handling that already exists for a hand-made selection.
 */
async function loadRepoRefs(link?: DeepLinkRequest | null): Promise<void> {
  if (!(await loadBranches())) return;
  applyLinkedRef(link);
  await loadCommits(link?.shas ?? undefined);
}

/**
 * The ref a deep link named, if this repository has it.
 *
 * Runs between `loadBranches()` (which has just set `selectedRef` to HEAD's
 * branch) and `loadCommits()` (which reads it), so it is an override of an
 * already-valid value and never the thing that establishes one. Synchronous, so
 * it needs no epoch of its own, for the reason `selectBranch` does not either:
 * nothing awaits between it and the load that follows.
 *
 * A ref the repository does not have leaves the reader on HEAD and is reported
 * on the branch crumb rather than in the status line — `loadCommits()` writes
 * "Loading commits…" on its very next line, so a status written here would be
 * gone within the tick. The crumb is also where someone checks "am I on the
 * branch that link named".
 */
function applyLinkedRef(link?: DeepLinkRequest | null): void {
  if (!link?.ref) return;
  const target = branches.find((b) => b.ref === link.ref);
  if (!target) {
    linkRefMissing = link.ref;
    return;
  }
  selectedRef = target.ref;
}

// The ref a deep link named that this repository does not have, or '' when the
// link's ref was honoured (or there was none). Read by renderTrail() for the
// branch crumb's tooltip; cleared by selectBranch, because a branch picked by
// hand supersedes a stale link.
let linkRefMissing = '';

/**
 * Fills the branch picker from the current repo and selects HEAD's branch.
 * Returns whether `selectedRef` now names something — false covers both a
 * failed load and a repo with no branches at all, and in either case the caller
 * must not go on to list commits.
 */
async function loadBranches(): Promise<boolean> {
  const e = beginEpoch();
  setStatus('Loading branches…');
  let loaded: BranchInfo[];
  try {
    loaded = await api.branches(requireRepoId());
  } catch (err) {
    if (stale(e)) return false;
    setStatus(`Error loading branches: ${errorMessage(err)}`, 'error');
    return false;
  }
  if (stale(e)) return false;

  // The backend guarantees an `isHead` entry for any repo that has a commit —
  // a detached HEAD gets a synthetic one — so an empty list means an empty
  // repository, with no ref to name and no commits to list under it.
  branches = loaded;
  const head = branches.find((b) => b.isHead);
  if (!head) {
    renderTrail();
    setStatus('No branches found in repo.');
    return false;
  }

  selectedRef = head.ref;
  renderTrail();
  return true;
}

/**
 * Points the commit picker at another ref and opens its newest commit.
 *
 * No epoch is claimed here: `loadCommits()` claims one before its first await,
 * and nothing happens in between that a stale caller could corrupt. Flipping
 * branches quickly therefore leaves one in-flight commit load per flip, of
 * which only the last is not stale — and `selectedRef`, set synchronously by
 * each pick, already agrees with the crumb the user is looking at.
 */
async function selectBranch(ref: string): Promise<void> {
  if (ref === selectedRef) return;
  selectedRef = ref;
  linkRefMissing = '';
  renderTrail();
  await loadCommits();
}

/**
 * Fills the commit picker from `selectedRef`'s log and opens its newest commit.
 * Reads the <select> from module state rather than taking it as an argument: it
 * is called from boot(), from every repo switch and from every branch switch,
 * and a caller that had to carry the element around would be carrying it only
 * to hand it straight back.
 *
 * `selectedRef` is required to be set (loadRepoRefs and selectBranch are the
 * only callers, and both establish it). It is passed as-is rather than falling
 * back to the route's HEAD default, because an empty ref then fails loudly as a
 * 400 — where the fallback would quietly list HEAD's commits underneath a
 * branch picker naming something else, which in a review tool is a wrong answer
 * dressed as a right one.
 *
 * `initialShas` opens that selection instead of the newest commit. They are
 * handed on as bare SHAs wearing empty metadata, which never reaches the screen:
 * `selectCommits` takes the selection it renders from `/api/preview`'s own
 * records, so a linked commit older than this page of the log still arrives with
 * its subject — and one that does not exist is one clean 404 rather than a row
 * of blanks.
 */
async function loadCommits(initialShas?: string[]): Promise<void> {
  const e = beginEpoch();
  setStatus('Loading commits…');
  let loaded: CommitInfo[];
  try {
    loaded = await api.commits(requireRepoId(), selectedRef);
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading commits: ${errorMessage(err)}`, 'error');
    return;
  }
  if (stale(e)) return;

  commits = loaded;
  const newest = commits[0];
  if (!newest) {
    renderTrail();
    setStatus('No commits found on this branch.');
    return;
  }

  await selectCommits(initialShas?.length ? initialShas.map(placeholderCommit) : [newest]);
}

/**
 * Re-reads branches and commits after the watcher said the repository's refs
 * moved, keeping the user where they are wherever that is still possible.
 *
 * Claims a fresh epoch like any other entry point: this can land in the middle
 * of a commit or file load, and the two must not both write the sidebar. What it
 * must *not* do is leave the user's own in-flight action half-applied, so the
 * decision to reload the file list below is made against `selection` — what is
 * actually rendered — rather than against the previous selection. If a
 * selectCommits() was abandoned by this very epoch, `selection` still holds the
 * old commits and this refresh finishes the job the user started.
 *
 * Nothing here has to preserve a selection that falls out of the new log. The
 * selection is CommitInfo and is held in this module, so a commit dropped by a
 * force-push keeps its subject and keeps being named correctly — where the old
 * <select> had to carry the label over from the option it was replacing.
 *
 * Failures are logged, not put on the status line. The user did not ask for this
 * refresh; taking over the status line to report that a background poll failed
 * would replace whatever they *are* waiting on with an error about something
 * they never did. The next refs event retries anyway.
 */
async function refreshRefs(): Promise<void> {
  // Captured before the first await, because every decision below is about
  // where the user *was* when the event arrived.
  const previous = {
    ref: selectedRef,
    selection,
    // The log is newest-first, so its first entry is the tip of the ref as it
    // was last listed.
    tipSha: commits[0]?.sha ?? '',
  };

  const e = beginEpoch();

  let loadedBranches: BranchInfo[];
  try {
    loadedBranches = await api.branches(requireRepoId());
  } catch (err) {
    if (!stale(e)) console.warn(`[ccd] live refresh: branches failed: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;

  // A branch can vanish under the user — deleted, renamed, or pruned by a fetch
  // — and there is then nothing to keep them on. HEAD's branch is the fallback
  // because it is the same answer a fresh load would give.
  const target =
    loadedBranches.find((b) => b.ref === previous.ref) ?? loadedBranches.find((b) => b.isHead);
  if (!target) return;
  branches = loadedBranches;
  selectedRef = target.ref;

  let loaded: CommitInfo[];
  try {
    loaded = await api.commits(requireRepoId(), selectedRef);
  } catch (err) {
    if (!stale(e)) console.warn(`[ccd] live refresh: commits failed: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;
  const newest = loaded[0];
  if (!newest) return;

  commits = loaded;

  // FOLLOW HEAD ONLY FROM THE TIP, AND ONLY FROM A SELECTION OF ONE. Someone
  // sitting on the tip is watching the branch and wants the new commit; someone
  // sitting on an older commit is reviewing it, and moving them would replace
  // the diff they are reading — possibly mid-file, possibly mid-thought — with
  // one they never asked for, and give them no way to know what they were just
  // looking at. Being late to a new commit costs a click; being yanked off an
  // old one costs the review.
  //
  // A multi-commit selection never follows, whatever it contains. Choosing
  // several commits is a deliberate act that a background event has no business
  // editing, and "the tip moved" says nothing about whether the new commit
  // belongs in a set the reviewer assembled by hand.
  //
  // The user is still moved when the ref itself changed underneath them, since
  // their old selection belongs to a branch that is no longer shown.
  const wasOnTip =
    previous.selection.length === 1 && previous.selection[0]?.sha === previous.tipSha;
  const followTip = target.ref !== previous.ref || previous.selection.length === 0 || wasOnTip;
  const next = followTip ? [newest] : previous.selection;

  renderTrail();

  // Against what is rendered, not against the previous selection: this is "is
  // the file list showing the selected commits", which is the question that
  // decides whether it has to be rebuilt at all — and it is also true when
  // nothing moved but the user's own load was abandoned by this epoch.
  if (!sameSelection(selection, next)) await selectCommits(next);
}

function sameSelection(a: CommitInfo[], b: CommitInfo[]): boolean {
  return a.length === b.length && a.every((commit, i) => commit.sha === b[i]?.sha);
}

/**
 * A SHA with no metadata yet, for asking `selectCommits` about a commit this
 * session has never listed — which is every commit a deep link names.
 *
 * The blank fields are never rendered: `selectCommits` replaces the whole
 * selection with `/api/preview`'s records before it paints. Inventing plausible
 * text here instead would be the thing that *could* reach the screen, and it
 * would be a lie about which commit the reader is looking at.
 */
function placeholderCommit(sha: string): CommitInfo {
  return { sha, subject: '', author: '', date: '' };
}

/**
 * Resolves a selection of commits into its changed files, then renders both the
 * sidebar tree and the band of diffs.
 *
 * `next` may name one commit (the ordinary review) or several (a ghost squash);
 * nothing below this point distinguishes them, because a preview of one commit
 * is exactly what the per-commit view always was. Caller order does not matter —
 * the backend sorts newest-first and the selection is reordered to match, so
 * what the header lists and what the diff shows cannot disagree.
 */
async function selectCommits(next: CommitInfo[]): Promise<void> {
  const e = beginEpoch();
  setStatus(next.length > 1 ? `Combining ${next.length} commits…` : 'Loading commit…');
  let result: Preview;
  try {
    result = await api.preview(requireRepoId(), next.map((c) => c.sha));
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading commit: ${errorMessage(err)}`, 'error');
    return;
  }
  if (stale(e)) return;

  // The backend's own records, not the caller's: already newest-first, and read
  // straight off the git objects, so a commit outside the ref's listed page
  // still arrives with its subject. Trusting `next` instead worked only for
  // commits the caller had metadata for — true for a palette pick, false for a
  // selection named from outside the app.
  selection = result.commits;
  spanRevs = { headSha: result.spanHeadSha, baseSha: result.spanBaseSha };
  files = result.files;
  activePath = '';
  renderTrail();

  // There is deliberately nothing to prewarm here. This used to explain why an
  // eager POST /api/index was disabled — indexing a whole revision on every
  // commit select cost ~11.5s on Lets-Plot and, on a blobless partial clone,
  // thousands of on-demand blob fetches. That route is gone: the resolver now
  // greps for the identifier and parses only the files that mention it, so the
  // cost it was hiding from is no longer there to hide from.

  renderFileList(files);

  // Every changed file, deleted ones included. The old single-file view had to
  // skip past a deletion to avoid opening on an empty pane with nothing to
  // Ctrl+click; a band has no such problem, and a review that silently omitted a
  // deleted file would be hiding a change.
  band?.render(requireRepoId(), files);

  // Nothing, either way. "No reviewable source files changed" used to be
  // written here, into a muted line in the corner of the sidebar, while the
  // column the reader was actually looking at stayed empty — so the message was
  // both easy to miss and unable to offer a way out. band.ts renders that state
  // now, with the same reasoning about not enumerating extensions and a button
  // back to the commit palette. Saying it in two places would only be two
  // places to keep in step.
  setStatus('');
}

// ---------------------------------------------------------------------------
// Changed-file tree
//
// The shape is filetree.ts's job; everything below is the rendering of it.
// ---------------------------------------------------------------------------

type DirNode = Extract<TreeNode, { kind: 'dir' }>;
type FileNode = Extract<TreeNode, { kind: 'file' }>;

// Directories the reviewer has explicitly collapsed, by TreeNode.path.
// Absence means expanded, so a directory nobody has touched — which is every
// directory of every commit at boot — renders open.
//
// Expanded-by-default is a correctness decision, not a taste one: this is a
// review tool, and a collapsed directory hides a changed file. A file the
// reviewer never saw is a file the reviewer never reviewed, so the default
// must never be "some of this commit is off-screen".
//
// The same reasoning is why this is deliberately NOT persisted to
// localStorage, unlike the sidebar width in resizer.ts. A width is
// a once-per-install preference and is wrong at worst; a collapse remembered
// from last week would silently hide today's changed file from today's review.
// Session-scoped is the most this may safely be.
const collapsedDirs = new Set<string>();

/**
 * Forgets every collapse. Called on a repo switch (see switchRepo), where the
 * retained paths describe a tree that no longer exists.
 */
export function resetFileTreeState(): void {
  collapsedDirs.clear();
}

function renderFileList(changedFiles: PreviewFile[]): void {
  if (!fileListEl) return;
  fileListEl.innerHTML = '';
  rowsByPath.clear();

  appendNodes(fileListEl, buildFileTree(changedFiles), 0);

  highlightActiveRow();
}

/** Appends `nodes` to `listEl` as rows nested `depth` levels deep. */
function appendNodes(listEl: HTMLUListElement, nodes: TreeNode[], depth: number): void {
  for (const node of nodes) {
    listEl.append(node.kind === 'dir' ? dirItem(node, depth) : fileRow(node, depth));
  }
}

/**
 * One directory: a clickable header row plus the (possibly hidden) <ul> of its
 * children. Toggling flips exactly two things — the `collapsedDirs` entry and
 * `aria-expanded` — and the twisty's rotation and the subtree's visibility both
 * follow from CSS, so there is no second copy of "is this open" to drift.
 */
function dirItem(node: DirNode, depth: number): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'ccd-tree-dir';

  const subtree = document.createElement('ul');
  subtree.className = 'ccd-subtree';
  appendNodes(subtree, node.children, depth + 1);

  const row = document.createElement('div');
  row.className = 'ccd-dir-row';
  row.style.setProperty('--ccd-depth', String(depth));
  row.title = node.path;
  // The sidebar is the primary way around a commit, so the rows it is made of
  // have to be reachable without a mouse. role=button rather than a full ARIA
  // tree: this buys Enter/Space and a screen-reader-announced state for two
  // attributes, where a tree would also owe roving tabindex and arrow-key
  // navigation.
  row.role = 'button';
  row.tabIndex = 0;

  const twisty = document.createElement('span');
  twisty.className = 'ccd-twisty';
  twisty.ariaHidden = 'true';
  // Rotated a quarter turn by CSS when the row is expanded, so this glyph is
  // the only one either state needs.
  twisty.textContent = '▸';

  const name = document.createElement('span');
  name.className = 'ccd-dir-name';
  // node.name is already a collapsed chain ('src/main/kotlin/org/example'),
  // so it is a whole path prefix on one row, not one segment.
  name.textContent = node.name;

  const syncExpanded = (): void => {
    const expanded = !collapsedDirs.has(node.path);
    row.ariaExpanded = String(expanded);
    subtree.hidden = !expanded;
  };
  const toggle = (): void => {
    if (!collapsedDirs.delete(node.path)) collapsedDirs.add(node.path);
    syncExpanded();
  };

  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Space would scroll the file list out from under the row that was just
    // toggled, which is the one thing the user was looking at.
    e.preventDefault();
    toggle();
  });

  syncExpanded();
  row.append(twisty, name);
  item.append(row, subtree);
  return item;
}

/**
 * What A/M/D are called out loud. Only the accessible name uses these — the
 * badge stays a single letter, because the whole reason it is a letter is that
 * a tree of two hundred rows cannot spend a word each on saying so.
 */
const STATUS_WORDS: Record<FileStatus, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
};

/**
 * One file: the same row the flat list rendered, with two differences — the
 * label is the basename and the indent comes from `depth`.
 *
 * Registers into `rowsByPath` under the *full* path, exactly as before. That
 * is what lets highlightActiveRow() and defprovider.ts's cross-file F12 jump —
 * both of which only ever know a full path — survive the tree untouched.
 */
function fileRow(node: FileNode, depth: number): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'ccd-file-row';
  row.style.setProperty('--ccd-depth', String(depth));
  // Still the full path, not the shortened label: the tooltip is where the
  // path the row no longer spells out comes back.
  row.title = node.path;
  // Same reasoning dirItem already states — the sidebar is the primary way
  // around a review, so its rows have to be reachable without a mouse. Only the
  // directory rows ever got it, which left the tab order able to open a folder
  // and unable to reach a single thing inside it. These rows are the
  // destinations; they are the half that had to be keyboard-reachable.
  row.role = 'button';
  row.tabIndex = 0;

  const badge = document.createElement('span');
  badge.className = `ccd-badge ccd-badge-${node.status}`;
  badge.textContent = node.status;
  // A one-letter badge is a fine glyph and a terrible thing to hear: read out,
  // the row was "A deeplink.ts". Hidden here and spelled into the row's own
  // label below, so the status is announced as a word exactly once.
  badge.ariaHidden = 'true';

  const pathEl = document.createElement('span');
  pathEl.className = 'ccd-file-path';
  pathEl.textContent = node.name;

  row.append(badge, pathEl);

  // The one place the preview admits it is not exactly what was asked for. A
  // file edited by both a selected and an unselected commit has no two-SHA
  // representation that excludes the unselected edits, so they are in this
  // file's diff — and saying so is the difference between a reviewer trusting
  // the tool and a reviewer being quietly misled about what they just read.
  if (node.skippedShas.length > 0) {
    const warn = document.createElement('span');
    warn.className = 'ccd-file-warn';
    warn.textContent = '⚠';
    warn.title = describeSkipped(node.skippedShas);
    row.append(warn);
    // On the row too, so hovering anywhere along it explains the mark rather
    // than requiring the reader to find the glyph.
    row.title = `${node.path}\n\n${warn.title}`;
  }

  row.ariaLabel = `${node.path}, ${STATUS_WORDS[node.status]}`;

  const open = (): void => {
    revealPath(node.path).catch((err: unknown) => {
      setStatus(`Error loading diff: ${errorMessage(err)}`, 'error');
    });
  };

  row.addEventListener('click', open);
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Space scrolls the file list, which would move the row out from under the
    // reader the moment they act on it — the same reason dirItem preventDefaults.
    e.preventDefault();
    open();
  });

  rowsByPath.set(node.path, row);
  return row;
}

/**
 * The ⚠ tooltip: which unselected commits also touched this file.
 *
 * Named, not counted. "Also contains 1 unselected commit" tells the reviewer
 * something is wrong without telling them what to do about it; naming the commit
 * lets them decide whether to tick it and see the file honestly, or to read on
 * knowing exactly whose change they are looking at.
 *
 * Subjects are looked up in the current log, which will usually have them. A sha
 * that is not in it — a commit older than the 100 the log carries — still gets
 * named by its sha, because a partial answer here beats no mark at all.
 */
function describeSkipped(shas: string[]): string {
  const named = shas.map((sha) => {
    const known = commits.find((c) => c.sha === sha);
    return known ? `${sha.slice(0, 7)} · ${known.subject}` : sha.slice(0, 7);
  });
  const lead =
    named.length === 1
      ? 'This diff also contains a change from a commit you did not select:'
      : `This diff also contains changes from ${named.length} commits you did not select:`;
  return `${lead}\n${named.map((n) => `  • ${n}`).join('\n')}\n\nNo revision holds this file with your commits and without theirs.`;
}

function highlightActiveRow(): void {
  for (const [path, row] of rowsByPath) {
    row.classList.toggle('active', path === activePath);
  }
}

/**
 * Whether a status line is reporting progress or a failure.
 *
 * One slot carries both — "Loading commits…" and "Error loading diff: …" — and
 * until this existed they were the same muted grey 12px text, so a request that
 * had failed looked exactly like one still running. A reader waiting on the
 * first has no reason to suspect the second.
 */
type StatusKind = 'info' | 'error';

function setStatus(message: string, kind: StatusKind = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  // Colour is the redundant half here, never the carrier: every message that
  // passes 'error' already begins with the word, so the two agree rather than
  // the red having to be noticed.
  statusEl.classList.toggle('ccd-status-error', kind === 'error');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
