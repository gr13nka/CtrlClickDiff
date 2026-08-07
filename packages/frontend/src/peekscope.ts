// peekscope.ts — Monaco's peek list, told which of its candidates belong to the
// commits under review.
//
// Ctrl+click answers "where is this defined?" against the whole revision, not
// against the selection, so the candidate list mixes files the reviewer chose
// with files they did not. Nothing in Monaco's widget can tell them apart, and
// the difference is the only thing a reviewer actually wants to know first.
//
// Three facts about that widget shape everything below. All three were read out
// of monaco-editor 0.55.1 and then measured in the browser, because each one is
// the kind of thing that would otherwise be discovered by a feature quietly not
// working:
//
//  1. **The list order is not ours.** `provideDefinition`'s array is re-sorted by
//     URI (`referencesModel.js:120`), so ranking candidates in the provider does
//     not put in-review files at the top. Marking them is what tells them apart;
//     ordering cannot.
//  2. **A row's path is in `aria-label`, not `title`.** This Monaco renders file
//     rows through `IconLabel` with a *custom* hover (`custom-hover="true"`), so
//     the native title attribute the label API suggests is never written. The
//     `aria-label` holds exactly the string the label service answered for that
//     URI (`IconLabel.setLabel`'s `title` option, iconLabel.js:88-93 and 124,
//     filled by referencesTree.js:113) — which is what makes the CSS below
//     keyable at all, and which is why `rowLabel` below is urilabel.ts's
//     `modelUriLabel` rather than anything computed here.
//  3. **One candidate file means no file rows.** With a single group the tree's
//     input is that group (`referencesWidget.js:451`), so the list is bare
//     reference rows and there is nothing here to mark. That is not a gap to
//     paper over: with one candidate there is no choice to present.
//
// Marking is CSS keyed on `aria-label` rather than classes hung on rows by an
// observer, and that is deliberate. `monaco-list` recycles row elements as it
// scrolls, so a class set on a row eventually describes a different file than
// the one it is painted on — silently, and only in long lists. An attribute
// selector cannot drift: it matches whatever the row is showing right now.

import type * as monaco from 'monaco-editor';
import { modelUriLabel } from './urilabel';

/** What one Ctrl+click's candidates are, split by whether the review contains them. */
export interface PeekScope {
  /** Model URIs of the candidates inside the review. */
  inReview: readonly monaco.Uri[];
  /** …and of the candidates outside it. */
  outside: readonly monaco.Uri[];
}

/**
 * The text Monaco puts in a file row's `aria-label`, which is what the rules and
 * the row walk below both match on.
 *
 * This is urilabel.ts's `modelUriLabel` — the SAME function the label service
 * answers with, not a local reimplementation of it. That identity is the whole
 * correctness of this module: the widget derives the row label by calling the
 * service, so a second definition here would be free to drift, and drifting
 * fails silently. A selector that matches nothing looks exactly like a peek with
 * nothing to mark — no error, no log, just a feature that quietly stopped.
 */
const rowLabel = modelUriLabel;

const STYLE_ID = 'ccd-peek-scope';

let styleEl: HTMLStyleElement | null = null;

/**
 * Makes the next peek reflect `scope`, in the two ways a peek can be made to:
 *
 *  - it **styles** the candidate list, replacing whatever the previous gesture
 *    asked for, and
 *  - it **moves the preview** onto an in-review candidate, once a widget opens,
 *    if Monaco chose one outside the review.
 *
 * The second is worth the emphasis: this call ends in synthetic clicks on
 * Monaco's own list, which is not something a name alone can be expected to
 * carry. It was called `markPeekScope` for exactly as long as it took someone to
 * read the call site and believe it only wrote CSS.
 *
 * Called on every `provideDefinition`, which means twice per Ctrl+click and once
 * per Ctrl+hover, so both halves stay cheap: two CSS rules rewritten wholesale,
 * and a poll that is bounded in time and does nothing at all when no peek appears.
 */
export function applyPeekScope(scope: PeekScope): void {
  latest = scope;
  sheet().textContent = rulesFor(scope);
  watchForPeek();
}

function sheet(): HTMLStyleElement {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.append(styleEl);
  }
  return styleEl;
}

/**
 * The one deliberate exception to "ALL CSS is inline in index.html": these
 * selectors are generated per gesture from paths only this module knows, so the
 * static half and the dynamic half of one decision would otherwise live in two
 * files. The colours are still the app's — `var(--ccd-*)` reads the palette
 * index.html declares, so a theme change carries this along untouched.
 */
