// storage.ts — localStorage that cannot take the app down.
//
// The guard below was written out four times before this module existed (twice
// verbatim in diff.ts and commitpalette.ts, twice more with parsing on top in
// the resizer and the repo picker), in four slightly different wordings. The
// reason for it is the same everywhere, and it is not the obvious one:
//
//   In some privacy modes the *property access itself* throws a SecurityError —
//   not `getItem`, the `localStorage` reference. So the access has to be INSIDE
//   the try, and a module-level read would take the whole app down before it
//   drew anything.
//
// Everything stored through here is a convenience: a view mode, a sidebar
// width, a list of recent repos. None of it ever gets to be the reason the app
// fails to start, so an unreadable or unwritable store degrades to "no value"
// rather than to an exception.
//
// Deliberately three string functions and no more. No readNumber, no
// readJson<T>(key, guard): each would have exactly one caller, and each would
// drag that caller's decision into everybody's module — the resizer's
// blank-string guard exists so corrupt storage falls back to the *stylesheet*
// default rather than to 220px, and the recents validator exists because an
// older shape of this app may have written that key. Those are facts about the
// resizer and about recents, not about storage. Callers keep their own parsing
// and put it on top of this.
//
// Keys live at their call sites too, next to the value they name and the
// comment explaining its default. This module knows none of them.

/** The stored string, or null if absent — or if storage cannot be read at all. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value`, or silently does not when storage is blocked or full. */
export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked or full storage: the value just won't survive the reload */
  }
}

/** Forgets `key`, restoring whatever default the caller falls back to. */
export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* see above */
  }
}
