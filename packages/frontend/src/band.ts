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

import type { FileStatus, PreviewFile } from '@ctrlclickdiff/shared';
import type * as monaco from 'monaco-editor';
import { createFileDiff, createFileView, type FileDiff } from './diff';

/**
 * How far outside the viewport a card starts loading, in px. Generous on
 * purpose: the height a placeholder guesses is almost always wrong, and
 * correcting it a screenful *below* the fold is invisible where correcting it
 * on screen is a jump. It also has to cover a fast scroll — a card that only
 * began loading as it appeared would show its placeholder for a round trip.
 */
/**
 * What A/M/D are called in the summary's accessible name. The badge beside each
 * count stays a letter for the same reason it does everywhere else — it is a
 * glyph, and a glyph is a poor thing to hear.
 */
const SUMMARY_WORDS: Record<FileStatus, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
};

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

/**
 * A card the reader arrived at by Ctrl+click, holding a file the selection never
 * changed. It carries the revision to show, because that is the one thing a
 * PreviewFile supplies for a reviewed file and nothing supplies for this one:
 * there is no base/head pair to diff, only the revision the definition was
 * resolved against.
 */
interface ContextOf {
  readonly rev: string;
}

interface Card {
  file: PreviewFile;
  /** Set only on a context card — see ContextOf. Null means "this is a diff". */
  context: ContextOf | null;
  el: HTMLElement;
  body: HTMLElement;
  twisty: HTMLButtonElement;
  /** The `+n −m` slot in the header. Empty until this card has been mounted once. */
  churn: HTMLElement;
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
  /**
   * Opens `path` at `rev` as a read-only reference card at the foot of the
   * column and reveals it. For a definition in a file the selection did not
   * change, which therefore has no diff to show.
   */
  openContext(path: string, rev: string, line?: number): Promise<void>;
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

