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

  const diffPane = document.createElement('div');
  diffPane.className = 'ccd-diff-pane';

  rootEl.append(sidebar, diffPane);

  initDiff(diffPane);

  void loadCommits(select);
}

/**
 * Switches the diff view to `path` at the current commit's head/base SHAs
 * and highlights its sidebar row. `path` need not belong to the current
 * commit's changed-file set — a cross-file F12 jump can land on any .kt
 * file at headSha (the resolver indexes the whole revision, not just the
 * changed files), and that's still a valid diff to render.
 */
export async function openFile(path: string): Promise<void> {
  if (!headSha) {
    throw new Error('shell.openFile: no commit selected yet');
  }
  if (!files.some((f) => f.path === path)) {
    console.debug(`[ccd] openFile: "${path}" is not one of this commit's changed files`);
  }
  activePath = path;
  highlightActiveRow();
  await createDiff(headSha, baseSha, path);
}

async function loadCommits(select: HTMLSelectElement): Promise<void> {
  setStatus('Loading commits…');
  let commits: CommitInfo[];
  try {
    commits = await api.commits();
  } catch (err) {
    setStatus(`Error loading commits: ${errorMessage(err)}`);
    return;
  }
  if (commits.length === 0) {
    setStatus('No commits found in repo.');
    return;
  }

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
  setStatus('Loading commit…');
  let result: CommitFiles;
  try {
    result = await api.commitFiles(sha);
  } catch (err) {
    setStatus(`Error loading commit: ${errorMessage(err)}`);
    return;
  }

  headSha = result.headSha;
  baseSha = result.baseSha;
  files = result.files;
  activePath = '';

  // Fire-and-forget: warms the tree-sitter index for this revision so the
  // first Ctrl+click doesn't pay the parse cost inline. Does not block
  // rendering the file list.
  api.prewarm(headSha);

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
