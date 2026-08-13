// deeplink.ts — the review, expressed as a URL, in both directions.
//
// A review is a repository, a ref and a selection of commits. Until this module
// existed none of that was addressable: every bit of it lived in shell.ts's
// module state, so nothing outside the tab could say "open this review" and
// nothing inside it could hand the reader a link back to what they were looking
// at. `tools/ccd-review.mjs` is the first caller of the first half; the address
// bar is the second half's only caller.
//
// Parse and serialize live together, and that is the same rule that keeps
// `modelUri`/`parseModelUri` in diff.ts: they are an inverse pair, and split
// across two files a change to the parameter layout becomes a two-file edit
// whose half-done version fails silently at runtime — a link that opens the
// wrong review, or none — and never at typecheck.
//
// WHAT THIS MODULE DOES NOT DO: validate the shape of `ref` or `shas`. The
// patterns that decide what a refname and a SHA list look like are
// `REF_PATTERN` and `SHA_LIST_PATTERN` in the backend's server.ts, which is the
// single owner of that rule; a second copy here would be one more pair of
// literals free to drift apart. A malformed value is carried through untouched
// and rejected by the route that owns it — a bad `ref` is a 400 from
// /api/commits, a bad `shas` a 400 from /api/preview, a well-formed but unknown
// SHA a 404 — each landing in the error path shell.ts already has for it. That
// is why a deep link needs no second failure story of its own.

/** A review named by a URL. `null` from `parseDeepLink` means there is no link. */
export interface DeepLinkRequest {
  /**
   * Absolute path of the repository, to be registered via POST /api/repos.
   *
   * The path and not the registry id, because the registry is in memory: a
   * backend restart empties it, and the ids it hands out afterwards are derived
   * from paths anyway. A link built around an id would rot at the next restart;
   * one built around a path re-derives the same id every time.
   */
  repoPath: string;
  /** Full refname as the URL gave it (`refs/heads/x`), or null if absent. */
  ref: string | null;
  /** SHAs as the URL gave them, in URL order, or null if absent. */
  shas: string[] | null;
}

/** The review a URL should currently describe. */
export interface ReviewState {
  /** Absolute repository path, or '' before a repository has been adopted. */
  repoPath: string;
  ref: string;
  shas: string[];
}

const PATH_PARAM = 'path';
const REF_PARAM = 'ref';
const SHAS_PARAM = 'shas';

/**
 * Reads a review out of `location.search`.
 *
 * `path` is the whole decision: without it there is nothing to open, and the
 * answer is null — the same answer as for a plain `/` with no query at all,
 * which is what lets the caller treat "no link" as one case rather than two.
 * A link may name only the repository, leaving the branch and the selection to
 * the ordinary defaults.
 *
 * `URLSearchParams` on the way in but not on the way out, which is asymmetric
 * on purpose: reading, its one quirk — decoding `+` as a space — cannot bite,
 * because every producer of these links percent-encodes (`encodeURIComponent`
 * turns `+` into `%2B`), so no `+` ever reaches it unescaped. Writing, that
 * same quirk would corrupt a path, which is why the serializer below builds the
 * query by hand.
 */
export function parseDeepLink(search: string): DeepLinkRequest | null {
  const params = new URLSearchParams(search);
  const repoPath = params.get(PATH_PARAM);
  if (!repoPath) return null;

  const shas = params.get(SHAS_PARAM)?.split(',').filter(Boolean);
  return {
    repoPath,
    ref: params.get(REF_PARAM) || null,
    shas: shas?.length ? shas : null,
  };
}

/**
 * Points the address bar at `state`, so the URL always names what is on screen.
 *
 * `replaceState`, never `pushState`: this URL mirrors state, it is not a
 * navigation the Back button should undo. On push, Back would rewind the
 * reader's own selection history instead of leaving the page.
 *
 * NO-OP WHEN `repoPath` IS EMPTY, and that guard is load-bearing rather than
 * defensive. shell.ts calls renderTrail() — the funnel this hangs off —
 * synchronously from initShell(), BEFORE boot() has run, when no repository has
 * been adopted yet. An unconditional write there would overwrite the incoming
 * link with an empty URL in the same tick, before boot() ever got to read it:
 * the feature would destroy its own input. Since `repo` stays null until
 * adoptRepo(), every call that could clobber a link is by construction one with
 * an empty path. It is also simply true that a review with no repository is not
 * worth linking to.
 */
export function updateAddressBar(state: ReviewState): void {
  if (!state.repoPath) return;

  const parts = [`${PATH_PARAM}=${encodeURIComponent(state.repoPath)}`];
  if (state.ref) parts.push(`${REF_PARAM}=${encodeURIComponent(state.ref)}`);
  if (state.shas.length > 0) parts.push(`${SHAS_PARAM}=${encodeURIComponent(state.shas.join(','))}`);

  // Built by hand rather than with URLSearchParams for the reason api.ts builds
  // its query strings the same way: URLSearchParams encodes a space as `+`,
  // which is right for a form body and wrong for a filesystem path.
  window.history.replaceState(null, '', `${window.location.pathname}?${parts.join('&')}`);
}
