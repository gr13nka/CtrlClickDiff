// Repo ref watcher — notifies subscribers when a repository's refs or HEAD
// actually change, so `GET /api/watch` can push instead of the frontend polling.
//
// "Actually change" is the hard part. A repository's `.git` directory is written
// constantly by operations that change nothing a reviewer would see (index
// refreshes, lock files, `git gc`), so the filesystem events are only a *hint*
// that something might have happened. Every event is funnelled through a
// debounce and then a change token; only a token that differs from the last one
// reaches a subscriber.

import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir, listBranches, resolveSha } from './git';

/**
 * Called with the repository's new HEAD sha. The sha is handed over rather than
 * re-read by the subscriber because the watcher has just computed it to decide
 * an event was worth sending — re-reading would be a second `rev-parse` and
 * could observe a *different* HEAD than the one that triggered the event.
 * A plain `() => void` callback satisfies this type.
 */
export type RefsListener = (headSha: string) => void;

/**
 * Long enough to coalesce the burst of writes a single git command produces
 * (a commit touches the index, a ref, the reflog and ORIG_HEAD), short enough
 * that the UI still feels immediate.
 */
const DEBOUNCE_MS = 200;

interface RepoWatch {
  listeners: Set<RefsListener>;
  watchers: FSWatcher[];
  timer: NodeJS.Timeout | null;
  /** Last token emitted (or read at startup); '' until the baseline is read. */
  token: string;
  /** Set once torn down, so in-flight async work stops instead of resurrecting it. */
  stopped: boolean;
}

/** One watch per repository root, shared by every subscriber of that repo. */
const watches = new Map<string, RepoWatch>();

/**
 * Watch `repoRoot` for ref changes, calling `cb` when one is observed.
 * Returns an unsubscribe function; when the last subscriber for a repository
 * unsubscribes, its filesystem watchers are closed and the entry is dropped.
 * Unsubscribing twice is a no-op.
 *
 * Subscribing is refcounted rather than per-connection because several browser
 * tabs on the same repository are the normal case, and each `fs.watch` costs a
 * real inotify allocation.
 */
export function subscribe(repoRoot: string, cb: RefsListener): () => void {
  let entry = watches.get(repoRoot);
  if (!entry) {
    entry = { listeners: new Set(), watchers: [], timer: null, token: '', stopped: false };
    watches.set(repoRoot, entry);
    void start(repoRoot, entry);
  }
  const w = entry;
  w.listeners.add(cb);

  return () => {
    if (!w.listeners.delete(cb)) return;
    if (w.listeners.size === 0) stop(repoRoot, w);
  };
}

/**
 * TWO NARROW WATCHERS, NOT ONE RECURSIVE WATCH OF `.git` — please do not
 * "simplify" this into `watch(gitCommonDir, { recursive: true })`.
 *
 * On Linux a recursive watch is implemented as one inotify watch per
 * subdirectory, and `.git/objects/` alone has 256 fanout directories before any
 * pack or worktree state is counted. A recursive watch of `.git` on a large
 * repository therefore burns thousands of inotify watches (a per-user limit
 * that other tools share) and delivers a continuous stream of events every time
 * `git gc` or a fetch writes objects — none of which can change a ref.
 *
 * What actually matters lives in exactly two places:
 *   - files directly inside the common dir: `HEAD`, `packed-refs`, `ORIG_HEAD`;
 *   - anything under `refs/`, which is genuinely a tree (`refs/heads/a/b`), so
 *     that one does need `recursive`. It is small and only written when a ref
 *     moves.
 */
async function start(repoRoot: string, w: RepoWatch): Promise<void> {
  try {
    const commonDir = await gitCommonDir(repoRoot);
    // Baseline: read the token *before* watching, so the first event compares
    // against the state at subscription time rather than reporting a change.
    w.token = (await readState(repoRoot)).token;
    if (w.stopped) return;

    const onEvent = () => schedule(repoRoot, w);
    w.watchers.push(watch(commonDir, onEvent));
    try {
      w.watchers.push(watch(join(commonDir, 'refs'), { recursive: true }, onEvent));
    } catch {
      // `fs.watch` throws synchronously if `refs/` is missing or unreadable at
      // this instant. A valid repository always has the directory, so this is a
      // race guard rather than an expected state — but degrading is strictly
      // better than failing the subscription, because the common-dir watcher
      // alone still sees `packed-refs` and `HEAD`, and every operation that
      // moves a ref writes at least one of those or the index.
    }
  } catch {
    // The repository became unreadable between registration and now. Drop the
    // entry so a later subscribe retries from scratch rather than attaching to
    // a watch that will never fire.
    stop(repoRoot, w);
  }
}

/**
 * Coalesce a burst into one check, DEBOUNCE_MS after its first event. This form
 * (ignore further events while a timer is pending) rather than the
 * restart-the-timer form: under sustained churn — a long fetch — restarting
 * would postpone the check indefinitely, whereas this bounds the delay to one
 * window and simply runs again for whatever follows.
 *
 * `unref()` so a pending check never keeps the process alive on shutdown.
 */
function schedule(repoRoot: string, w: RepoWatch): void {
  if (w.timer !== null || w.stopped) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    void fire(repoRoot, w);
  }, DEBOUNCE_MS);
  w.timer.unref();
}

async function fire(repoRoot: string, w: RepoWatch): Promise<void> {
  if (w.stopped) return;

  let state: RepoState;
  try {
    state = await readState(repoRoot);
  } catch {
    // Mid-operation (a rebase between refs, an unborn HEAD). Say nothing; the
    // write that finishes the operation produces another event.
    return;
  }

  if (w.stopped || state.token === w.token) return;
  w.token = state.token;
  for (const cb of [...w.listeners]) cb(state.headSha);
}

function stop(repoRoot: string, w: RepoWatch): void {
  w.stopped = true;
  if (w.timer !== null) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  for (const watcher of w.watchers) watcher.close();
  w.watchers.length = 0;
  // Only if this is still the live entry: a failed start() may already have
  // dropped it and a later subscribe may have installed a replacement.
  if (watches.get(repoRoot) === w) watches.delete(repoRoot);
}

interface RepoState {
  headSha: string;
  token: string;
}

/**
 * The repository's ref state reduced to one comparable string.
 *
 * This is what separates a real change from `.git` noise: `touch .git/index`,
 * a lock file appearing and vanishing, or `git status` refreshing the index all
 * produce filesystem events but leave HEAD and every ref exactly where they
 * were, so the token is unchanged and nothing is emitted. Committing, checking
 * out, fetching, resetting — all move a ref or HEAD, and all change it.
 *
 * HEAD is included alongside the refs because `git checkout --detach <sha>`
 * moves no ref at all, yet it is precisely a change of what is being reviewed.
 */
async function readState(repoRoot: string): Promise<RepoState> {
  const [headSha, branches] = await Promise.all([
    resolveSha(repoRoot, 'HEAD'),
    listBranches(repoRoot),
  ]);
  const hash = createHash('sha256').update(headSha);
  for (const b of branches) hash.update(` ${b.ref} ${b.tipSha} ${b.isHead}`);
  return { headSha, token: hash.digest('hex') };
}
