// commitpalette.ts — "which commits am I reviewing?", as a searchable modal.
//
// It replaces a <select>, and the reason is not only that a <select> cannot
// multi-select without being ugly. A <select> clips its text, and what got
// clipped was the subject line — the one part of a commit row that is not
// recoverable from anywhere else on screen. A hundred commits also has to be
// searchable to be navigable, and a native dropdown offers only type-ahead on a
// label that starts with the sha.
//
// It lives outside shell.ts on the same rule repopicker.ts does: shell.ts is the
// file every change in this project touches, and a filtered list with its own
// keyboard model is a screenful of bookkeeping nothing in the shell needs to
// see. The shell gains a call site; everything below is private to this file.
//
// The interface is one verb — openCommitPalette({ commits, selected, onApply })
// — and it deliberately traffics in CommitInfo rather than bare SHAs. A
// selection has to be able to outlive the log it came from (see PINNED below),
// which means whoever holds it must hold its metadata too.

import type { CommitInfo } from '@ctrlclickdiff/shared';

export interface CommitPaletteOptions {
  /** The current ref's log, newest-first, as `GET /api/commits` returned it. */
  commits: CommitInfo[];
  /** What is selected right now, newest-first. */
  selected: CommitInfo[];
  /** Called with the new selection, newest-first. Not called if nothing changed. */
  onApply(selection: CommitInfo[]): void;
}

/** `4221baf` — enough to identify a commit by eye, and what git itself prints. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The calendar day only: a time of day costs six characters the subject wants. */
function shortDate(date: string): string {
  return date.slice(0, 10);
}

