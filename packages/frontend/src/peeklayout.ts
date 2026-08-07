// peeklayout.ts — how much of the peek goes to the answer and how much to the
// choice.
//
// Monaco splits its peek 70/30 between the preview and the candidate list, from
// a fixed `ratio: 0.7` (referencesWidget.js:146), and it never reconsiders. That
// is a reasonable default for the case it was written for — "find all references",
// where the list IS the result — and the wrong one here, because `diff.ts` sets
// `definitionLinkOpensInPeek: true` and most definitions are unique. Measured on
// a Ctrl+click with ONE definition, side by side at 1900px: the candidate list
// took 184px of a 612px widget to hold a single row repeating the line the
// preview was already showing, and the answer got 428px.
//
// The lever is not the widget. `_splitView` is private, and CSS alone cannot be
// used either — the SplitView calls `preview.layout({width})` with the width it
// computed, so restyling the box leaves Monaco's editor laid out to the old one.
// What IS reachable is where the widget gets its layout from: the controller
// reads it out of the storage service on EVERY open
// (referencesController.js:85-86, `peekViewLayout`), and writes it back on close.
// So this seeds that key, through the same service the controller itself uses —
// no private fields, no DOM surgery, and nothing to keep in sync with a widget
// that may not exist yet.
//
// Two limits worth knowing before touching this:
//
//  - The list has `minimumSize: 100` (referencesWidget.js:346), and SplitView
//    clamps to it. A ratio of 1 therefore floors the list at 100px rather than
//    removing it, which is the honest ceiling of this approach — index.html
//    paints that remnant out to match the preview, keyed on the widget having a
//    single row rather than on anything this module writes. Deliberately: a flag
//    set from here would be rewritten by any later resolve, and Monaco resolves
//    on Ctrl+HOVER too, so hovering inside an open peek made its hidden list
//    reappear. That rule and this ratio are two halves of one decision, so
//    changing either means looking at the other.
//  - The controller stores the layout back when a peek closes, so a reader who
//    drags the sash has their choice overwritten by the next single-definition
//    peek. `heightInLines` is read back and preserved for that reason; only the
//    ratio is decided here, and only when there is nothing to choose between.

import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
import { IStorageService } from 'monaco-editor/esm/vs/platform/storage/common/storage.js';

/** The key `ReferencesController` reads its `{ratio, heightInLines}` from. */
const LAYOUT_KEY = 'peekViewLayout';

// StorageScope.PROFILE and StorageTarget.MACHINE. Literals rather than imports
// because Monaco's build inlines these const enums and the module does not
// export them — see monaco-internal.d.ts.
const SCOPE_PROFILE = 0;
const TARGET_MACHINE = 1;

/** Monaco's own default, used whenever there is a choice to present. */
const DEFAULT_RATIO = 0.7;

/**
 * Ratio for a peek whose answer is unique.
 *
 * Not 1: SplitView clamps the list to its 100px minimum either way, and asking
 * for the last few pixels only makes the number look like it means something it
 * cannot deliver.
 */
const SOLE_DEFINITION_RATIO = 0.95;

interface StorageService {
  get(key: string, scope: number, fallback: string): string | undefined;
  store(key: string, value: string, scope: number, target: number): void;
}

/**
 * Sizes the next peek for `definitionCount` candidates.
 *
 * Call before returning locations from a definition provider: the widget is
 * built after the provider resolves, and it reads this key as it opens. Called
 * twice per Ctrl+click (Monaco resolves once to underline the link and once on
 * the click) — writing the same value twice is why this is safe to leave on the
 * hot path.
 */
export function sizePeekFor(definitionCount: number): void {
  const storage = StandaloneServices.get<StorageService>(IStorageService);

  // The reader's own height survives; only the split is ours to decide. A
  // corrupt or absent value falls through to Monaco's default rather than
  // throwing, exactly as LayoutData.fromJSON does with the same string.
  let heightInLines = 18;
  try {
    const stored: unknown = JSON.parse(storage.get(LAYOUT_KEY, SCOPE_PROFILE, '{}') ?? '{}');
    if (stored && typeof stored === 'object' && 'heightInLines' in stored) {
      const h = (stored as { heightInLines?: unknown }).heightInLines;
      if (typeof h === 'number' && h > 0) heightInLines = h;
    }
  } catch {
    // Not ours to repair — the controller parses this key with the same
    // tolerance and will fall back to its own defaults.
  }

  const ratio = definitionCount === 1 ? SOLE_DEFINITION_RATIO : DEFAULT_RATIO;
  storage.store(LAYOUT_KEY, JSON.stringify({ ratio, heightInLines }), SCOPE_PROFILE, TARGET_MACHINE);
}
