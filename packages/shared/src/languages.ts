// The language registry: which file extensions this tool reviews, and what
// each one is called.
//
// It exists to eliminate duplication, not to anticipate a future. Before it,
// the same fact was spelled out thirteen times across three packages and in
// four different *kinds* — `'.kt'` as a suffix test in git.ts, `'*.kt'` as a
// git pathspec, `'kotlin'` as a Monaco language id in three files, `'kotlin'`
// as an HTTP enum in the /api/def schema. Sites that agree only by convention
// and would fail **silently at runtime** if one drifted are the same hazard
// class as splitting modelUri/parseModelUri across two files.
//
// Deliberately ONE entry. Adding a language is a row here plus a grammar in
// the backend's grammars.ts; that is the seam, and shipping a second grammar is
// the trigger to revisit whatever this file assumes.
//
// Filesystem paths live in packages/backend/src/resolver/grammars.ts, keyed by
// the ids below, because this module is imported by the browser.

export interface Language {
  /**
   * Registry key — and Monaco's language id.
   *
   * The identity is the point, not a coincidence: it is what makes
   * `registerDefinitionProvider(lang.id)` and `createModel(src, lang.id, uri)`
   * the same string by construction rather than by two files agreeing. A
   * language whose Monaco id differs from its registry key is when this splits
   * into two fields, and not before.
   */
  readonly id: string;
  /** Extensions this language claims, leading dot included, matched as a path suffix. */
  readonly extensions: readonly string[];
}

/** Every language this tool reviews. One entry, on purpose — see the file header. */
export const LANGUAGES: readonly Language[] = [{ id: 'kotlin', extensions: ['.kt'] }];

/** Every extension any registered language claims, in registry order. */
export const SOURCE_EXTENSIONS: readonly string[] = LANGUAGES.flatMap((lang) => lang.extensions);

/**
 * The language whose extension `path` ends with, or undefined for anything
 * else — a path no registered language claims is not an error, it is a file
 * this tool has nothing to say about.
 */
export function languageForPath(path: string): Language | undefined {
  return LANGUAGES.find((lang) => lang.extensions.some((ext) => path.endsWith(ext)));
}

/** Whether any registered language claims `path`. */
export function isSourcePath(path: string): boolean {
  return languageForPath(path) !== undefined;
}
