// The app's Monaco theme, matching index.html's --ccd-* palette (GitHub
// Primer dark). Until this file existed nothing called setTheme or passed a
// `theme` option anywhere, so the diff editor ran Monaco's built-in default —
// `vs`, the LIGHT one — inside dark chrome.

import * as monaco from 'monaco-editor';

const THEME_ID = 'ccd-github-dark';

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
      'peekViewEditor.background': '#0d1117',
      'peekViewResult.background': '#161b22',
      'peekViewTitle.background': '#161b22',

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
      // Lines are tinted more weakly (14 ~ 8%) than intra-line word diffs
      // (1a ~ 10%), which is how GitHub reads: a whole-line wash, with the
      // tokens that actually changed picked out on top of it.
      //
      // The word tint is 10% rather than the 15% that reads best in isolation,
      // because it stacks on top of the line tint and the text has to stay
      // legible through both. At 15% the darkest syntax colour falls to 4.3:1
      // — under WCAG AA; at 10% the worst case is 4.7:1. The gutter keeps the
      // stronger 15%, where nothing is drawn on top of it.
      'diffEditor.insertedTextBackground': '#3fb9501a',
      'diffEditor.removedTextBackground': '#f851491a',
      'diffEditor.insertedLineBackground': '#3fb95014',
      'diffEditor.removedLineBackground': '#f8514914',

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
}
