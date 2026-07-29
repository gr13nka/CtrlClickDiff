// shell.ts — Milestone 4 "usable shell": commit picker + changed-file
// switcher. See peekdiff-mvp-iterative-wind.md, "Milestone 4 — Usable
// shell". Vanilla DOM, no framework.
//
// openFile() is the single "switch the diff view to this path" entry point.
// Both sidebar row clicks (below) and defprovider.ts's registerEditorOpener
// (via window.__ccd.openPath, wired in main.ts) call it — so a cross-file
// F12 jump and a manual sidebar click behave identically and share one
// highlighting/loading path.

import type { BranchInfo, CommitInfo, Preview, PreviewFile } from '@ctrlclickdiff/shared';
import { api, type ReposListing, type RepoEntry } from './api';
import {
  initDiff,
  createDiff,
  isCollapseUnchanged,
  isSideBySide,
  setCollapseUnchanged,
  setRenderSideBySide
} from './diff';
import { buildFileTree, type TreeNode } from './filetree';
import { watchRepo, type LiveStream } from './live';
import { forgetRecent, openRepoPicker, readRecents, rememberRecent } from './repopicker';

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
// is whatever the branch <select> shows, and every api.commits() call names it.
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
// file honestly. `spanRevs` below is the fallback for paths outside the set,
// and is the only thing entitled to speak for the selection as a whole.
let selectedShas: string[] = [];
let files: PreviewFile[] = [];
let spanRevs = { headSha: '', baseSha: '' };
let activePath = '';

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
// Entry points nest — selectCommit hands off to openFile as its last act,
// and that handoff claims a fresh epoch. That's deliberate, and the reason
// no entry point checks staleness after awaiting another one.
let epoch = 0;

function beginEpoch(): number {
  return ++epoch;
}

function stale(e: number): boolean {
  return e !== epoch;
}

let statusEl: HTMLElement | null = null;
let fileListEl: HTMLUListElement | null = null;
let repoButtonEl: HTMLButtonElement | null = null;
let repoNameEl: HTMLElement | null = null;
let branchSelectEl: HTMLSelectElement | null = null;
let commitSelectEl: HTMLSelectElement | null = null;
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
 * question nobody asked. What a given file is actually rendered at is
 * `revsFor(path)`.
 */
export function getHeadSha(): string {
  return spanRevs.headSha;
}

export function getBaseSha(): string {
  return spanRevs.baseSha;
}

/** The commits currently being previewed, newest-first. */
export function getSelectedShas(): string[] {
  return selectedShas;
}

/**
 * Builds the sidebar (repo bar + commit picker + changed-file list) and the
 * diff pane inside `rootEl`, then kicks off loading the commit log. Call once
 * at boot.
 */
