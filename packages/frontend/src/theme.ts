// The app's Monaco theme, matching index.html's --ccd-* palette (GitHub
// Primer dark). Until this file existed nothing called setTheme or passed a
// `theme` option anywhere, so the diff editor ran Monaco's built-in default —
// `vs`, the LIGHT one — inside dark chrome.

import * as monaco from 'monaco-editor';

const THEME_ID = 'ccd-github-dark';

/**
 * The whole-line diff washes, named because CSS needs them too.
 *
 * index.html has one rule that must paint with exactly the inserted-line
 * colour — Monaco's alignment spacer beside an added block, which Monaco itself
 * paints with the *removed* colour (see that rule). Restating `#3fb95020` there
 * would be a second copy of a value whose whole job is to match, i.e. the drift
 * hazard `modelUri`/`parseModelUri` are kept together to avoid. So the constant
 * lives here, next to the theme it belongs to, and is published to CSS at the
 * foot of installTheme.
 */
const DIFF_INSERTED_LINE = '#3fb95020';
const DIFF_REMOVED_LINE = '#f8514920';

/**
 * The peek's own raised surface, published for the same reason as the two above.
 *
 * When a peek has a single definition there is no choice to present, so
 * peeklayout.ts collapses the candidate list — and the 100px SplitView floor it
 * cannot go below has to be painted to match the preview beside it, or the
 * widget ends in a strip that reads as a pane which failed to load. Nothing in
 * the theme reaches that gap, so the rule lives in index.html and the value
 * lives here: it has no meaning except "whatever `peekViewEditor.background`
 * is", and a copy of it in the stylesheet is a copy free to drift.
 */
const PEEK_SURFACE = '#161b22';

/**
 * Defines and activates the app's Monaco theme. Call once, before any editor
 * is constructed.
 *
 * setTheme (global) rather than a `theme` in the editor's construction
 * options, deliberately: the theme then covers every editor Monaco creates on
 * its own — the peek widget's inner editor above all, which diff.ts never
 * constructs and so could never have passed an option to.
 */
