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
//     `aria-label` holds exactly `uri.fsPath` — the same string `monaco.Uri` can
//     compute for us — which is what makes the CSS below keyable at all.
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

/** What one Ctrl+click's candidates are, split by whether the review contains them. */
export interface PeekScope {
  /** Monaco's own row label (`uri.fsPath`) for each candidate inside the review. */
  inReview: readonly string[];
  /** …and for each candidate outside it. */
  outside: readonly string[];
}

const STYLE_ID = 'ccd-peek-scope';

let styleEl: HTMLStyleElement | null = null;

/**
 * Points the peek list's styling at `scope`, replacing whatever the previous
 * gesture asked for.
 *
 * Called on every `provideDefinition`, which means twice per Ctrl+click and once
 * per Ctrl+hover — so it stays cheap: two rules, rewritten wholesale.
 */
export function markPeekScope(scope: PeekScope): void {
  sheet().textContent = rulesFor(scope);
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

function labelSelector(labels: readonly string[]): string {
  return labels.map((label) => `.ref-tree .reference-file > .monaco-icon-label[aria-label="${cssString(label)}"]`).join(',\n');
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
