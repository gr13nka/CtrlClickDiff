// branchpalette.ts — "which ref's history am I looking at?", as a searchable
// modal, matching the commit palette beside it in the breadcrumb.
//
// The list this replaces was a <select> with two <optgroup>s, and on a repo with
// a real remote that is a scrolling list of a hundred branch names with no way
// to narrow it but type-ahead on a prefix. Searching is the whole reason this
// exists; the visual consistency with commitpalette.ts is the other half.
//
// Shares that file's DOM contract (.ccd-palette and friends) and modal.ts's
// shell, but not its code. Each has a different notion of a row, of a group,
// and of what choosing one means. See the note at the foot of this file before
// reaching for a shared palette abstraction.

import type { BranchInfo } from '@ctrlclickdiff/shared';
import { createModal } from './modal';

export interface BranchPaletteOptions {
  branches: BranchInfo[];
  /** Full refname of the ref currently listed, e.g. `refs/heads/main`. */
  selectedRef: string;
  /** Called with a full refname. Not called when the ref did not change. */
  onPick(ref: string): void;
}

export function openBranchPalette({ branches, selectedRef, onPick }: BranchPaletteOptions): void {
  // Locals before remotes, HEAD's branch first inside its group, the rest
  // alphabetical. HEAD leads because it is the entry the user has a standing
  // relationship with — it is what a fresh load selects, and it is where they
  // look to get back after scrolling past fifty remote branches. The rest are
  // alphabetical because a branch list has no other order a reader can predict:
  // sorting by tip date would rank them by relevance, but it would also reorder
  // the list under the cursor every time a colleague pushed.
  const ordered = [
    ...branches.filter((b) => b.kind === 'local').sort(byHeadThenName),
    ...branches.filter((b) => b.kind === 'remote').sort(byHeadThenName),
  ];

  let query = '';
  let activeIndex = 0;
  let visible: BranchInfo[] = ordered;

  const modal = createModal({ label: 'Select branch', variant: 'ccd-palette', onKeyDown });

  const header = document.createElement('div');
  header.className = 'ccd-palette-header';

  const search = document.createElement('input');
  search.className = 'ccd-palette-search';
  search.type = 'text';
  search.placeholder = 'Search branches…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.role = 'combobox';
  search.ariaExpanded = 'true';
  search.setAttribute('aria-controls', 'ccd-branch-list');
  header.append(search);

  const list = document.createElement('ul');
  list.className = 'ccd-palette-list';
  list.id = 'ccd-branch-list';
  list.role = 'listbox';

  const foot = document.createElement('div');
  foot.className = 'ccd-palette-foot';
  const hint = document.createElement('div');
  hint.className = 'ccd-palette-hint';
  hint.textContent = '↑↓ to move · Enter to open · Esc to close';
  foot.append(hint);

  modal.panel.append(header, list, foot);

  function pick(branch: BranchInfo): void {
    modal.close();
    // Re-picking the current ref would reload its log and throw away the
    // selection and the diff the user is reading, to arrive back where they are.
    if (branch.ref === selectedRef) return;
    onPick(branch.ref);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (visible.length === 0) return;
      // Clamped, not wrapped: on a long list, wrapping from the top to the
      // bottom reads as the list having jumped somewhere else.
      activeIndex = Math.min(
        visible.length - 1,
        Math.max(0, activeIndex + (e.key === 'ArrowDown' ? 1 : -1)),
      );
      renderList();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const branch = visible[activeIndex];
      if (branch) pick(branch);
    }
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    activeIndex = 0;
    renderList();
  });

  function renderList(): void {
    visible = ordered.filter((b) => query === '' || b.name.toLowerCase().includes(query));
    activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));

    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ccd-palette-empty';
      empty.textContent = `No branch matches “${search.value.trim()}”.`;
      list.replaceChildren(empty);
      search.removeAttribute('aria-activedescendant');
      return;
    }

    const rows: HTMLElement[] = [];
    let group = '';
    visible.forEach((branch, index) => {
      // Section headers are emitted from the ordered list rather than looped per
      // kind, so filtering never leaves the header of an empty group behind.
      if (branch.kind !== group) {
        group = branch.kind;
        rows.push(groupHeader(group === 'local' ? 'Local' : 'Remote'));
      }
      rows.push(branchRow(branch, index === activeIndex));
    });
    list.replaceChildren(...rows);

    const activeEl = list.querySelector('.ccd-palette-row.active');
    if (activeEl instanceof HTMLElement) {
      search.setAttribute('aria-activedescendant', activeEl.id);
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function branchRow(branch: BranchInfo, active: boolean): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'ccd-palette-row ccd-branch-row';
    item.id = `ccd-branch-${branch.ref}`;
    item.role = 'option';
    const isCurrent = branch.ref === selectedRef;
    item.ariaSelected = String(isCurrent);
    if (active) item.classList.add('active');
    if (isCurrent) item.classList.add('selected');
    // The full refname, because the display name does not identify a ref: a
    // local branch may be called `origin/main`, which renders exactly as the
    // remote-tracking `refs/remotes/origin/main` does.
    item.title = branch.ref;

    const mark = document.createElement('span');
    mark.className = 'ccd-palette-sha';
    // HEAD's own marker, not the selection's — those are different questions,
    // and the selection already has a background colour saying so.
    mark.textContent = branch.isHead ? '✓' : '';
    mark.title = branch.isHead ? 'Checked out' : '';

    const name = document.createElement('span');
    name.className = 'ccd-palette-subject';
    name.textContent = branch.name;

    const meta = document.createElement('span');
    meta.className = 'ccd-palette-meta';
    meta.textContent = branch.tipSha.slice(0, 7);

    item.append(mark, name, meta);
    item.addEventListener('click', () => pick(branch));
    return item;
  }

  function groupHeader(label: string): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'ccd-palette-group';
    item.role = 'presentation';
    item.textContent = label;
    return item;
  }

  modal.open();

  // After open(), not before: renderList() scrolls the active row into view,
  // and scrollIntoView on a detached element is a silent no-op — which would
  // land the palette at the top of the list instead of on the current ref.
  const openAt = ordered.findIndex((b) => b.ref === selectedRef);
  activeIndex = openAt === -1 ? 0 : openAt;
  renderList();
  search.focus();
}

