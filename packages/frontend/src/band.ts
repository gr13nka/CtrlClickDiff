// band.ts — the review column: every changed file stacked in one continuous
// scroll, next file directly below the last, the way GitHub and GitLab show a
// commit. Replaces "one file at a time, swap the models on click".
//
// This file owns the scroller, the cards and which editors exist right now.
// diff.ts owns what an editor *is* (see createFileDiff, which is the only place
// one is constructed) and keeps each card's host sized to its own content, so
// nothing here computes a line height or reads a Monaco option.
//
// Three things drive the whole design:
//
//  1. **One editor per file, not one model pair in one editor.** Concatenating
//     every file into a single synthetic pair would give a true single scroll
//     for free, and was rejected on correctness: Monaco's diff algorithm would
//     be free to align a line in file A's original against file B's modified,
//     and defprovider.ts's (rev, path, line) triple — the thing Ctrl+click peek
//     resolves against — would no longer exist.
//
//  2. **Cards are mounted lazily and unmounted again.** /api/preview caps the
//     *commits* in a selection (COMMIT_LOG_LIMIT) and nothing caps the files, so
//     a hundred-commit ghost squash over a real Kotlin repo is plausibly
//     hundreds of files. Building that many diff editors at once does not
//     degrade, it hangs the tab. What bounds the work is the viewport, not the
//     selection.
//
//  3. **Unmounting freezes the measured height first.** A card whose editor has
//     gone keeps the exact box it had, so nothing below it moves and the
//     scrollbar does not lie. Models are never disposed (see diff.ts's
//     loadModels), so coming back costs no request either.

import type { PreviewFile } from '@ctrlclickdiff/shared';
import type * as monaco from 'monaco-editor';
import { createFileDiff, type FileDiff } from './diff';

/**
 * How far outside the viewport a card starts loading, in px. Generous on
 * purpose: the height a placeholder guesses is almost always wrong, and
 * correcting it a screenful *below* the fold is invisible where correcting it
 * on screen is a jump. It also has to cover a fast scroll — a card that only
 * began loading as it appeared would show its placeholder for a round trip.
 */
const MOUNT_MARGIN_PX = 1200;

/**
 * Height a card holds before it has ever been measured. Nothing better is
 * available: the line count lives inside the file content, which is what the
 * mount is fetching. Being wrong is cheap in one direction only — too small
 * merely means a few extra cards start loading at once, where too large would
 * put the last file kilometres down a scrollbar that then collapses.
 */
const UNMEASURED_HEIGHT_PX = 260;

/**
 * The share of the scroller, from the top, whose occupant counts as "the file
 * you are reading". Implemented as a negative bottom root margin, which turns
 * the IntersectionObserver into the whole active-file mechanism — no scroll
 * listener, no rAF throttle, and no measuring every card on every frame.
 */
const ACTIVE_ZONE = '0px 0px -85% 0px';

interface Card {
  file: PreviewFile;
  el: HTMLElement;
  body: HTMLElement;
  twisty: HTMLButtonElement;
  diff: FileDiff | null;
  /** In-flight mount, so two observer ticks cannot build two editors. */
  pending: Promise<FileDiff | null> | null;
  /**
   * Bumped whenever this card stops wanting an editor. A mount that resolves
   * against a stale token throws its editor away instead of adopting it — the
   * per-card half of the cancellation story whose other half is `bandEpoch`.
   */
  token: number;
  collapsed: boolean;
  /** Last height the editor reported, held while it is away. */
  measured: number;
}

export interface Band {
  /** Rebuilds the column for a new selection. Cheap: no editors are built here. */
  render(repoId: string, files: PreviewFile[]): void;
  /** Scrolls `path` into view, mounting it if need be, and optionally centres `line`. */
  revealPath(path: string, line?: number): Promise<void>;
  /** Empties the column — for a repo switch, where the old files mean nothing. */
  clear(): void;
  /** The modified pane of the file being read, for main.ts's debug hook. */
  activeEditor(): monaco.editor.IStandaloneCodeEditor | null;
  /** The path currently at the top of the scroller, or '' before the first render. */
  activePath(): string;
}

export interface BandHooks {
  /** Fired when the file at the top of the scroller changes. */
  onActivePath(path: string): void;
  /** The ⚠ tooltip for a file with skipped commits. Owned by the shell: only it knows commit subjects. */
  describeSkipped(shas: string[]): string;
  /** Surfaces a mount failure. The band has no status line of its own. */
  onError(path: string, err: unknown): void;
}