export function initShell(rootEl: HTMLElement): void {
  rootEl.innerHTML = '';
  rootEl.classList.add('ccd-app');

  const sidebar = document.createElement('div');
  sidebar.className = 'ccd-sidebar';

  // Above the commit picker because it scopes it: the commits below belong to
  // this repository, and a reader who misses that reads the wrong history.
  const repoBar = document.createElement('div');
  repoBar.className = 'ccd-repo-bar';

  const repoButton = document.createElement('button');
  repoButton.className = 'ccd-repo-button';
  repoButton.type = 'button';
  repoButton.addEventListener('click', () => {
    openRepoPicker({ onPick: (entry) => void switchRepo(entry) });
  });

  // The name lives in its own element so it can ellipsise without taking the
  // caret (a CSS ::after on the button) off the row with it.
  const repoName = document.createElement('span');
  repoName.className = 'ccd-repo-name';
  repoButton.append(repoName);

  repoButtonEl = repoButton;
  repoNameEl = repoName;
  renderRepoBar();
  repoBar.append(repoButton);

  // Above the commit picker for the same reason the repo bar is above both: it
  // scopes it. The commits below are this ref's, and a reader who misses that
  // reads a history the sidebar never claimed to be showing.
  const branchPicker = document.createElement('div');
  branchPicker.className = 'ccd-picker';

  const branchLabel = document.createElement('label');
  branchLabel.className = 'ccd-label';
  branchLabel.htmlFor = 'ccd-branch-select';
  branchLabel.textContent = 'Branch';

  const branchSelect = document.createElement('select');
  branchSelect.id = 'ccd-branch-select';
  branchSelect.className = 'ccd-select';
  branchSelect.addEventListener('change', () => {
    if (branchSelect.value) void selectBranch(branchSelect.value);
  });
  branchSelectEl = branchSelect;

  branchPicker.append(branchLabel, branchSelect);

  const picker = document.createElement('div');
  picker.className = 'ccd-picker';

  const label = document.createElement('label');
  label.className = 'ccd-label';
  label.htmlFor = 'ccd-commit-select';
  label.textContent = 'Commit';

  const select = document.createElement('select');
  select.id = 'ccd-commit-select';
  select.className = 'ccd-select';
  select.addEventListener('change', () => {
    if (select.value) void selectCommits([select.value]);
  });
  commitSelectEl = select;

  picker.append(label, select);

  const status = document.createElement('div');
  status.className = 'ccd-status';
  statusEl = status;

  const list = document.createElement('ul');
  list.className = 'ccd-file-list';
  fileListEl = list;

  sidebar.append(repoBar, branchPicker, picker, buildToolbar(), status, list);

  // Occupies the middle grid track between the two panes (see index.html's
  // #app.ccd-app). The tooltip is the only place the double-click reset is
  // discoverable — a 6px seam has nowhere to put a label.
  const resizer = document.createElement('div');
  resizer.className = 'ccd-resizer';
  resizer.title = 'Drag to resize · double-click to reset';

  const diffPane = document.createElement('div');
  diffPane.className = 'ccd-diff-pane';

  rootEl.append(sidebar, resizer, diffPane);

  initResizer(rootEl, resizer);

  initDiff(diffPane);

  void boot();
}

// ---------------------------------------------------------------------------
// View-options toolbar
//
// Controls for *how* the diff pane renders, as opposed to what it renders —
// which is why the row sits below the repo/branch/commit pickers and above the
// file list: everything above it narrows the subject, everything below it is
// the subject, and these apply to all of it equally.
//
// The state itself is deliberately not mirrored here. diff.ts owns each
// preference, persists it and restores it, and the controls below read it back
// — so there is no second copy of "which mode are we in" to drift from the
// editor's, and nothing here has to repeat the localStorage restore to render
// correctly on the first paint.
// ---------------------------------------------------------------------------

function buildToolbar(): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'ccd-toolbar';
  toolbar.append(layoutToggle(), collapseToggle());
  return toolbar;
}

/**
 * Side-by-side / Inline as a two-button segmented control.
 *
 * A segmented control rather than a checkbox because neither layout is the
 * negation of the other in the reader's head — "Inline" unchecked does not say
 * "side-by-side", it says nothing — and both names fit at the 220px minimum
 * sidebar width.
 *
 * `aria-pressed` is the only record of which segment is selected: index.html
 * styles the selection off that same attribute, so the button that looks
 * pressed is by construction the one a screen reader is told is pressed.
 */
function layoutToggle(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'ccd-segmented';
  group.role = 'group';
  group.ariaLabel = 'Diff layout';

  const segments = [
    { label: 'Side-by-side', sideBySide: true },
    { label: 'Inline', sideBySide: false }
  ].map((spec) => {
    const button = document.createElement('button');
    button.className = 'ccd-segment';
    button.type = 'button';
    button.textContent = spec.label;
    group.append(button);
    return { button, sideBySide: spec.sideBySide };
  });

  const sync = (): void => {
    for (const segment of segments) {
      segment.button.ariaPressed = String(segment.sideBySide === isSideBySide());
    }
  };

  for (const segment of segments) {
    segment.button.addEventListener('click', () => {
      setRenderSideBySide(segment.sideBySide);
      sync();
    });
  }

  sync();
  return group;
}

/**
 * "Collapse unchanged" as a checkbox, deliberately unlike the layout control
 * beside it: this one really is a thing that is either on or off, and its off
 * state has an obvious meaning (show every line). A segmented pair here would
 * cost twice the width to say the same thing.
 *
 * It exists at all as the escape hatch for the cases folding gets wrong — a
 * reader who wants the whole file, or a diff where the collapsed bars land
 * somewhere unhelpful — so it must stay one click away rather than live behind
 * a settings screen this app does not have.
 */
