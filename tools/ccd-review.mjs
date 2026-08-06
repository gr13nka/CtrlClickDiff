#!/usr/bin/env node
// ccd-review.mjs — open a review of what this iteration committed.
//
//   node tools/ccd-review.mjs [--base=<rev>] [--shas=<sha>,...] [--no-open]
//                             [--app=<url>] [--backend=<url>] [--json]
//
// Written for an agent to call as its last act: it turns "the work I just did"
// into a CtrlClickDiff deep link and opens it where the human is looking. Under
// Orca that means a tab in Orca's own embedded browser (`orca tab create`), so
// the review appears beside the worktree it belongs to rather than in some other
// window.
//
// It is a plain CLI and not an MCP server on purpose. Every agent can run a
// shell command; an MCP server would be a second process, a config entry per
// agent, and another thing to be down — in exchange for nothing this one line
// does not already do.
//
// EXIT CODES, because the caller is a program:
//   0  a link was produced (and opened, unless --no-open)
//   1  something is wrong and the caller should say so: no repository, the
//      backend is down, the path is outside the browse root
//   2  nothing to review — the iteration left no commits. Not an error: an
//      agent that only edited the working tree gets this, and it is the honest
//      answer, because both sides of a preview are revisions that already exist
//      and an uncommitted tree is not one.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DEFAULT_APP = 'http://localhost:5173';
const DEFAULT_BACKEND = 'http://127.0.0.1:5178';
// /api/preview enforces the same ceiling (COMMIT_LOG_LIMIT in the backend's
// git.ts): a selection may not name more commits than the picker can list.
const MAX_COMMITS = 100;

const args = parseArgs(process.argv.slice(2));
const app = args.app ?? DEFAULT_APP;
const backend = args.backend ?? DEFAULT_BACKEND;

const repo = await locateRepo();
const { shas, since } = args.shas
  ? { shas: args.shas, since: 'the given --shas' }
  : await iterationCommits(repo);

if (shas.length === 0) {
  fail(
    2,
    `no commits since ${since} in ${repo.path} — nothing to review.\n` +
      'CtrlClickDiff reviews commits; an uncommitted working tree is not something\n' +
      'it can show, because both sides of a diff have to be revisions that exist.',
  );
}

const entry = await registerRepo(repo.path);
const url = deepLink({ app, path: entry.path, ref: repo.ref, shas });

if (args.json) {
  console.log(JSON.stringify({ url, repoId: entry.id, path: entry.path, ref: repo.ref, shas }, null, 2));
} else {
  console.log(url);
}

if (!args.noOpen) await open(url, repo.path);

// ---------------------------------------------------------------------------

/**
 * Where we are: the worktree path and the ref checked out in it.
 *
 * Orca is asked first because it knows its own worktrees by name and answers
 * without guessing, but git alone is enough — the script has to work in an
 * ordinary shell in an ordinary clone too, which is also how it stays testable
 * without Orca running.
 */
