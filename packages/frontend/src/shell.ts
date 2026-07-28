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
import { api } from './api';
import { initDiff, createDiff } from './diff';

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
const rowsByPath = new Map<string, HTMLLIElement>();

export function getHeadSha(): string {
  return headSha;
}

export function getBaseSha(): string {
  return baseSha;
}

/**
 * Builds the sidebar (commit picker + changed-file list) and the diff pane
 * inside `rootEl`, then kicks off loading the commit log. Call once at boot.
 */
export function initShell(rootEl: HTMLElement): void {
  rootEl.innerHTML = '';
  rootEl.classList.add('ccd-app');

  const sidebar = document.createElement('div');
  sidebar.className = 'ccd-sidebar';

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

  picker.append(label, select);

  const status = document.createElement('div');
  status.className = 'ccd-status';
  statusEl = status;

  const list = document.createElement('ul');
  list.className = 'ccd-file-list';
  fileListEl = list;

  sidebar.append(picker, status, list);

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

  void loadCommits(select);
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
    await createDiff(headSha, baseSha, path);
  } catch (err) {
    // Superseded while the diff was loading: this failure is no longer the
    // one the user is waiting on, and every caller turns a throw into a
    // status message — so swallowing it here is what keeps the winner's
    // status line intact.
    if (stale(e)) return;
    throw err;
  }
}

async function loadCommits(select: HTMLSelectElement): Promise<void> {
  const e = beginEpoch();
  setStatus('Loading commits…');
  let commits: CommitInfo[];
  try {
    commits = await api.commits();
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

  // Repopulate, don't append: this runs once at boot today, but a second
  // call (the planned branch selector) would otherwise stack a whole second
  // commit log onto the first.
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
 * Resolves `sha` -> { headSha, baseSha, files }, prewarms the resolver
 * index for headSha (fire-and-forget — see api.prewarm), renders the
 * changed-file list, and auto-opens the first non-deleted file.
 */
async function selectCommit(sha: string): Promise<void> {
  const e = beginEpoch();
  setStatus('Loading commit…');
  let result: CommitFiles;
  try {
    result = await api.commitFiles(sha);
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
  // revision. For small repos, re-enable with: api.prewarm(headSha);

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

function renderFileList(changedFiles: ChangedFile[]): void {
  if (!fileListEl) return;
  fileListEl.innerHTML = '';
  rowsByPath.clear();

  for (const file of changedFiles) {
    const row = document.createElement('li');
    row.className = 'ccd-file-row';
    row.title = file.path;

    const badge = document.createElement('span');
    badge.className = `ccd-badge ccd-badge-${file.status}`;
    badge.textContent = file.status;

    const pathEl = document.createElement('span');
    pathEl.className = 'ccd-file-path';
    pathEl.textContent = file.path;

    row.append(badge, pathEl);
    row.addEventListener('click', () => {
      openFile(file.path).catch((err: unknown) => {
        setStatus(`Error loading diff: ${errorMessage(err)}`);
      });
    });

    fileListEl.appendChild(row);
    rowsByPath.set(file.path, row);
  }

  highlightActiveRow();
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