export function initBand(host: HTMLElement, hooks: BandHooks): Band {
  let repoId = '';
  let cards: Card[] = [];
  const byPath = new Map<string, Card>();

  /**
   * Bumped by render() and clear(). Guards every await below, because a
   * selection can change while a dozen mounts are in flight and an editor built
   * for the previous preview must not appear in this one.
   */
  let bandEpoch = 0;

  let active = '';

  /**
   * The card a reveal is pointed at. Exempt from unmounting: a cross-file jump
   * scrolls first and mounts second, and the coarse scroll can leave the target
   * momentarily outside the mount margin — at which point the observer would
   * tear down the very card the jump is waiting for.
   */
  let revealTarget = '';

  let mountObserver: IntersectionObserver | null = null;
  let activeObserver: IntersectionObserver | null = null;
  const inActiveZone = new Set<Card>();

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------

  function mount(card: Card): Promise<FileDiff | null> {
    if (card.diff) return Promise.resolve(card.diff);
    if (card.pending) return card.pending;
    if (card.collapsed) return Promise.resolve(null);

    const e = bandEpoch;
    const token = card.token;

    // Hold the card's height across the fetch. createFileDiff takes it over the
    // moment it has an editor; until then this is all that stops the card
    // collapsing to nothing and dragging everything below it up the page.
    card.body.style.height = `${card.measured}px`;
    card.el.classList.add('loading');

    const pending = createFileDiff(card.body, {
      repoId,
      path: card.file.path,
      status: card.file.status,
      baseSha: card.file.baseSha,
      headSha: card.file.headSha
    }).then(
      (diff) => {
        card.pending = null;
        if (e !== bandEpoch || token !== card.token) {
          // Built for a card that has since been torn down or scrolled away
          // from. Dropping it here rather than adopting it is what keeps
          // "unmounted" honest — an orphan editor would keep laying itself out.
          diff.dispose();
          return null;
        }
        card.diff = diff;
        card.el.classList.remove('loading');
        return diff;
      },
      (err: unknown) => {
        card.pending = null;
        card.el.classList.remove('loading');
        if (e !== bandEpoch || token !== card.token) return null;
        hooks.onError(card.file.path, err);
        return null;
      }
    );

    card.pending = pending;
    return pending;
  }

  /**
   * Drops the card's editor and leaves the card exactly as tall as it was.
   *
   * The order is the point: the height has to be read off the live editor before
   * it is disposed, because afterwards there is nothing to ask. Freeze second
   * and the card would fall back to the placeholder guess, shifting every card
   * below it and moving the page under the reader's eyes.
   */
  function unmount(card: Card): void {
    card.token += 1;
    card.pending = null;
    if (card.diff) {
      card.measured = card.diff.height() || card.measured;
      card.diff.dispose();
      card.diff = null;
    }
    card.body.replaceChildren();
    card.body.style.height = `${card.measured}px`;
    card.el.classList.remove('loading');
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  function setCollapsed(card: Card, collapsed: boolean): void {
    card.collapsed = collapsed;
    card.twisty.ariaExpanded = String(!collapsed);
    card.twisty.title = collapsed ? 'Expand this file' : 'Collapse this file';
    card.body.hidden = collapsed;
    card.el.classList.toggle('collapsed', collapsed);

    if (collapsed) {
      unmount(card);
      return;
    }
    // Explicitly, rather than waiting for the observer: the card never stopped
    // intersecting, so nothing is going to fire.
    card.body.style.height = `${card.measured}px`;
    void mount(card);
  }

  function buildCard(file: PreviewFile): Card {
    const el = document.createElement('section');
    el.className = 'ccd-card';
    el.dataset.path = file.path;

    const header = document.createElement('div');
    header.className = 'ccd-card-header';

    const twisty = document.createElement('button');
    twisty.className = 'ccd-card-twisty';
    twisty.type = 'button';
    twisty.textContent = '▾';
    twisty.ariaExpanded = 'true';
    twisty.title = 'Collapse this file';

    const badge = document.createElement('span');
    badge.className = `ccd-badge ccd-badge-${file.status}`;
    badge.textContent = file.status;

    // Directory dim, basename bright. The full path has to be here — a band has
    // no sidebar selection to say which file you are looking at — but read as
    // one flat string it buries the only part that identifies the file.
    const label = document.createElement('span');
    label.className = 'ccd-card-path';
    const cut = file.path.lastIndexOf('/');
    if (cut >= 0) {
      const dir = document.createElement('span');
      dir.className = 'ccd-card-dir';
      dir.textContent = file.path.slice(0, cut + 1);
      label.append(dir);
    }
    const name = document.createElement('span');
    name.className = 'ccd-card-name';
    name.textContent = file.path.slice(cut + 1);
    label.append(name);
    label.title = file.path;

    header.append(twisty, badge, label);

    // Same mark and the same named-not-counted tooltip as the sidebar row, and
    // it belongs here more than there: this is where the reader is when they
    // wonder why the diff contains an edit the selection does not explain.
    if (file.skippedShas.length > 0) {
      const warn = document.createElement('span');
      warn.className = 'ccd-file-warn';
      warn.textContent = '⚠';
      warn.title = hooks.describeSkipped(file.skippedShas);
      header.append(warn);
    }

    const body = document.createElement('div');
    body.className = 'ccd-card-body';
    body.style.height = `${UNMEASURED_HEIGHT_PX}px`;

    el.append(header, body);

    const card: Card = {
      file,
      el,
      body,
      twisty,
      diff: null,
      pending: null,
      token: 0,
      collapsed: false,
      measured: UNMEASURED_HEIGHT_PX
    };

    twisty.addEventListener('click', () => setCollapsed(card, !card.collapsed));
    return card;
  }

  // -------------------------------------------------------------------------
  // Scrolling
  // -------------------------------------------------------------------------

  /** Distance from the scroller's top to `el`'s top, in scroll coordinates. */
  function offsetOf(el: HTMLElement): number {
    return host.scrollTop + (el.getBoundingClientRect().top - host.getBoundingClientRect().top);
  }

  function scrollCardToTop(card: Card): void {
    // Rects rather than offsetTop: this is correct whatever the offsetParent
    // chain turns out to be, which stops a later CSS `position` from silently
    // changing where a jump lands.
    host.scrollTop = Math.max(0, offsetOf(card.el));
  }

  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  async function revealPath(path: string, line?: number): Promise<void> {
    const card = byPath.get(path);
    if (!card) return;

    const e = bandEpoch;
    revealTarget = path;
    try {
      // A jump into a folded file has to open it. Landing on a collapsed header
      // would report success while showing the reader nothing.
      if (card.collapsed) setCollapsed(card, false);

      scrollCardToTop(card);

      const diff = await mount(card);
      if (e !== bandEpoch || !diff || card.diff !== diff) return;

      if (line === undefined) {
        // Again, because a card above may have swapped a guessed height for a
        // real one while this one was loading, moving this card down under a
        // scrollTop that did not move with it.
        scrollCardToTop(card);
        return;
      }

      await diff.whenDiffComputed();
      if (e !== bandEpoch || card.diff !== diff) return;

      // Cursor first, and this is the one ordering here that cannot be swapped.
      // It is the *cursor* move that expands a collapsed unchanged region, and
      // until it has, getTopForLineNumber answers with the top of the fold
      // rather than the line's own position — measured: on a collapsed 121-line
      // file, lines 1 and 2 report identical tops, so a line-height probe there
      // reads 0.
      diff.modified.setPosition({ lineNumber: line, column: 1 });
      await nextFrame();
      if (e !== bandEpoch || card.diff !== diff) return;

      const lineTop = offsetOf(card.body) + diff.modified.getTopForLineNumber(line);
      host.scrollTop = Math.max(0, lineTop - host.clientHeight / 2);
    } finally {
      // Scoped to this jump, and only if a newer one has not claimed the slot:
      // the exemption exists to survive the coarse scroll, not to pin a card
      // mounted for the rest of the session.
      if (revealTarget === path) revealTarget = '';
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function teardown(): void {
    bandEpoch += 1;
    mountObserver?.disconnect();
    activeObserver?.disconnect();
    mountObserver = null;
    activeObserver = null;
    inActiveZone.clear();
    for (const card of cards) unmount(card);
    cards = [];
    byPath.clear();
    host.replaceChildren();
    revealTarget = '';
  }

  function clear(): void {
    teardown();
    active = '';
  }

  function cardOf(target: Element): Card | undefined {
    const path = (target as HTMLElement).dataset.path;
    return path === undefined ? undefined : byPath.get(path);
  }

  function render(nextRepoId: string, files: PreviewFile[]): void {
    teardown();
    repoId = nextRepoId;
    active = '';

    cards = files.map(buildCard);
    for (const card of cards) byPath.set(card.file.path, card);
    host.append(...cards.map((c) => c.el));
    host.scrollTop = 0;

    mountObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const card = cardOf(entry.target);
          if (!card) continue;
          if (entry.isIntersecting) void mount(card);
          else if (card.file.path !== revealTarget) unmount(card);
        }
      },
      { root: host, rootMargin: `${MOUNT_MARGIN_PX}px 0px` }
    );

    activeObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const card = cardOf(entry.target);
          if (!card) continue;
          if (entry.isIntersecting) inActiveZone.add(card);
          else inActiveZone.delete(card);
        }
        // Document order, so a tall card and the small one below it in the same
        // zone resolve to the one being read rather than the one arriving.
        const top = cards.find((c) => inActiveZone.has(c));
        // No candidate means the zone landed in a gap between cards. Keeping the
        // previous answer is right: the reader has not moved to another file.
        if (!top || top.file.path === active) return;
        active = top.file.path;
        hooks.onActivePath(active);
      },
      { root: host, rootMargin: ACTIVE_ZONE }
    );

    for (const card of cards) {
      mountObserver.observe(card.el);
      activeObserver.observe(card.el);
    }
  }

  return {
    render,
    revealPath,
    clear,
    activeEditor: () => byPath.get(active)?.diff?.modified ?? null,
    activePath: () => active
  };
}
