// repopicker.ts — the "which repository am I reviewing?" modal, and the
// recents list behind it.
//
// It lives outside shell.ts on purpose. shell.ts is the file every change in
// this project touches, and a directory browser is a second screenful of
// bookkeeping (a cwd, a selection, a listing, a modal's lifetime) that nothing
// in the shell needs to see. The shell gains a bar and a callback; everything
// below is private to this file.
//
// The interface is deliberately one verb — openRepoPicker({ onPick }) — plus
// the recents helpers, because the shell decides *when* a repo is remembered
// (only after a switch actually succeeds) while this file owns *how* it is
// stored.

import type { BrowseEntry, BrowseListing, RepoEntry } from '@ctrlclickdiff/shared';
import { api } from './api';

/** A repo the user has opened before. Shape of one `ccd.recentRepos` element. */
export interface RecentRepo {
  id: string;
  name: string;
  /** The path is the durable half: ids are re-derived from it on every boot. */
  path: string;
}

const RECENTS_KEY = 'ccd.recentRepos';

// Long enough that the repos someone actually alternates between are all one
// click away, short enough that the list stays scannable inside a modal.
const MAX_RECENTS = 8;

// localStorage is guarded on every access, not just on parse — in some privacy
// modes the *property access itself* throws a SecurityError. Same rule the
// sidebar width follows in shell.ts: a remembered repo is a convenience, and it
// never gets to be the reason the app fails to start.

/** Most-recent-first, or [] if storage is unreadable or holds anything else. */
export function readRecents(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validated element by element rather than trusted: this is user-editable
    // storage that may also have been written by an older shape of this app,
    // and a malformed entry must degrade to "no recents", never to a crash.
    return parsed.filter(isRecentRepo).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function isRecentRepo(value: unknown): value is RecentRepo {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, path } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && typeof path === 'string';
}

/** Moves `repo` to the front of the recents list, deduplicating by path. */
export function rememberRecent(repo: RepoEntry): void {
  const { id, name, path } = repo;
  writeRecents([{ id, name, path }, ...readRecents().filter((r) => r.path !== path)]);
}

/** Drops `path` from recents — for a repo that has moved or been deleted. */
export function forgetRecent(path: string): void {
  writeRecents(readRecents().filter((r) => r.path !== path));
}

function writeRecents(recents: RecentRepo[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
  } catch {
    /* quota or blocked storage: the list just won't survive the reload */
  }
}

export interface RepoPickerOptions {
  /** Called once, with a registered repo, after the user commits to a choice. */
  onPick(repo: RepoEntry): void;
}

/**
 * Opens the modal directory browser. Registers the chosen directory with
 * `POST /api/repos` before calling `onPick`, so the shell only ever receives a
 * repo the backend has already accepted — and the failure ("not a git
 * repository", "outside the browse root") is reported where the user made the
 * choice, instead of arriving later as a broken commit list.
 */