function collapseToggle(): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'ccd-check';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'ccd-checkbox';
  // Read back from diff.ts rather than tracked here, so the restored
  // preference and the control cannot disagree on the first paint.
  box.checked = isCollapseUnchanged();
  box.addEventListener('change', () => setCollapseUnchanged(box.checked));

  const text = document.createElement('span');
  text.textContent = 'Collapse unchanged';

  wrapper.append(box, text);
  return wrapper;
}

/**
 * Resolves which repository this session works against, then loads its commits.
 *
 * The backend serves many repos and names none of them implicitly, so the id
 * has to come from somewhere before the first request: `GET /api/repos` reports
 * the boot REPO_ROOT as `defaultRepoId`, which is what keeps single-repo
 * behaviour identical to before any of this existed — start the backend with
 * REPO_ROOT, get that repo.
 */
async function boot(): Promise<void> {
  const e = beginEpoch();
  setStatus('Loading repository…');

  let listing: ReposListing;
  try {
    listing = await api.repos();
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading repositories: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;

  const entry = await preferredRepo(listing);
  if (stale(e)) return;
  if (!entry) {
    setStatus('No repository configured. Start the backend with REPO_ROOT set.');
    return;
  }

  adoptRepo(entry);
  await loadRepoRefs();
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
  renderRepoBar();
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
 * points nest here, as they already do for selectCommit -> openFile.)
 *
 * Monaco's models for the old repo are deliberately left alive. They are keyed
 * by a URI whose authority is the repo id, so nothing this repo creates can
 * collide with them, and disposing them would only cost a re-fetch if the user
 * switches back.
 */
async function switchRepo(entry: RepoEntry): Promise<void> {
  if (repo?.id === entry.id) return;

  beginEpoch();
  adoptRepo(entry);

  // Collapse state is keyed by directory path, and those paths describe a tree
  // that does not exist in the new repo.
  resetFileTreeState();

  selectedShas = [];
  spanRevs = { headSha: '', baseSha: '' };
  files = [];
  activePath = '';
  rowsByPath.clear();
  if (fileListEl) fileListEl.innerHTML = '';

  // Not carried over: a refname is only meaningful inside the repo that has it,
  // and `refs/heads/main` naming a branch in both repos is a coincidence, not a
  // reason to open the new repo on it. loadRepoRefs() picks the new repo's HEAD.
  selectedRef = '';

  await loadRepoRefs();
}

/**
 * The bar shows the repo's *name* and carries its full path as the tooltip:
 * the sidebar is 300px by default and a checkout path does not fit in it, but
 * two repos can share a basename, so the path has to remain reachable.
 */
function renderRepoBar(): void {
  if (!repoButtonEl || !repoNameEl) return;
  repoNameEl.textContent = repo?.name ?? 'Choose repository…';
  repoButtonEl.title = repo
    ? `${repo.path} — click to switch repository`
    : 'Click to choose a repository';
}

/**
 * The revision pair `path` should be diffed at.
 *
 * A file the selection changed answers for itself: `PreviewFile` carries the
 * narrowest honest pair — from just before the first selected commit that
 * touched it, to the selected commit that touched it last. That is what makes
 * skipping a commit mean anything.
 *
 * The span pair is the fallback for a path the selection did NOT change, which
 * a cross-file F12 jump can perfectly well land on: the resolver indexes the
 * whole revision, not just the changed files. Such a path has no per-file
 * answer, and the selection's outer bounds are the closest true one.
 */
function revsFor(path: string): { headSha: string; baseSha: string } {
  return files.find((f) => f.path === path) ?? spanRevs;
}

/**
 * Switches the diff view to `path` at that file's own head/base SHAs and
 * highlights its sidebar row. `path` need not belong to the selection's
 * changed-file set — see revsFor.
 *
 * Claims an epoch, so an in-flight selection switch or an earlier file open is
 * abandoned rather than allowed to race this one to the diff pane.
 */
export async function openFile(path: string): Promise<void> {
  if (selectedShas.length === 0) {
    throw new Error('shell.openFile: no commit selected yet');
  }
  if (!files.some((f) => f.path === path)) {
    console.debug(`[ccd] openFile: "${path}" is not one of this selection's changed files`);
  }
  const e = beginEpoch();
  activePath = path;
  highlightActiveRow();
  const revs = revsFor(path);
  try {
    await createDiff(requireRepoId(), revs.headSha, revs.baseSha, path);
  } catch (err) {
    // Superseded while the diff was loading: this failure is no longer the
    // one the user is waiting on, and every caller turns a throw into a
    // status message — so swallowing it here is what keeps the winner's
    // status line intact.
    if (stale(e)) return;
    throw err;
  }
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
 */
async function loadRepoRefs(): Promise<void> {
  if (await loadBranches()) await loadCommits();
}

/**
 * Fills the branch picker from the current repo and selects HEAD's branch.
 * Returns whether `selectedRef` now names something — false covers both a
 * failed load and a repo with no branches at all, and in either case the caller
 * must not go on to list commits.
 */
async function loadBranches(): Promise<boolean> {
  const select = branchSelectEl;
  if (!select) return false;

  const e = beginEpoch();
  setStatus('Loading branches…');
  let branches: BranchInfo[];
  try {
    branches = await api.branches(requireRepoId());
  } catch (err) {
    if (stale(e)) return false;
    setStatus(`Error loading branches: ${errorMessage(err)}`);
    return false;
  }
  if (stale(e)) return false;

  // The backend guarantees an `isHead` entry for any repo that has a commit —
  // a detached HEAD gets a synthetic one — so an empty list means an empty
  // repository, with no ref to name and no commits to list under it.
  const head = branches.find((b) => b.isHead);
  renderBranchOptions(branches);
  if (!head) {
    setStatus('No branches found in repo.');
    return false;
  }

  selectedRef = head.ref;
  select.value = head.ref;
  return true;
}

/**
 * Repopulates the branch <select>: locals before remotes, each in its own
 * <optgroup>, HEAD's branch first inside its group and the rest alphabetical.
 *
 * HEAD leads because it is the entry the user has a standing relationship with
 * — it is what a fresh load selects, and it is where they will look to get back
 * after scrolling through fifty remote branches. The rest are alphabetical
 * because a branch list has no other order a reader can predict: sorting by tip
 * date would rank them by relevance, but it would also reorder the list under
 * the user's cursor every time a colleague pushed.
 *
 * Each option's value is the full refname and its text is the display name, per
 * BranchInfo — see the note on `selectedRef` for why the two are not
 * interchangeable.
 */
function renderBranchOptions(branches: BranchInfo[]): void {
  const select = branchSelectEl;
  if (!select) return;

  const options = document.createDocumentFragment();
  for (const kind of ['local', 'remote'] as const) {
    const group = branches.filter((b) => b.kind === kind).sort(byHeadThenName);
    // A repo with no remote configured has no remote refs, and an empty
    // <optgroup> still renders its label as an unselectable row.
    if (group.length === 0) continue;

    const optgroup = document.createElement('optgroup');
    optgroup.label = kind === 'local' ? 'Local' : 'Remote';
    for (const branch of group) {
      const opt = document.createElement('option');
      opt.value = branch.ref;
      opt.textContent = branch.name;
      opt.title = branch.ref;
      optgroup.appendChild(opt);
    }
    options.appendChild(optgroup);
  }

  replaceOptions(select, options);
}

function byHeadThenName(a: BranchInfo, b: BranchInfo): number {
  if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Points the commit picker at another ref and opens its newest commit.
 *
 * No epoch is claimed here: `loadCommits()` claims one before its first await,
 * and nothing happens in between that a stale caller could corrupt. Flipping
 * branches quickly therefore leaves one in-flight commit load per flip, of
 * which only the last is not stale — and `selectedRef`, set synchronously by
 * each change event, already agrees with the <select> the user is looking at.
 */
async function selectBranch(ref: string): Promise<void> {
  if (ref === selectedRef) return;
  selectedRef = ref;
  await loadCommits();
}

/**
 * `4221baf · 2024-01-03 · Add User.email…` — one commit as one <option>.
 *
 * The date is here because the branch picker put it here: two refs' logs can be
 * months apart, and between two commits from different branches nothing else on
 * the row says which is the newer. The calendar day only (CommitInfo.date is a
 * full ISO-8601 timestamp), because the sidebar is 300px by default and can be
 * dragged down to 220px, and a time of day would cost six characters the
 * subject has better use for.
 */
function commitOptionLabel(commit: CommitInfo): string {
  return `${commit.sha.slice(0, 7)} · ${commit.date.slice(0, 10)} · ${commit.subject}`;
}

/**
 * Repopulates the commit <select> with `commits`, newest first, plus `pinned` if
 * the caller has a selection the log no longer contains (see pinnedFor).
 *
 * The pinned entry goes last and inside its own `<optgroup label="Selected">`.
 * Last, so `options[0]` is still the tip for anyone asking; and in a group of its
 * own because appending it silently to a newest-first list would assert
 * something false — that it is the oldest commit on this branch, when it may not
 * be on the branch at all.
 */
function renderCommitOptions(commits: CommitInfo[], pinned: PinnedCommit | null): void {
  const select = commitSelectEl;
  if (!select) return;

  const options = document.createDocumentFragment();
  for (const commit of commits) {
    options.appendChild(commitOption(commit.sha, commitOptionLabel(commit)));
  }
  if (pinned) {
    const group = document.createElement('optgroup');
    group.label = 'Selected';
    group.appendChild(commitOption(pinned.sha, pinned.label));
    options.appendChild(group);
  }

  replaceOptions(select, options);
}

function commitOption(sha: string, label: string): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = sha;
  opt.textContent = label;
  // A <select> clips its text rather than wrapping it, and what gets clipped is
  // the subject — the one part of the row that is not recoverable from anywhere
  // else on screen.
  opt.title = label;
  return opt;
}

/**
 * Swaps `select`'s contents for `options`, unless they are already identical.
 *
 * Repopulate, don't append: this runs again on every repo switch, every branch
 * switch and every refs event, and appending would stack one ref's log under the
 * last one's.
 *
 * The no-op case is what makes a refs event cheap enough to be frequent. Most of
 * them change one ref and leave every option this picker shows untouched, and
 * rebuilding a <select> anyway is not free to the user: it closes the dropdown if
 * they have it open, and drops the keyboard type-ahead they were in the middle
 * of. Comparing what is on screen with what is about to be is a few string
 * concatenations, and it is done against the live DOM rather than a remembered
 * signature so there is no second copy of "what is rendered" to drift.
 */
function replaceOptions(select: HTMLSelectElement, options: DocumentFragment): void {
  if (optionsSignature(options) === optionsSignature(select)) return;
  select.replaceChildren(options);
}

/** Everything a reader of the <select> could tell apart: group, value, text. */
function optionsSignature(root: ParentNode): string {
  return [...root.querySelectorAll('option')]
    .map((opt) => {
      const group = opt.parentElement instanceof HTMLOptGroupElement ? opt.parentElement.label : '';
      return `${group}\u0000${opt.value}\u0000${opt.textContent ?? ''}`;
    })
    .join('\u0001');
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
 */
async function loadCommits(): Promise<void> {
  const select = commitSelectEl;
  if (!select) return;

  const e = beginEpoch();
  setStatus('Loading commits…');
  let commits: CommitInfo[];
  try {
    commits = await api.commits(requireRepoId(), selectedRef);
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading commits: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;
  if (commits.length === 0) {
    setStatus('No commits found on this branch.');
    return;
  }

  renderCommitOptions(commits, null);

  const newest = commits[0];
  if (!newest) return; // unreachable (length checked above); narrows for TS
  select.value = newest.sha;
  await selectCommits([newest.sha]);
}

/**
 * Re-reads branches and commits after the watcher said the repository's refs
 * moved, keeping the user where they are wherever that is still possible.
 *
 * Claims a fresh epoch like any other entry point: this can land in the middle
 * of a commit or file load, and the two must not both write the sidebar. What it
 * must *not* do is leave the user's own in-flight action half-applied, so the
 * decision to reload the file list below is made against `selectedShas` — what
 * is actually rendered — rather than against the previous selection. If a
 * selectCommits() was abandoned by this very epoch, `selectedShas` still holds
 * the old selection and this refresh finishes the job the user started.
 *
 * Failures are logged, not put on the status line. The user did not ask for this
 * refresh; taking over the status line to report that a background poll failed
 * would replace whatever they *are* waiting on with an error about something
 * they never did. The next refs event retries anyway.
 */
async function refreshRefs(): Promise<void> {
  const branchSelect = branchSelectEl;
  const commitSelect = commitSelectEl;
  if (!branchSelect || !commitSelect) return;

  // Captured before the first await, because every decision below is about
  // where the user *was* when the event arrived.
  const previous = {
    ref: selectedRef,
    sha: commitSelect.value,
    // The log is newest-first, and a pinned option is appended after it, so the
    // first option is the tip of the ref as it was last listed.
    tipSha: commitSelect.options[0]?.value ?? '',
    label: commitSelect.selectedOptions[0]?.textContent ?? '',
  };

  const e = beginEpoch();

  let branches: BranchInfo[];
  try {
    branches = await api.branches(requireRepoId());
  } catch (err) {
    if (!stale(e)) console.warn(`[ccd] live refresh: branches failed: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;

  // A branch can vanish under the user — deleted, renamed, or pruned by a fetch
  // — and there is then nothing to keep them on. HEAD's branch is the fallback
  // because it is the same answer a fresh load would give.
  const target = branches.find((b) => b.ref === previous.ref) ?? branches.find((b) => b.isHead);
  if (!target) return;
  renderBranchOptions(branches);
  selectedRef = target.ref;
  branchSelect.value = target.ref;

  let commits: CommitInfo[];
  try {
    commits = await api.commits(requireRepoId(), selectedRef);
  } catch (err) {
    if (!stale(e)) console.warn(`[ccd] live refresh: commits failed: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;
  const newest = commits[0];
  if (!newest) return;

  // FOLLOW HEAD ONLY FROM THE TIP. Someone sitting on the tip is watching the
  // branch and wants the new commit; someone sitting on an older commit is
  // reviewing it, and moving them would replace the diff they are reading —
  // possibly mid-file, possibly mid-thought — with a different one they never
  // asked for, and give them no way to know what they were just looking at.
  // Being late to a new commit costs a click; being yanked off an old one costs
  // the review. The user is also moved when the ref itself changed underneath
  // them, since their old selection belongs to a branch that is no longer shown.
  const followTip =
    target.ref !== previous.ref || previous.sha === '' || previous.sha === previous.tipSha;
  const selection = followTip ? newest.sha : previous.sha;

  renderCommitOptions(commits, pinnedFor(selection, previous.label, commits));
  commitSelect.value = selection;

  // Against what is rendered, not against previous.sha: this is "is the file
  // list showing the selected commit", which is the question that decides
  // whether it has to be rebuilt at all — and it is also true when nothing
  // moved but the user's own load was abandoned by this epoch.
  if (selectedShas.length !== 1 || selectedShas[0] !== selection) await selectCommits([selection]);
}

/**
 * The <option> a refreshed commit list must carry that its own log does not:
 * the user's selection, when the new log no longer contains it.
 *
 * A branch's log is capped at 100 commits, so a review that sits on an old
 * commit while the branch moves will eventually see that commit fall off the
 * end; a force-push or a reset can drop it sooner. Either way the alternative to
 * pinning is that `select.value = <sha not in the list>` silently selects
 * nothing, and the control then reads as some *other* commit — the picker would
 * be lying about what the diff pane is showing.
 *
 * Its label is carried over from the option being replaced rather than looked up
 * again: the commit is by definition not in anything we just fetched, and its
 * old row already says exactly the right thing.
 */
function pinnedFor(sha: string, label: string, commits: CommitInfo[]): PinnedCommit | null {
  if (commits.some((c) => c.sha === sha)) return null;
  return { sha, label };
}

interface PinnedCommit {
  sha: string;
  label: string;
}

/**
 * Resolves a selection of commits into its changed files, renders the file
 * list, and auto-opens the first non-deleted file.
 *
 * `shas` may name one commit (the ordinary review) or several (a ghost squash);
 * nothing below this point distinguishes them, because a preview of one commit
 * is exactly what the per-commit view always was. Order does not matter — the
 * backend sorts newest-first and hands the canonical order back.
 */
async function selectCommits(shas: string[]): Promise<void> {
  const e = beginEpoch();
  setStatus(shas.length > 1 ? `Combining ${shas.length} commits…` : 'Loading commit…');
  let result: Preview;
  try {
    result = await api.preview(requireRepoId(), shas);
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading commit: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;

  selectedShas = result.shas;
  spanRevs = { headSha: result.spanHeadSha, baseSha: result.spanBaseSha };
  files = result.files;
  activePath = '';

  // Auto-prewarm is intentionally disabled: on large repos (e.g. Lets-Plot,
  // ~2700 .kt files) eagerly indexing the whole revision on every commit
  // select is expensive — and against a blobless partial clone it would
  // trigger thousands of on-demand blob fetches. The resolver still builds
  // its index lazily on the first Ctrl+click (/api/def) and caches it per
  // revision. For small repos, re-enable with a fire-and-forget
  // POST /api/index?rev=<headSha>&repo=<id> — the api.prewarm() wrapper that
  // used to sit here went with the call it existed for.

  renderFileList(files);

  // Prefer the first non-deleted file: a deleted file's head side is empty
  // (git show HEAD:path fails -> api.file resolves to ''), which would open
  // the diff on an empty pane with nothing to Ctrl+click.
  const first = files.find((f) => f.status !== 'D') ?? files[0];
  if (!first) {
    setStatus(
      selectedShas.length > 1
        ? 'No .kt files changed in these commits.'
        : 'No .kt files changed in this commit.',
    );
    return;
  }

  setStatus('');
  try {
    await openFile(first.path);
  } catch (err) {
    setStatus(`Error loading diff: ${errorMessage(err)}`);
  }
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
// localStorage, unlike the sidebar width a few hundred lines below. A width is
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

  const badge = document.createElement('span');
  badge.className = `ccd-badge ccd-badge-${node.status}`;
  badge.textContent = node.status;

  const pathEl = document.createElement('span');
  pathEl.className = 'ccd-file-path';
  pathEl.textContent = node.name;

  row.append(badge, pathEl);
  row.addEventListener('click', () => {
    openFile(node.path).catch((err: unknown) => {
      setStatus(`Error loading diff: ${errorMessage(err)}`);
    });
  });

  rowsByPath.set(node.path, row);
  return row;
}

function highlightActiveRow(): void {
  for (const [path, row] of rowsByPath) {
    row.classList.toggle('active', path === activePath);
  }
}

function setStatus(message: string): void {
  if (statusEl) statusEl.textContent = message;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Sidebar resizer
//
// Deliberately self-contained: initShell() gains one call, and every listener,
// every scrap of drag state and the whole persistence story live below this
// line. Nothing above needs to know the sidebar is resizable, and a future
// change up there can step straight over this section.
// ---------------------------------------------------------------------------

const SIDEBAR_WIDTH_KEY = 'ccd.sidebarWidth';
const WIDTH_PROP = '--ccd-sidebar-w';
const WIDTH_MIN_PROP = '--ccd-sidebar-w-min';
const WIDTH_MAX_PROP = '--ccd-sidebar-w-max';

/**
 * Makes `handleEl` drag the sidebar's grid track width, by writing the
 * `--ccd-sidebar-w` custom property on `rootEl`. Also restores the last width
 * from localStorage and resets to the stylesheet default on double-click.
 */
function initResizer(rootEl: HTMLElement, handleEl: HTMLElement): void {
  // The clamp bounds are declared once, in index.html's :root, and read back
  // here instead of being retyped — otherwise "let the sidebar go wider" is a
  // two-file edit whose half-done version fails silently. If the tokens ever
  // go missing the resizer bows out rather than clamping against NaN, which
  // would collapse the sidebar on the first drag.
  const min = readPx(rootEl, WIDTH_MIN_PROP);
  const max = readPx(rootEl, WIDTH_MAX_PROP);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    console.warn(`[ccd] sidebar resize disabled: ${WIDTH_MIN_PROP}/${WIDTH_MAX_PROP} missing`);
    return;
  }

  // NaN means "never set" — the stylesheet default is in force, and there is
  // nothing worth persisting on release.
  let widthPx = NaN;

  const setWidth = (px: number): void => {
    widthPx = Math.round(Math.min(max, Math.max(min, px)));
    rootEl.style.setProperty(WIDTH_PROP, `${widthPx}px`);
  };

  // Clamp on read too: a width stored on a 4K monitor is absurd on a laptop,
  // and localStorage is user-editable, so a stored value is untrusted input
  // that must not be able to produce a sidebar that eats the diff pane.
  const stored = readStoredWidth();
  if (stored !== null) setWidth(stored);

  let dragging = false;
  // Distance from the pointer to the sidebar's right edge at the moment of
  // grab. Without it the sidebar snaps so that its edge lands under the
  // cursor, jumping by wherever inside the 6px seam you happened to click.
  let grabOffset = 0;

  handleEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    const current = readPx(rootEl, WIDTH_PROP);
    grabOffset = Number.isFinite(current)
      ? e.clientX - rootEl.getBoundingClientRect().left - current
      : 0;
    // Pointer capture rather than the usual document-level mousemove/mouseup
    // pair, for three reasons that each bite in this specific spot:
    //   1. there are no document listeners to add and then leak;
    //   2. the drag cannot be lost if the pointer leaves the window — the
    //      release still arrives here as pointerup/lostpointercapture;
    //   3. Monaco fills the pane you drag *toward* and handles mouse moves
    //      aggressively; capture routes every move to us regardless.
    // Note there is no preventDefault(): it would suppress the compatibility
    // mouse events the dblclick reset below is built from. Text selection is
    // instead killed by the body class, which is set before the compat
    // mousedown fires.
    handleEl.setPointerCapture(e.pointerId);
    dragging = true;
    document.body.classList.add('ccd-resizing');
  });

  handleEl.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    // Relative to #app's left edge, not the viewport's: clientX is
    // viewport-relative and #app is not promised to start at x=0.
    setWidth(e.clientX - rootEl.getBoundingClientRect().left - grabOffset);
    // No diffEditor.layout() call here, and that is not an oversight: diff.ts
    // creates the editor with automaticLayout: true, which Monaco backs with a
    // ResizeObserver (elementSizeObserver.js), so the pane resize re-lays it
    // out by itself. A manual layout() per pointermove would only add a
    // second, synchronous relayout per frame.
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ccd-resizing');
    // On release only. A drag is a hundred-odd pointermoves and every
    // localStorage write is synchronous and hits disk.
    if (Number.isFinite(widthPx)) writeStoredWidth(widthPx);
  };

  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('lostpointercapture', endDrag);

  handleEl.addEventListener('dblclick', () => {
    // Dropping the inline property hands the width back to :root's
    // --ccd-sidebar-w, so "the default" stays defined in exactly one place.
    rootEl.style.removeProperty(WIDTH_PROP);
    widthPx = NaN;
    clearStoredWidth();
  });
}

/** Numeric value of a `--custom: <n>px` property as it applies to `el`. */
function readPx(el: HTMLElement, prop: string): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(prop));
}

// localStorage is guarded on every access, not just on parse. In some privacy
// modes the *property access itself* throws a SecurityError, so an unguarded
// read at boot would take the whole app down. A remembered sidebar width is a
// convenience; it never gets to be the reason the app fails to start.

/** Last persisted width, or null if absent, unreadable or not a number. */
function readStoredWidth(): number | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return null;
    // Number('') and Number('   ') are 0, not NaN, so a blank entry would
    // otherwise read as a valid width and clamp to the minimum. Corrupt
    // storage should fall back to the stylesheet default, not to 220px.
    if (raw.trim() === '') return null;
    const px = Number(raw);
    return Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    /* quota or blocked storage: the width just won't survive the reload */
  }
}

function clearStoredWidth(): void {
  try {
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  } catch {
    /* see above */
  }
}
