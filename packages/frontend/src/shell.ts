// shell.ts — Milestone 4 "usable shell": commit picker + changed-file
// switcher. See peekdiff-mvp-iterative-wind.md, "Milestone 4 — Usable
// shell". Vanilla DOM, no framework.
//
// openFile() is the single "switch the diff view to this path" entry point.
// Both sidebar row clicks (below) and defprovider.ts's registerEditorOpener
// (via window.__ccd.openPath, wired in main.ts) call it — so a cross-file
// F12 jump and a manual sidebar click behave identically and share one
// highlighting/loading path.

import type { ChangedFile, CommitFiles, CommitInfo } from '@ctrlclickdiff/shared';
import { api, type ReposListing, type RepoEntry } from './api';
import { initDiff, createDiff } from './diff';
import { buildFileTree, type TreeNode } from './filetree';
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

// Current commit's resolved state. Empty until the first commit loads.
let headSha = '';
let baseSha = '';
let files: ChangedFile[] = [];
let activePath = '';

// Guards the four fields above against out-of-order async completions.
// Nothing serialises the async entry points below: the commit <select>'s
// change listener just fires selectCommit(), so switching commits twice on a
// slow repo leaves two api.commitFiles() calls in flight — and a slow
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

export function getHeadSha(): string {
  return headSha;
}

export function getBaseSha(): string {
  return baseSha;
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
    if (select.value) void selectCommit(select.value);
  });
  commitSelectEl = select;

  picker.append(label, select);

  const status = document.createElement('div');
  status.className = 'ccd-status';
  statusEl = status;

  const list = document.createElement('ul');
  list.className = 'ccd-file-list';
  fileListEl = list;

  sidebar.append(repoBar, picker, status, list);

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
  await loadCommits();
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

/** Makes `entry` the current repo, in state, in recents and on screen. */
function adoptRepo(entry: RepoEntry): void {
  repo = entry;
  rememberRecent(entry);
  renderRepoBar();
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

  headSha = '';
  baseSha = '';
  files = [];
  activePath = '';
  rowsByPath.clear();
  if (fileListEl) fileListEl.innerHTML = '';

  await loadCommits();
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
 * Switches the diff view to `path` at the current commit's head/base SHAs
 * and highlights its sidebar row. `path` need not belong to the current
 * commit's changed-file set — a cross-file F12 jump can land on any .kt
 * file at headSha (the resolver indexes the whole revision, not just the
 * changed files), and that's still a valid diff to render.
 *
 * Claims an epoch, so an in-flight commit switch or an earlier file open is
 * abandoned rather than allowed to race this one to the diff pane.
 */
export async function openFile(path: string): Promise<void> {
  if (!headSha) {
    throw new Error('shell.openFile: no commit selected yet');
  }
  if (!files.some((f) => f.path === path)) {
    console.debug(`[ccd] openFile: "${path}" is not one of this commit's changed files`);
  }
  const e = beginEpoch();
  activePath = path;
  highlightActiveRow();
  try {
    await createDiff(requireRepoId(), headSha, baseSha, path);
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
 * Fills the commit picker from the current repo's log and opens its newest
 * commit. Reads the <select> from module state rather than taking it as an
 * argument: it is called from boot() and again from every repo switch, and a
 * caller that had to carry the element around would be carrying it only to
 * hand it straight back.
 */
async function loadCommits(): Promise<void> {
  const select = commitSelectEl;
  if (!select) return;

  const e = beginEpoch();
  setStatus('Loading commits…');
  let commits: CommitInfo[];
  try {
    commits = await api.commits(requireRepoId());
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading commits: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;
  if (commits.length === 0) {
    setStatus('No commits found in repo.');
    return;
  }

  // Repopulate, don't append: every repo switch calls this again, and
  // appending would stack the new repo's log under the old repo's.
  select.innerHTML = '';
  for (const commit of commits) {
    const opt = document.createElement('option');
    opt.value = commit.sha;
    opt.textContent = `${commit.sha.slice(0, 7)} ${commit.subject}`;
    select.appendChild(opt);
  }

  const newest = commits[0];
  if (!newest) return; // unreachable (length checked above); narrows for TS
  select.value = newest.sha;
  await selectCommit(newest.sha);
}

/**
 * Resolves `sha` -> { headSha, baseSha, files }, renders the changed-file
 * list, and auto-opens the first non-deleted file.
 */
async function selectCommit(sha: string): Promise<void> {
  const e = beginEpoch();
  setStatus('Loading commit…');
  let result: CommitFiles;
  try {
    result = await api.commitFiles(requireRepoId(), sha);
  } catch (err) {
    if (stale(e)) return;
    setStatus(`Error loading commit: ${errorMessage(err)}`);
    return;
  }
  if (stale(e)) return;

  headSha = result.headSha;
  baseSha = result.baseSha;
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
    setStatus('No .kt files changed in this commit.');
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

function renderFileList(changedFiles: ChangedFile[]): void {
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