export function openCommitPalette({ commits, selected, onApply }: CommitPaletteOptions): void {
  // PINNED. A ref's log is capped at 100 commits, so a review that sits on an
  // old commit while the branch moves will eventually see it fall off the end;
  // a force-push or a reset can drop it sooner. The selection must still be
  // shown, or the palette would be claiming the diff pane holds something other
  // than what it does. This is why `selected` arrives as CommitInfo: the commit
  // is by definition not in anything we just fetched, so its own metadata is the
  // only place its subject still exists.
  const listed = new Set(commits.map((c) => c.sha));
  const pinned = selected.filter((c) => !listed.has(c.sha));
  const all = [...commits, ...pinned];

  let query = '';
  let activeIndex = 0;
  let visible: CommitInfo[] = all;

  const backdrop = document.createElement('div');
  backdrop.className = 'ccd-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'ccd-modal ccd-palette';
  modal.role = 'dialog';
  modal.ariaModal = 'true';
  modal.ariaLabel = 'Select commits';

  const header = document.createElement('div');
  header.className = 'ccd-palette-header';

  const search = document.createElement('input');
  search.className = 'ccd-palette-search';
  search.type = 'text';
  search.placeholder = 'Search commits by sha, subject or author…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  // The list is driven from here rather than being separately focusable, so the
  // caret never has to leave the box the user is typing in to move the
  // selection — which is the whole point of a palette over a dropdown.
  search.role = 'combobox';
  search.ariaExpanded = 'true';
  search.setAttribute('aria-controls', 'ccd-palette-list');

  header.append(search);

  const list = document.createElement('ul');
  list.className = 'ccd-palette-list';
  list.id = 'ccd-palette-list';
  list.role = 'listbox';

  const foot = document.createElement('div');
  foot.className = 'ccd-palette-foot';

  const hint = document.createElement('div');
  hint.className = 'ccd-palette-hint';
  hint.textContent = '↑↓ to move · Enter to open · Esc to close';
  foot.append(hint);

  modal.append(header, list, foot);
  backdrop.append(modal);

  // Click-outside and Escape both close, because a modal that can only be
  // dismissed by finding its Cancel button is a trap on a narrow window.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  function close(): void {
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  }

  function apply(commit: CommitInfo): void {
    close();
    // Unchanged selections are not reported: re-applying would restart the
    // preview fetch and throw away the scroll position in the diff the user was
    // reading, for no change at all.
    if (selected.length === 1 && selected[0]?.sha === commit.sha) return;
    onApply([commit]);
  }

  /**
   * Captured on the document rather than bound to the modal, so the keys work
   * wherever focus happens to be — and in the capture phase so Escape reaches
   * this before anything below it in the page treats it as its own.
   */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      activeIndex = e.key === 'Home' ? 0 : visible.length - 1;
      renderList();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const commit = visible[activeIndex];
      if (commit) apply(commit);
    }
  }

  function move(delta: number): void {
    if (visible.length === 0) return;
    // Clamped, not wrapped: at a hundred rows, wrapping from the top to the
    // bottom of the list reads as the list having jumped somewhere else.
    activeIndex = Math.min(visible.length - 1, Math.max(0, activeIndex + delta));
    renderList();
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    activeIndex = 0;
    renderList();
  });

  /**
   * Matches a commit against the query on every field the row shows.
   *
   * Substring rather than prefix, and across sha, subject and author together:
   * a reviewer looking for "the auth fix" knows a word from the subject far more
   * often than they know how the sha starts, and a <select>'s type-ahead — which
   * could only match the label's leading characters — is exactly the thing this
   * replaces.
   */
  function matches(commit: CommitInfo): boolean {
    if (query === '') return true;
    return (
      commit.sha.toLowerCase().includes(query) ||
      commit.subject.toLowerCase().includes(query) ||
      commit.author.toLowerCase().includes(query)
    );
  }

  function renderList(): void {
    visible = all.filter(matches);
    activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));

    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ccd-palette-empty';
      empty.textContent = `No commit matches “${search.value.trim()}”.`;
      list.replaceChildren(empty);
      search.removeAttribute('aria-activedescendant');
      return;
    }

    const selectedShas = new Set(selected.map((c) => c.sha));
    const pinnedShas = new Set(pinned.map((c) => c.sha));

    list.replaceChildren(
      ...visible.map((commit, index) =>
        commitRow(commit, {
          active: index === activeIndex,
          selected: selectedShas.has(commit.sha),
          pinned: pinnedShas.has(commit.sha),
        }),
      ),
    );

    const activeEl = list.children[activeIndex];
    if (activeEl instanceof HTMLElement) {
      search.setAttribute('aria-activedescendant', activeEl.id);
      // 'nearest' so paging down the list scrolls by a row rather than
      // recentering the viewport on every keystroke.
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  interface RowState {
    active: boolean;
    selected: boolean;
    pinned: boolean;
  }

  function commitRow(commit: CommitInfo, state: RowState): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'ccd-palette-row';
    item.id = `ccd-commit-${commit.sha}`;
    item.role = 'option';
    item.ariaSelected = String(state.selected);
    if (state.active) item.classList.add('active');
    if (state.selected) item.classList.add('selected');
    // The subject is what a <select> used to clip; the tooltip is where the
    // full form stays reachable when the panel is narrower than the line.
    item.title = `${commit.sha}\n${commit.subject}\n${commit.author} · ${commit.date}`;

    const sha = document.createElement('span');
    sha.className = 'ccd-palette-sha';
    sha.textContent = shortSha(commit.sha);

    const subject = document.createElement('span');
    subject.className = 'ccd-palette-subject';
    subject.textContent = commit.subject;

    const meta = document.createElement('span');
    meta.className = 'ccd-palette-meta';
    // The date is here because the branch picker put it here: two refs' logs can
    // be months apart, and between two commits from different branches nothing
    // else on the row says which is the newer.
    meta.textContent = `${commit.author} · ${shortDate(commit.date)}`;

    item.append(sha, subject, meta);

    if (state.pinned) {
      const badge = document.createElement('span');
      badge.className = 'ccd-palette-badge';
      badge.textContent = 'not on this branch';
      badge.title =
        'Selected, but no longer in this ref’s log — force-pushed, reset, ' +
        'or pushed past the 100-commit limit.';
      item.append(badge);
    }

    item.addEventListener('click', () => apply(commit));
    return item;
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.body.append(backdrop);

  // Open on the current selection rather than at the top: the reviewer's
  // relationship is with where they are, and the commit they most often want is
  // the one next to it.
  const openAt = all.findIndex((c) => c.sha === selected[0]?.sha);
  activeIndex = openAt === -1 ? 0 : openAt;
  renderList();
  search.focus();
}
