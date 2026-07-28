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
    // Both required by the typings, not optional. Empty `rules` means "keep
    // vs-dark's token colours"; only the workbench colours below are ours.
    rules: [],
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

      // The four diff backgrounds MUST stay translucent (8-digit hex). Monaco
      // registers them with the needsTransparency flag — the trailing `true`
      // argument at vs/platform/theme/common/colors/editorColors.js:76-79,
      // whose own description reads "The color must not be opaque so as not to
      // hide underlying decorations." An opaque tint here would paint over the
      // selection and search highlights inside a changed line.
      //
      // Lines are tinted more weakly (14 ~ 8%) than intra-line word diffs
      // (26 ~ 15%), which is how GitHub reads: a whole-line wash, with the
      // tokens that actually changed picked out on top of it.
      'diffEditor.insertedTextBackground': '#3fb95026',
      'diffEditor.removedTextBackground': '#f8514926',
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