    const pending = (
      card.context
        ? createFileView(card.body, { repoId, path: card.file.path, rev: card.context.rev })
        : createFileDiff(card.body, {
            repoId,
            path: card.file.path,
            status: card.file.status,
            baseSha: card.file.baseSha,
            headSha: card.file.headSha
          })
    ).then(
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
        void showChurn(card, diff, e, token);
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
   * Writes `+n −m` into a card's header once its diff has been computed.
   *
   * Awaits `whenDiffComputed` rather than reading straight after the mount,
   * because `churn()` is null until Monaco's worker has answered — the same
   * readiness the reveal maths waits on. Guarded by both the band epoch and the
   * card's own token for the same reason every await in this file is: the
   * selection can change, or this one card can be scrolled away from, while the
   * worker is still thinking, and a number written after either would be
   * describing a diff that is no longer on screen.
   *
   * A count only appears once a card has been mounted, which is when the reader
   * arrives at it. That is a real limitation and an accepted one: the honest
   * alternative — asking git — answers a different question (see FileDiff.churn).
   */
  async function showChurn(card: Card, diff: FileDiff, e: number, token: number): Promise<void> {
    await diff.whenDiffComputed();
    if (e !== bandEpoch || token !== card.token || card.diff !== diff) return;

    const counts = diff.churn();
    if (!counts) return;

    card.churn.replaceChildren();
    // Two spans rather than one string, because the two numbers are coloured
    // with the same green and red the lines themselves use — which is the whole
    // point of putting them here, and is why they are also written with a sign
    // rather than relying on that colour to say which is which.
    for (const [cls, text] of [
      ['ccd-churn-add', `+${counts.added}`],
      ['ccd-churn-del', `−${counts.removed}`]
    ] as const) {
      const part = document.createElement('span');
      part.className = cls;
      part.textContent = text;
      card.churn.append(part);
    }
    card.churn.title = `${counts.added} added, ${counts.removed} removed`;
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

  function buildCard(file: PreviewFile, context: ContextOf | null = null): Card {
    const el = document.createElement('section');
    el.className = context ? 'ccd-card ccd-card-context' : 'ccd-card';
    el.dataset.path = file.path;

    const header = document.createElement('div');
    header.className = 'ccd-card-header';

    const twisty = document.createElement('button');
    twisty.className = 'ccd-card-twisty';
    twisty.type = 'button';
    twisty.textContent = '▾';
    twisty.ariaExpanded = 'true';
    twisty.title = 'Collapse this file';

    // A context card carries no A/M/D — it is not part of the change — so its
    // badge says what it IS instead. Saying it on the card rather than only in
    // the status line matters: this is the one place the reader is looking after
    // a jump, and an unlabelled file here would read as part of the review.
    const badge = document.createElement('span');
    if (context) {
      badge.className = 'ccd-badge ccd-badge-context';
      badge.textContent = 'ref';
      badge.title = 'Not changed by this selection — opened for reference';
    } else {
      badge.className = `ccd-badge ccd-badge-${file.status}`;
      badge.textContent = file.status;
    }

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

    // Last, so it sits at the far right of the header past the ⚠ rather than
    // between the name and its own warning. Filled in by mount() once Monaco
    // has computed the diff, which is also the only moment it CAN be: the count
    // comes off the editor, and cards mount lazily. Empty until then rather
    // than a spinner or a zero — the path is what identifies a card, so an
    // absent number costs nothing while a wrong one would be read as fact.
    const churn = document.createElement('span');
    churn.className = 'ccd-card-churn';
    header.append(churn);

    const body = document.createElement('div');
    body.className = 'ccd-card-body';
    body.style.height = `${UNMEASURED_HEIGHT_PX}px`;

    el.append(header, body);

    const card: Card = {
      file,
      context,
      el,
      body,
      twisty,
      churn,
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

  /**
   * Appends a read-only card for a file the selection never changed, then
   * reveals it — the landing place for a Ctrl+click whose definition lives
   * outside the review.
   *
   * Appended rather than inserted in path order, because these cards are not
   * part of the change: the reviewed files are a set with a meaning and an order,
   * and interleaving reference material into it would make the column stop being
   * a description of the commit. They accumulate at the foot in the order the
   * reader asked for them, which is also the order they will want to go back
   * through.
   *
   * Re-asking for a path that is already open just reveals it, whether it was
   * opened as context or is a reviewed file — the caller does not have to know
   * which, and neither does the reader.
   */
  async function openContext(path: string, rev: string, line?: number): Promise<void> {
    if (!byPath.has(path)) {
      // A PreviewFile shape with no status of its own: `status` is only read by
      // createFileDiff, which a context card never reaches, and skippedShas is
      // the ⚠ affordance, which would be a lie about a file no commit here
      // touched.
      const card = buildCard(
        { path, status: 'M', baseSha: rev, headSha: rev, skippedShas: [] },
        { rev },
      );
      cards.push(card);
      byPath.set(path, card);
      host.append(card.el);

      // Claim the reveal exemption BEFORE observing. `observe()` always
      // delivers an initial entry, and a card appended at the foot of a long
      // column is not intersecting when it arrives — so without this the
      // observer's first tick unmounts the very card this call exists to open,
      // and the reveal then races that teardown.
      revealTarget = path;
      mountObserver?.observe(card.el);
      activeObserver?.observe(card.el);
    }

    // One frame before mounting, and it is not cosmetic. This is reached from
    // the peek's editor-opener, and Monaco tears the peek widget down as soon as
    // that returns. The model is normally already built — the peek made it — so
    // createFileView has nothing to await and would construct its editor in the
    // very tick the widget is being disposed, at which point Monaco's lazily
    // built suggest widget lands on an already-disposed instantiation service
    // and throws where nothing can catch it. Yielding once puts the two apart.
    await nextFrame();
    await revealPath(path, line);
  }

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

  /**
   * How big this review is, above the first card: a file count and a breakdown
   * by status.
   *
   * Both come straight off `PreviewFile[]`, so this is on screen the moment the
   * preview lands — before any editor exists. That is the whole reason it is
   * counted here and not summed from the per-card churn: cards mount lazily, so
   * a total built from them would start wrong and creep towards right as the
   * reader scrolled, which is worse than not showing one.
   *
   * NOT sticky, deliberately. It answers "what am I about to read", once; the
   * card headers are the sticky layer and a second one would compete with them
   * for the same edge.
   */
  function buildSummary(files: PreviewFile[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ccd-band-summary';

    const count = document.createElement('span');
    count.className = 'ccd-summary-count';
    count.textContent = files.length === 1 ? '1 file' : `${files.length} files`;
    el.append(count);

    // Only the statuses actually present, so a plain edit does not carry two
    // zeroes explaining what did not happen.
    for (const status of ['A', 'M', 'D'] as const) {
      const n = files.filter((f) => f.status === status).length;
      if (n === 0) continue;

      const group = document.createElement('span');
      group.className = 'ccd-summary-group';

      const badge = document.createElement('span');
      // The same badge vocabulary the rows and card headers use — a reader who
      // has learned it once should not have to learn a second spelling here.
      badge.className = `ccd-badge ccd-badge-${status}`;
      badge.textContent = status;
      badge.ariaHidden = 'true';

      const label = document.createElement('span');
      label.textContent = String(n);

      group.append(badge, label);
      group.ariaLabel = `${n} ${SUMMARY_WORDS[status]}`;
      el.append(group);
    }

    const skipped = files.filter((f) => f.skippedShas.length > 0).length;
    if (skipped > 0) {
      const warn = document.createElement('span');
      warn.className = 'ccd-summary-warn';
      warn.textContent = `⚠ ${skipped} also carry unselected edits`;
      el.append(warn);
    }

    return el;
  }

  function cardOf(target: Element): Card | undefined {
    const path = (target as HTMLElement).dataset.path;
    return path === undefined ? undefined : byPath.get(path);
  }

  function render(nextRepoId: string, files: PreviewFile[]): void {
    teardown();
    repoId = nextRepoId;
    active = '';

    // Not `files.map(buildCard)`: map would pass the array index as the second
    // argument, making every card after the first a context card.
    cards = files.map((file) => buildCard(file));
    for (const card of cards) byPath.set(card.file.path, card);
    host.append(buildSummary(files), ...cards.map((c) => c.el));
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
    openContext,
    clear,
    activeEditor: () => byPath.get(active)?.diff?.modified ?? null,
    activePath: () => active
  };
}