function byHeadThenName(a: BranchInfo, b: BranchInfo): number {
  if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
  return a.name.localeCompare(b.name);
}

// ON NOT EXTRACTING A SHARED PALETTE — measured, not assumed, and still the
// position. The rows are different shapes (three columns and a pin badge
// against a marker, a name and a group header); the searches match different
// fields; choosing means different things (a selection that may hold several
// commits against a single ref); and the commit palette has a mode toggle and a
// footer action this one has no use for. A generic palette taking row
// renderers, a search projection, group predicates and footer slots would be
// more code than the duplication it removes, and every future change to either
// palette would have to be negotiated through it. That has not been done.
//
// What HAS been extracted is modal.ts — the backdrop, the labelled panel, the
// click-outside and the Escape handler, and nothing else. That is the "build a
// backdrop, close on Escape" half of what this note originally listed as
// shared; the other half (the active index, the clamp, the scroll into view)
// stayed here and in commitpalette.ts on purpose, because sharing it would need
// the shell to know each palette's `visible.length` and to call back into its
// renderer, which is the first concession the argument above is about.
//
// The trigger for that extraction was not a third palette. It was the repo
// picker — a third *modal*, which is a different claim — plus evidence the
// duplication had stopped being harmless: the three copies had drifted, two
// capturing Escape and consuming it while the third bubbled and did not.
//
// The revisit trigger for the palette itself is unchanged: a third palette.
// Three is where the shared shape stops being a guess. Until then this is the
// cheaper of the two kinds of complexity.