export function openRepoPicker({ onPick }: RepoPickerOptions): void {
  let listing: BrowseListing | null = null;
  let selected: BrowseEntry | null = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'ccd-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'ccd-modal';
  modal.role = 'dialog';
  modal.ariaModal = 'true';
  modal.ariaLabel = 'Open repository';

  const title = document.createElement('div');
  title.className = 'ccd-modal-title';
  title.textContent = 'Open repository';

  const recentsEl = document.createElement('div');
  recentsEl.className = 'ccd-recents';

  const nav = document.createElement('div');
  nav.className = 'ccd-modal-nav';

  const upBtn = document.createElement('button');
  upBtn.className = 'ccd-icon-btn';
  upBtn.type = 'button';
  upBtn.textContent = '↑';
  upBtn.title = 'Up one directory';
  upBtn.addEventListener('click', () => {
    if (listing?.parent) void navigate(listing.parent);
  });

  const crumbs = document.createElement('div');
  crumbs.className = 'ccd-crumbs';
  nav.append(upBtn, crumbs);

  const list = document.createElement('ul');
  list.className = 'ccd-browse-list';

  const foot = document.createElement('div');
  foot.className = 'ccd-modal-foot';

  const message = document.createElement('div');
  message.className = 'ccd-modal-msg';
  message.ariaLive = 'polite';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ccd-btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);

  const openBtn = document.createElement('button');
  openBtn.className = 'ccd-btn ccd-btn-primary';
  openBtn.type = 'button';
  openBtn.textContent = 'Open';
  openBtn.disabled = true;
  openBtn.addEventListener('click', () => {
    if (selected) void choose(selected.path);
  });

  foot.append(message, cancelBtn, openBtn);
  modal.append(title, recentsEl, nav, list, foot);
  backdrop.append(modal);

  // Click-outside and Escape both close, because a modal that can only be
  // dismissed by finding its Cancel button is a trap on a narrow window.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  // Captured, and the key consumed, for the reason commitpalette.ts states for
  // the same handler: a modal is the topmost thing on screen, so Escape belongs
  // to it before anything underneath treats it as its own. In the bubble phase
  // whatever holds focus gets first refusal — and Monaco binds Escape on its
  // own DOM node, so the moment this picker is reachable with the editor
  // focused, the bubble version stops closing it.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  function close(): void {
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  }

  // The resting state of the message line is the one thing the picker cannot
  // show any other way: double-click descends, and a gesture has no label.
  // Clearing a message therefore restores the hint rather than blanking a row
  // of the modal.
  const HINT = 'Select a repository, or double-click a folder to browse into it.';

  function setMessage(text: string): void {
    message.textContent = text || HINT;
  }

  /** Registers `path` and hands the result to the shell, or explains why not. */
  async function choose(path: string): Promise<void> {
    setMessage('Opening…');
    openBtn.disabled = true;
    let entry: RepoEntry;
    try {
      entry = await api.registerRepo(path);
    } catch (err) {
      setMessage(errorMessage(err));
      openBtn.disabled = !selected?.isRepo;
      // A recent that no longer registers has moved or been deleted, and
      // offering it again next time is offering the same failure again.
      // Harmless for a path that was browsed to rather than remembered.
      forgetRecent(path);
      renderRecents();
      return;
    }
    close();
    onPick(entry);
  }

  function select(entry: BrowseEntry, row: HTMLElement): void {
    selected = entry;
    for (const el of list.querySelectorAll('.ccd-browse-row')) {
      el.classList.toggle('selected', el === row);
      el.ariaSelected = String(el === row);
    }
    // The one rule the picker enforces: only a git checkout can be opened. The
    // flag is the backend's cheap `.git` probe, so POST /api/repos still gets
    // the last word — see choose().
    openBtn.disabled = !entry.isRepo;
    setMessage(entry.isRepo ? '' : `${entry.name} is not a git repository.`);
  }

  async function navigate(path?: string): Promise<void> {
    setMessage('');
    try {
      listing = await api.browse(path);
    } catch (err) {
      setMessage(errorMessage(err));
      return;
    }
    selected = null;
    openBtn.disabled = true;
    upBtn.disabled = listing.parent === null;
    renderCrumbs(listing);
    renderEntries(listing);
  }

  /**
   * Root-relative breadcrumb: every ancestor down to the current directory,
   * each clickable. The root's own crumb is its basename, since the segments
   * above the browse root are not places this picker can go.
   */
  function renderCrumbs(current: BrowseListing): void {
    crumbs.innerHTML = '';
    const rest = current.path.slice(current.root.length).split('/').filter(Boolean);
    const crumb = (label: string, path: string): void => {
      const btn = document.createElement('button');
      btn.className = 'ccd-crumb';
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => void navigate(path));
      crumbs.append(btn);
    };

    crumb(basename(current.root), current.root);
    let walked = current.root;
    for (const segment of rest) {
      walked = `${walked}/${segment}`;
      crumb(segment, walked);
    }
  }

  function renderEntries(current: BrowseListing): void {
    list.innerHTML = '';
    if (current.entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ccd-browse-empty';
      empty.textContent = 'No subdirectories here.';
      list.append(empty);
      return;
    }

    for (const entry of current.entries) {
      const item = document.createElement('li');
      item.className = 'ccd-browse-item';

      // Single click selects, double click descends — the desktop file-picker
      // convention. The separate chevron exists because double-click is neither
      // discoverable nor reachable from the keyboard, and descending has to be
      // both.
      const row = document.createElement('button');
      row.className = 'ccd-browse-row';
      row.type = 'button';
      row.title = entry.path;
      row.ariaSelected = 'false';
      row.addEventListener('click', () => select(entry, row));
      row.addEventListener('dblclick', () => void navigate(entry.path));

      const name = document.createElement('span');
      name.className = 'ccd-browse-name';
      name.textContent = entry.name;
      row.append(name);

      if (entry.isRepo) {
        const badge = document.createElement('span');
        badge.className = 'ccd-repo-badge';
        badge.textContent = 'repo';
        row.append(badge);
      }

      const enter = document.createElement('button');
      enter.className = 'ccd-icon-btn';
      enter.type = 'button';
      enter.textContent = '›';
      enter.title = `Browse into ${entry.name}`;
      enter.addEventListener('click', () => void navigate(entry.path));

      item.append(row, enter);
      list.append(item);
    }
  }

  /**
   * Recents are the reason this modal is usually a one-click affair: someone
   * alternating between two checkouts should never have to browse to either
   * again.
   */
  function renderRecents(): void {
    recentsEl.innerHTML = '';
    const recents = readRecents();
    if (recents.length === 0) return;

    const label = document.createElement('div');
    label.className = 'ccd-label';
    label.textContent = 'Recent';
    recentsEl.append(label);

    const recentList = document.createElement('ul');
    recentList.className = 'ccd-recent-list';
    for (const recent of recents) {
      const item = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'ccd-recent-row';
      btn.type = 'button';
      btn.title = recent.path;
      btn.addEventListener('click', () => void choose(recent.path));

      const name = document.createElement('span');
      name.className = 'ccd-recent-name';
      name.textContent = recent.name;

      const path = document.createElement('span');
      path.className = 'ccd-recent-path';
      path.textContent = recent.path;

      btn.append(name, path);
      item.append(btn);
      recentList.append(item);
    }
    recentsEl.append(recentList);
  }

  document.body.append(backdrop);
  renderRecents();
  // No argument: browsing always starts at the backend's browse root, which is
  // the one directory guaranteed to be reachable.
  void navigate();
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