async function locateRepo() {
  const fromOrca = await orcaJson(['worktree', 'current', '--json']);
  const worktree = fromOrca?.result?.worktree ?? fromOrca?.result;
  if (worktree?.path && worktree?.branch) {
    return { path: worktree.path, ref: worktree.branch };
  }

  const path = (await git(['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!path) fail(1, `not inside a git repository: ${process.cwd()}`);
  // Full refname, because that is the only form /api/commits accepts and the
  // only one that names exactly one ref: a local branch may be called
  // `origin/main`. A detached HEAD has no symbolic ref and gets no `ref` at all,
  // which the app answers by staying on whatever HEAD points at.
  const ref = (await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  return { path, ref };
}

/**
 * The SHAs this iteration produced, newest-first.
 *
 * The base, in order of preference:
 *
 *   --base                 the caller knows exactly
 *   the session-base file  what HEAD was when this agent session started, left
 *                          by tools/ccd-session-start.sh. The precise answer to
 *                          "what did THIS iteration do", and the only one that
 *                          stays right when a session commits on top of work
 *                          that was already on the branch.
 *   merge-base with the    the branch's own divergence point: right for a fresh
 *   default branch         worktree, wider than one iteration on a long-lived
 *                          branch, and always better than nothing.
 */
async function iterationCommits(repo) {
  const base = args.base ?? (await sessionBase(repo.path)) ?? (await divergedFrom(repo.path));
  const since = base ?? 'the start of history';

  const range = base ? `${base}..HEAD` : 'HEAD';
  const out = await git(['log', '--format=%H', '--end-of-options', range, '--'], repo.path).catch(
    () => '',
  );
  const all = out.split('\n').filter(Boolean);
  if (all.length <= MAX_COMMITS) return { shas: all, since };

  // Said out loud rather than trimmed quietly: a review that silently showed the
  // newest hundred of two hundred commits reads as "here is everything".
  console.error(
    `note: ${all.length} commits since ${since}; reviewing the newest ${MAX_COMMITS}, ` +
      `${all.length - MAX_COMMITS} left out (/api/preview caps a selection there).`,
  );
  return { shas: all.slice(0, MAX_COMMITS), since };
}

/** HEAD as it was when this agent session started, if the hook recorded it. */
async function sessionBase(repoPath) {
  const file = join(homedir(), '.cache', 'ccd', 'session-base', digest(repoPath));
  const sha = await readFile(file, 'utf8').catch(() => '');
  return sha.trim() || null;
}

/** Where this branch left the default branch, or null if that cannot be told. */
async function divergedFrom(repoPath) {
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath).catch(
    () => '',
  );
  const target = head.trim() || 'refs/remotes/origin/main';
  const base = await git(['merge-base', 'HEAD', target], repoPath).catch(() => '');
  return base.trim() || null;
}

/**
 * Registers `path` with the backend and returns its entry.
 *
 * Straight to the backend rather than through the frontend's dev proxy: this is
 * a Node process, so there is no CORS to satisfy, and registering should not
 * require the dev server to be up. The backend's own refusal text is the message
 * — it is written for a human and says which rule was broken.
 */
async function registerRepo(path) {
  let res;
  try {
    res = await fetch(`${backend}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch {
    fail(
      1,
      `the CtrlClickDiff backend is not reachable at ${backend} — start it first (./start.sh).`,
    );
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    fail(1, detail?.error ?? `POST /api/repos failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Built by hand rather than with URLSearchParams, matching deeplink.ts and
 * api.ts: URLSearchParams encodes a space as `+`, which is right for a form
 * body and wrong for a filesystem path.
 */
function deepLink({ app, path, ref, shas }) {
  const parts = [`path=${encodeURIComponent(path)}`];
  if (ref) parts.push(`ref=${encodeURIComponent(ref)}`);
  parts.push(`shas=${encodeURIComponent(shas.join(','))}`);
  return `${app}/?${parts.join('&')}`;
}

/**
 * Puts the review in front of the human: an Orca tab when Orca is running, the
 * desktop browser otherwise.
 *
 * Failing to open is a warning and not an error. The URL is already on stdout,
 * which is the part the caller can act on — an agent that reports the link has
 * done its job even if no window appeared.
 */
async function open(url, worktreePath) {
  const viaOrca = await orcaJson(['tab', 'create', '--url', url, '--worktree', `path:${worktreePath}`]);
  if (viaOrca?.ok) return;

  try {
    await run('xdg-open', [url]);
  } catch {
    console.error(`could not open a browser; the link is above.`);
  }
}

/** `orca ... --json`, or null when Orca is absent, erroring, or not answering JSON. */
async function orcaJson(argv) {
  try {
    const { stdout } = await run('orca', argv.includes('--json') ? argv : [...argv, '--json']);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function git(argv, cwd = process.cwd()) {
  return run('git', argv, { cwd }).then(({ stdout }) => stdout);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function parseArgs(argv) {
  const out = { noOpen: false, json: false };
  for (const arg of argv) {
    if (arg === '--no-open') out.noOpen = true;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--base=')) out.base = arg.slice(7);
    else if (arg.startsWith('--shas=')) out.shas = arg.slice(7).split(',').filter(Boolean);
    else if (arg.startsWith('--app=')) out.app = arg.slice(6).replace(/\/$/, '');
    else if (arg.startsWith('--backend=')) out.backend = arg.slice(10).replace(/\/$/, '');
    else fail(1, `unknown argument: ${arg}`);
  }
  return out;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}
