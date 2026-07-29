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
import { createModal } from './modal';
import { readStored, writeStored } from './storage';

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

const GHOST_KEY = 'ccd.ghostSquash';

// Whether the palette opens ready to build a multi-commit selection. Remembered
// like the diff view preferences, and for the same reason: someone comparing
// several groupings of commits should not have to re-arm the mode on every
// open. Anything but the exact string 'on' reads as off, which is the default.
let ghostArmed = readStored(GHOST_KEY) === 'on';

const GHOST_EXPLAINER =
  'Shows several commits as one combined diff. Nothing is rewritten — no rebase, ' +
  'no new commits, your history is untouched.\n\n' +
  'Each file is diffed from just before the first selected commit that changed it, ' +
  'to the selected commit that changed it last. A file that only unselected commits ' +
  'touched disappears from the review entirely.\n\n' +
  'A file that a commit you left out ALSO edited is marked ⚠ in the file list: its ' +
  'diff contains that commit’s changes too, because no revision in the repository ' +
  'holds the file with your commits and without the others.';

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

  // Forced on when several commits are already selected: single-select mode has
  // no way to show a three-commit selection, so opening in it would misreport
  // what the diff pane is holding.
  let ghost = ghostArmed || selected.length > 1;

  // The set being assembled, by sha. Separate from `selected` because in ghost
  // mode nothing is applied until the reviewer says so — ticking four commits
  // should cost one preview fetch, not four.
  const working = new Set(selected.map((c) => c.sha));

  const modal = createModal({ label: 'Select commits', variant: 'ccd-palette', onKeyDown });

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

  // --- Ghost squash mode row -------------------------------------------------

  const modeRow = document.createElement('div');
  modeRow.className = 'ccd-palette-mode';

  const ghostToggle = document.createElement('button');
  ghostToggle.type = 'button';
  ghostToggle.className = 'ccd-ghost-toggle';
  ghostToggle.textContent = '👻 Ghost squash';
  ghostToggle.addEventListener('click', () => setGhost(!ghost));

  const infoButton = document.createElement('button');
  infoButton.type = 'button';
  infoButton.className = 'ccd-info-btn';
  infoButton.textContent = 'ⓘ';
  infoButton.ariaLabel = 'What is ghost squash?';
  infoButton.ariaExpanded = 'false';

  // An expandable note rather than a `title` tooltip: a title never appears for
  // a keyboard user, and this text is the difference between "why did that file
  // vanish" and understanding the feature.
  const explainer = document.createElement('p');
  explainer.className = 'ccd-palette-explainer';
  explainer.textContent = GHOST_EXPLAINER;
  explainer.hidden = true;

  infoButton.addEventListener('click', () => {
    explainer.hidden = !explainer.hidden;
    infoButton.ariaExpanded = String(!explainer.hidden);
  });

  const modeHint = document.createElement('span');
  modeHint.className = 'ccd-palette-mode-hint';

  modeRow.append(ghostToggle, infoButton, modeHint);

  const list = document.createElement('ul');
  list.className = 'ccd-palette-list';
  list.id = 'ccd-palette-list';
  list.role = 'listbox';

  const foot = document.createElement('div');
  foot.className = 'ccd-palette-foot';

  const hint = document.createElement('div');
  hint.className = 'ccd-palette-hint';

  const previewButton = document.createElement('button');
  previewButton.type = 'button';
  previewButton.className = 'ccd-btn ccd-btn-primary';
  previewButton.addEventListener('click', applyWorking);

  foot.append(hint, previewButton);

  modal.panel.append(header, modeRow, explainer, list, foot);

  /** Single-select: choosing a row IS the choice, so it applies and closes. */
  function apply(commit: CommitInfo): void {
    modal.close();
    // Unchanged selections are not reported: re-applying would restart the
    // preview fetch and throw away the scroll position in the diff the user was
    // reading, for no change at all.
    if (selected.length === 1 && selected[0]?.sha === commit.sha) return;
    onApply([commit]);
  }

  /**
   * Ghost mode: hand over everything ticked, newest-first.
   *
   * Ordered by `all`, which is the log's own newest-first order, so the
   * selection reaching the shell is already in the order the backend will
   * confirm — and the header lists the commits in the order the reviewer saw
   * them, not the order they happened to tick them in.
   */
  function applyWorking(): void {
    const next = all.filter((c) => working.has(c.sha));
    if (next.length === 0) return;
    modal.close();
    if (sameShas(next, selected)) return;
    onApply(next);
  }

  function toggle(commit: CommitInfo): void {
    if (!working.delete(commit.sha)) working.add(commit.sha);
    renderList();
    renderMode();
  }

  /**
   * Flips the mode and remembers it.
   *
   * Turning it OFF collapses a multi-commit set to its newest member rather than
   * clearing it: single-select mode has to name exactly one commit, and the
   * newest is the one the reviewer would land on from a fresh load anyway.
   * Nothing is applied here — the working set is not the selection until the
   * reviewer commits to it.
   */
  function setGhost(next: boolean): void {
    ghost = next;
    ghostArmed = next;
    writeStored(GHOST_KEY, next ? 'on' : 'off');

    if (!ghost && working.size > 1) {
      const newest = all.find((c) => working.has(c.sha));
      working.clear();
      if (newest) working.add(newest.sha);
    }
    renderMode();
    renderList();
    search.focus();
  }

  function renderMode(): void {
    ghostToggle.ariaPressed = String(ghost);
    modal.panel.classList.toggle('ghost', ghost);

    const count = working.size;
    modeHint.textContent = ghost
      ? count === 0
        ? 'Tick the commits to combine'
        : `${count} selected`
      : 'Combine several commits into one diff';

    previewButton.hidden = !ghost;
    previewButton.disabled = count === 0;
    previewButton.textContent = count === 1 ? 'Preview 1 commit' : `Preview ${count} commits`;

    hint.textContent = ghost
      ? '↑↓ to move · Space to tick · Enter to preview · Esc to cancel'
      : '↑↓ to move · Enter to open · Esc to close';
  }

  /**
   * Every key but Escape — modal.ts captures on the document and handles that
   * one, then hands the rest here untouched. This palette's key model (ticking
   * with Space, Home/End, Enter meaning two different things by mode) stays in
   * this file, which is the whole point of the split.
   */
  function onKeyDown(e: KeyboardEvent): void {
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
    if (e.key === ' ' && ghost) {
      // Only in ghost mode: in single-select there is nothing to tick, and
      // swallowing Space would stop the reviewer typing one into the search
      // box, which any multi-word subject search needs.
      e.preventDefault();
      const commit = visible[activeIndex];
      if (commit) toggle(commit);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // In ghost mode Enter commits the whole set, not the row under the cursor
      // — the row is already ticked or not, and the decision Enter answers is
      // "show me this".
      if (ghost) {
        applyWorking();
        return;
      }
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

    const pinnedShas = new Set(pinned.map((c) => c.sha));

    list.replaceChildren(
      ...visible.map((commit, index) =>
        commitRow(commit, {
          active: index === activeIndex,
          // Against the working set, not `selected`: in ghost mode the ticks
          // are what the reviewer is building, and they must reflect the clicks
          // made since the palette opened rather than the last applied preview.
          selected: working.has(commit.sha),
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

    // The tick box is a span, not an <input type=checkbox>: the whole row is
    // already the hit target and already carries role=option with aria-selected,
    // so a real checkbox would add a second focusable thing announcing the same
    // state twice. CSS draws it from the row's .selected class, which means the
    // box that looks ticked cannot disagree with the row that is.
    if (ghost) {
      const tick = document.createElement('span');
      tick.className = 'ccd-palette-tick';
      tick.ariaHidden = 'true';
      item.append(tick);
    }

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

    item.addEventListener('click', () => (ghost ? toggle(commit) : apply(commit)));
    return item;
  }

  modal.open();

  // Open on the current selection rather than at the top: the reviewer's
  // relationship is with where they are, and the commit they most often want is
  // the one next to it.
  const openAt = all.findIndex((c) => c.sha === selected[0]?.sha);
  activeIndex = openAt === -1 ? 0 : openAt;
  renderMode();
  renderList();
  search.focus();
}

function sameShas(a: CommitInfo[], b: CommitInfo[]): boolean {
  return a.length === b.length && a.every((commit, i) => commit.sha === b[i]?.sha);
}