function rulesFor({ inReview, outside }: PeekScope): string {
  const rules: string[] = [];

  if (inReview.length > 0) {
    rules.push(
      `${labelSelector(inReview)} .label-name {`,
      `  color: var(--ccd-fg-emphasis);`,
      `  font-weight: 600;`,
      `}`,
    );
  }

  if (outside.length > 0) {
    // Dimming the whole label takes the filename and its directory together, so
    // the row reads as one greyed unit rather than a bright name over a faded
    // path. The italic carries the same distinction where the two rows are not
    // side by side to compare.
    //
    // There is deliberately no "· not in this commit" text on these rows, and
    // that is a result rather than an omission — it was written, measured and
    // taken out. The tree pane is ~150px wide: "Label.kt" needs 52px and the note
    // another ~95px, so the two cannot both render, and every way of resolving
    // that fight loses more than it wins. Unpinned, the note itself ellipsized to
    // "· not in this…", which reads as broken rather than deliberate. Pinned, it
    // clipped the *filename* to "L…", and a row that no longer says which file it
    // is has given up its whole job. If the grey ever needs words, the place with
    // room for them is the peek's title bar, not the row.
    rules.push(
      `${labelSelector(outside)} {`,
      `  opacity: 0.55;`,
      `}`,
      `${labelSelector(outside)} .label-name {`,
      `  font-style: italic;`,
      `}`,
    );
  }

  return rules.join('\n');
}

function labelSelector(uris: readonly monaco.Uri[]): string {
  return uris
    .map((uri) => `.ref-tree .reference-file > .monaco-icon-label[aria-label="${cssString(rowLabel(uri))}"]`)
    .join(',\n');
}

/**
 * Escapes a label for use inside a double-quoted CSS attribute value.
 *
 * Not theoretical: a git path may contain a double quote or a backslash, and one
 * unescaped occurrence does not break its own rule — it breaks the parse of
 * everything after it in the stylesheet, so the marking simply stops with
 * nothing logged and nothing thrown.
 */
function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Nudging the peek onto a candidate that is in the review
//
// Marking says which rows belong to the commits under review; this decides which
// one the reader is looking at when the widget opens. Monaco's own answer is
// `nearestReference` — the candidate whose URI shares the longest prefix with the
// clicked file (referencesController.js:152) — which is a *directory proximity*
// rule and knows nothing about the selection. A definition in the file next door
// therefore beats the one the reviewer actually chose to review, which is the
// whole complaint this module exists to answer.
//
// There is no supported way to ask for a different initial selection: the widget
// is private to Monaco's controller, and the option that would let our ordering
// decide (`gotoAndPeek`) jumps the band to the target file first, which loses the
// reader's place and the in-place peek this tool is named after. So the nudge is
// what a user would do — click the row — and it is deliberately timid: one
// attempt per widget, and any surprise leaves Monaco's choice standing.
// ---------------------------------------------------------------------------

/** How long an `applyPeekScope` call keeps looking for a widget to nudge. */
const WATCH_MS = 1500;

/** Frames to let Monaco's own reveal finish after it has selected a row. */
const SETTLE_FRAMES = 3;

/**
 * The scope of the most recent resolution, read once — when a widget is first
 * seen — and passed down from there.
 *
 * *When* it is sampled is the whole of its correctness, so it is worth being
 * explicit about. Sampling at watch-start would be wrong: a Ctrl+hover starts a
 * watch, and the click that opens the peek is a later, different call. Sampling
 * inside the nudge would be wrong the other way: a hover over some other word
 * during the frames it waits would swap the scope out from under a widget that is
 * already on screen. The moment the widget appears is the one instant at which
 * "the newest resolution" and "the resolution this peek is showing" are the same
 * thing.
 */
let latest: PeekScope = { inReview: [], outside: [] };

/**
 * Widgets already considered. Membership means "we have had our one go at this
 * peek" — which is also what stops the nudge from fighting a reader who then
 * clicks a greyed row on purpose.
 */
const handled = new WeakSet<Element>();

let watching = false;

/**
 * Watches for a peek to open and settle, for a bounded stretch.
 *
 * A poll rather than a MutationObserver, and the reason is the teardown: the
 * widget is built, filled and *then* selected into, across several turns of the
 * event loop, so an observer would have to debounce itself into being a poll
 * anyway — and would then have to be disconnected on a path that has no natural
 * end. This one stops on its own, whether or not a peek ever appeared.
 */