export function installTheme(): void {
  monaco.editor.defineTheme(THEME_ID, {
    base: 'vs-dark',
    inherit: true,
    // GitHub Primer dark's syntax colours, replacing vs-dark's inherited ones.
    // Two reasons, and the second is the load-bearing one:
    //
    //  1. vs-dark's palette is VS Code's, not GitHub's — leaving it would make
    //     the editor the one part of the app that isn't the theme we adopted.
    //  2. Contrast. vs-dark's comment green (#6a9955) computes 4.01:1 against
    //     an added word-diff background — below WCAG AA — so a diff that edits
    //     inside a comment renders it unreadably. Every colour below clears
    //     4.5:1 over both the added and removed word-diff tints (worst case is
    //     the comment grey at 4.72:1) as well as over plain canvas.
    //
    // Unknown token names are ignored by Monaco, so listing a few that the
    // Kotlin tokenizer may not emit costs nothing.
    rules: [
      { token: 'comment', foreground: '8b949e' },
      { token: 'keyword', foreground: 'ff7b72' },
      { token: 'string', foreground: 'a5d6ff' },
      { token: 'number', foreground: '79c0ff' },
      { token: 'regexp', foreground: 'a5d6ff' },
      { token: 'annotation', foreground: 'd2a8ff' },
      { token: 'type', foreground: 'ffa657' },
      { token: 'type.identifier', foreground: 'ffa657' },
      { token: 'identifier', foreground: 'e6edf3' },
      { token: 'delimiter', foreground: 'e6edf3' }
    ],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#e6edf3',
      'editorGutter.background': '#0d1117',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#e6edf3',
      'editor.lineHighlightBackground': '#161b22',
      'editorWidget.background': '#161b22',
      'editorWidget.border': '#30363d',
      // --- The Ctrl+click peek ---------------------------------------------
      //
      // Three of these keys were set and the other ten were not, so the widget
      // this tool is named after rendered half GitHub and half VS Code. Two of
      // the fallbacks were not cosmetic:
      //
      //  1. `peekView.border` is registered as an ALIAS of
      //     `editorInfo.foreground` (peekView.js:232), whose dark default is
      //     #3794ff — so an unset border painted a saturated blue frame,
      //     measured at 6.17:1 against the canvas while the added lines it
      //     framed sit at 1.204:1. Five times the contrast of the content, on
      //     the chrome. index.html's palette comment states the rule that
      //     breaks: the chrome reads quieter than the diff it frames. Same
      //     defect the sidebar's activePath fill already had, same fix.
      //  2. `peekViewEditor.background` was #0d1117 — bit-identical to
      //     `editor.background`, measured 1.000:1 against the editor behind it.
      //     Nothing but that blue frame said "overlay", which is exactly WHY
      //     the frame had to shout. Calming the frame without giving the peek a
      //     surface of its own would have dissolved it into the diff, so these
      //     two are one change and must stay that way.
      //
      // The layering now reads by elevation instead of by hue: title and
      // preview raised to canvas-subtle, the candidate list recessed to canvas
      // so the ANSWER is the brightest surface and the choice is subordinate,
      // and index.html's one `.peekview-widget` rule carries the shadow.
      //
      // The contrast budget here is looser than the diff's — the peek preview
      // is a plain editor with no diff tint under the tokens — but it is not
      // free: raising the background to #161b22 costs every token some
      // headroom, and `comment` #8b949e is the theme's darkest. Measured in the
      // browser at 5.62:1, against the 4.5:1 floor. If that surface ever moves
      // again, re-measure the comment rather than assuming.
      'peekView.border': '#30363d',
      'peekViewTitle.background': '#161b22',
      'peekViewTitleLabel.foreground': '#e6edf3',
      'peekViewTitleDescription.foreground': '#8b949e',
      'peekViewEditor.background': PEEK_SURFACE,
      'peekViewEditorGutter.background': PEEK_SURFACE,
      'peekViewEditorStickyScroll.background': PEEK_SURFACE,
      'peekViewResult.background': '#0d1117',
      'peekViewResult.fileForeground': '#e6edf3',
      'peekViewResult.lineForeground': '#8b949e',
      // Two accents that were neither of ours: the selected row came up in VS
      // Code's #3399ff33 and the match highlights in #ea5c004d / #ff8f0099, a
      // saturated orange painted straight over the definition the reader came
      // to read. The selection now uses the app's own accent, and the match
      // highlight the attention amber at an alpha low enough to sit under text.
      'peekViewResult.selectionBackground': '#1f6feb40',
      'peekViewResult.selectionForeground': '#e6edf3',
      'peekViewResult.matchHighlightBackground': '#1f6feb40',
      'peekViewEditor.matchHighlightBackground': '#d2992240',

      // Bracket-pair colourisation is on by default and is NOT covered by the
      // `rules` above — it is painted from these workbench colours, whose
      // defaults are VS Code's rainbow (gold, orchid, …). Left alone it is the
      // one loudly non-GitHub thing left on screen, since Primer's own palette
      // is far more muted.
      'editorBracketHighlight.foreground1': '#79c0ff',
      'editorBracketHighlight.foreground2': '#56d364',
      'editorBracketHighlight.foreground3': '#e3b341',
      'editorBracketHighlight.foreground4': '#ffa198',
      'editorBracketHighlight.foreground5': '#ff9bce',
      'editorBracketHighlight.foreground6': '#d2a8ff',
      'editorBracketHighlight.unexpectedBracket.foreground': '#f85149',

      // The four diff backgrounds MUST stay translucent (8-digit hex). Monaco
      // registers them with the needsTransparency flag — the trailing `true`
      // argument at vs/platform/theme/common/colors/editorColors.js:76-79,
      // whose own description reads "The color must not be opaque so as not to
      // hide underlying decorations." An opaque tint here would paint over the
      // selection and search highlights inside a changed line.
      //
      // Lines are tinted more weakly (20 ~ 13%) than the two of them stacked on
      // an intra-line word diff, which is how GitHub reads: a whole-line wash,
      // with the tokens that actually changed picked out on top of it.
      //
      // THESE NUMBERS ARE A CONSTRAINED OPTIMUM, NOT A PREFERENCE, and the
      // constraint is far tighter than it looks. Three things bound them:
      //
      //  - The darkest token in `rules` above is `comment` #8b949e, and it has
      //    to stay >= 4.5:1 (WCAG AA) read THROUGH the line tint and the word
      //    tint stacked. That is the entire budget and there is almost none of
      //    it: on bare canvas the comment is only 5.0:1, so about half a point
      //    is available to spend. Swept in 1/255 steps, the frontier is line
      //    0x2c / word 0x07 — past line 0x2f NO word tint keeps AA at all.
      //  - Raising the line tint COSTS word-diff legibility, because the word
      //    tint is read against the line tint under it, not against the canvas.
      //    Measured: line 0x14/word 0x1a gives word-vs-line 1.17; line 0x26 /
      //    word 0x0a buys a 1.25:1 line but collapses the word highlight to
      //    1.07, which is not a highlight. 0x20/0x10 is the balance point —
      //    line 1.11 -> 1.20, word 1.17 -> 1.10.
      //  - The gutter LOOKS like free contrast — nothing but the line number
      //    #6e7681 sits on it, and it takes 0x32 (20%) before that drops under
      //    3:1. It is not free, and the reason is only visible on an added or
      //    deleted file: Monaco renders the empty side as a single degenerate
      //    line, and paints its status down the full height of the 42px
      //    original column. On a deleted file that column is red and correct;
      //    on an ADDED one it is also red, running the whole height of a file
      //    that deletes nothing. Raising the gutter amplifies that false signal
      //    faster than it helps the modified files it was meant for, which are
      //    already carried by the line wash. So it stays at 0x26.
      //
      // Be blunt about the size of this: the added line goes from 1.11:1 to
      // 1.20:1. That is small, and it is the ceiling — a diff tint simply IS a
      // low-contrast signal, and GitHub dark's own added line is 1.20:1 too.
      // What makes a change legible is redundancy: this wash, the stronger
      // gutter, and the +/- glyph renderIndicators draws. Two dead ends worth
      // not re-walking: more alpha here fails AA, and no alpha makes added and
      // removed distinguishable in greyscale (green and red at equal alpha land
      // at the same luminance — 1.03:1 apart at 8%, still only 1.13:1 at 28%),
      // so the glyph is the non-colour carrier and has to stay.
      //
      // The one lever that would genuinely open headroom is lightening
      // `comment`. That changes how the theme reads and belongs in its own
      // commit with its own argument, not smuggled in under a diff-tint fix.
      'diffEditor.insertedTextBackground': '#3fb95010',
      'diffEditor.removedTextBackground': '#f8514910',
      'diffEditor.insertedLineBackground': DIFF_INSERTED_LINE,
      'diffEditor.removedLineBackground': DIFF_REMOVED_LINE,

      'diffEditorGutter.insertedLineBackground': '#3fb95026',
      'diffEditorGutter.removedLineBackground': '#f8514926',
      'diffEditorOverview.insertedForeground': '#3fb950',
      'diffEditorOverview.removedForeground': '#f85149',
      'diffEditor.diagonalFill': '#30363d',

      // unchangedRegionBackground has no literal default: it is registered as
      // an alias of `sideBar.background` (editorColors.js:88), a workbench
      // colour standalone Monaco never registers at all. Left unset it
      // resolves to nothing and the collapsed-region bars render unstyled.
      // Set here before hideUnchangedRegions is switched on, so that commit
      // has nothing to fix.
      'diffEditor.unchangedRegionBackground': '#161b22',
      'diffEditor.unchangedRegionForeground': '#8b949e',
      'diffEditor.unchangedCodeBackground': '#0d111700'
    }
  });

  monaco.editor.setTheme(THEME_ID);

  // Published so index.html can paint Monaco's alignment spacer with the same
  // wash as the lines it sits beside. Written from here rather than declared in
  // the stylesheet so the value exists once: a spacer tinted a shade off the
  // block it belongs to is worse than one left alone, and nothing would catch
  // the two drifting apart.
  const root = document.documentElement.style;
  root.setProperty('--ccd-peek-surface', PEEK_SURFACE);
  root.setProperty('--ccd-diff-inserted-line', DIFF_INSERTED_LINE);
  root.setProperty('--ccd-diff-removed-line', DIFF_REMOVED_LINE);
}