function watchForPeek(): void {
  if (watching) return;
  watching = true;

  const deadline = performance.now() + WATCH_MS;
  const step = (): void => {
    const tree = document.querySelector('.zone-widget .ref-tree');
    // A settled widget has told the tree what to select. Before that the rows
    // are there but the choice is not, and acting would race Monaco's own
    // setSelection — which would then overwrite us.
    if (tree && !handled.has(tree) && tree.querySelector('.monaco-list-row.selected')) {
      handled.add(tree);
      watching = false;
      // Sampled here and carried, rather than read again inside the nudge — see
      // `latest` for why this instant is the right one.
      const scope = latest;
      // A few frames after the selection lands, not the same one: `setSelection`
      // resolves before the reveal it started has finished settling the preview,
      // and acting on top of that in-flight work is what turns the nudge into a
      // cancellation the console reports as an unhandled "Canceled".
      let settle = SETTLE_FRAMES;
      const go = (): void => {
        if (settle-- > 0) requestAnimationFrame(go);
        else nudgeIntoReview(tree, scope);
      };
      requestAnimationFrame(go);
      return;
    }
    if (performance.now() < deadline) {
      requestAnimationFrame(step);
      return;
    }
    watching = false;
  };
  requestAnimationFrame(step);
}

/**
 * Moves the peek's preview to the first in-review candidate, if it opened on one
 * outside the review.
 *
 * Every early return here is a real case, not defensiveness: with one candidate
 * *file* the tree has no file rows at all (its input is that group), and with
 * nothing in the review there is nowhere better to go. Both mean "leave it
 * alone", which is why they are silent.
 */
function nudgeIntoReview(tree: Element, scope: PeekScope): void {
  const rows = [...tree.querySelectorAll('.monaco-list-row')];
  const inReview = new Set(scope.inReview.map(rowLabel));

  const selected = rows.findIndex((row) => row.classList.contains('selected'));
  if (selected < 0) return;

  const openedOn = fileLabelOwning(rows, selected);
  if (openedOn === null || inReview.has(openedOn)) return;

  const target = firstFileRow(rows, (label) => inReview.has(label));
  if (target === null) return;

  // Monaco expands only the group it revealed into, so the target's references
  // are not in the DOM yet — and clicking the file row is what expands it. The
  // preview does not follow a file row (the widget reacts to references only),
  // so that click alone changes nothing the reader can see; it exists to put the
  // row we actually want on screen.
  if (target.row.getAttribute('aria-expanded') === 'false') {
    click(target.row);
  }
  clickFirstReference(tree, target.label, EXPAND_FRAMES);
}

/** The first file row whose label `wanted` accepts, with that label. */
function firstFileRow(
  rows: readonly Element[],
  wanted: (label: string) => boolean,
): { row: Element; label: string } | null {
  for (const row of rows) {
    const label = fileLabelOf(row);
    if (label !== null && wanted(label)) return { row, label };
  }
  return null;
}

/**
 * Frames to wait for an expanded group's references to be rendered.
 *
 * The expand is a tree re-render, not a synchronous DOM insert: reading the rows
 * back in the same turn finds the list exactly as it was, which is how the first
 * version of this nudge "worked" — it selected the right file row, clicked
 * nothing, and left the preview on the file it was supposed to move away from.
 * Ten frames is far more than the one it takes, and costs nothing when the row
 * arrives on the first.
 */
const EXPAND_FRAMES = 10;

/**
 * Clicks the first reference under the file row labelled `label`, once it exists.
 *
 * A single click is a `show`: it previews without navigating and without closing
 * the widget. `detail: 2` would pin it instead and take the reader out of the
 * file they are reading, which is the opposite of the point.
 */
function clickFirstReference(tree: Element, label: string, framesLeft: number): void {
  const rows = [...tree.querySelectorAll('.monaco-list-row')];
  const at = rows.findIndex((row) => fileLabelOf(row) === label);
  const child = at < 0 ? undefined : rows[at + 1];

  if (child && fileLabelOf(child) === null) {
    click(child);
    return;
  }
  if (framesLeft > 0) {
    requestAnimationFrame(() => clickFirstReference(tree, label, framesLeft - 1));
    return;
  }
  // The group never expanded. Monaco's pick stands — a worse answer, but a
  // working one — and this line is what keeps that from being silent.
  console.debug('[ccd] peek scope: no reference row to nudge to');
}

/** The file label of `row` itself, or null if it is a reference row. */
function fileLabelOf(row: Element): string | null {
  return row.querySelector('.reference-file > .monaco-icon-label')?.getAttribute('aria-label') ?? null;
}

/** The file label of the group `rows[index]` belongs to — itself, or above it. */
function fileLabelOwning(rows: readonly Element[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    const label = fileLabelOf(row);
    if (label !== null) return label;
  }
  return null;
}

function click(el: Element): void {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: 1, button: 0 }));
  }
}
