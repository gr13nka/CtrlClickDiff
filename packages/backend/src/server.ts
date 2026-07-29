// CtrlClickDiff backend — Fastify app entrypoint.
//
// Milestone 2: replaces the M0 placeholder with the real git-backed endpoints
// (`/api/commits`, `/api/commit/:sha/files`, `/api/file`). Milestone 3 adds
// `/api/def` + `/api/index` backed by `TreeSitterResolver`.
//
// This backend serves any git repository registered through `/api/repos`, which
// only accepts repositories under the browse root (see repos.ts). REPO_ROOT is
// optional: when set it is auto-registered at boot and becomes the default repo.
// All routes are namespaced under /api so the frontend's Vite dev server can
// proxy /api -> http://127.0.0.1:5178 (see packages/frontend/vite.config.ts)
// while leaving room for non-API routes (e.g. serving the built frontend) later.

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type {
  BranchInfo,
  BrowseListing,
  CommitInfo,
  DefLocation,
  Preview,
  RepoEntry,
  ReposListing,
} from '@ctrlclickdiff/shared';
import { BrowsePathError, browseDirectory } from './browse';
import { listBranches, showFile, listCommits } from './git';
import { buildPreview } from './preview';
import { InvalidRepoPathError, RepoRegistry, resolveBrowseRoot } from './repos';
import { TreeSitterResolver } from './resolver/TreeSitterResolver';
import { subscribe } from './watch';

const here = dirname(fileURLToPath(import.meta.url));
// Same fixed locations as smoke.ts's REPO_ROOT-relative resolution.
const KOTLIN_WASM_PATH = resolvePath(here, '../../../vendor/tree-sitter-kotlin.wasm');
const TAGS_SCM_PATH = resolvePath(here, 'resolver/tags.scm');

const app = Fastify({
  logger: true,
});

// Milestone 3: one TreeSitterResolver for the process lifetime, init()'d
// once at boot (below) before the app starts accepting requests.
const resolver = new TreeSitterResolver();

// Resolved here, ahead of the Fastify logger's own boot block, because every
// repo route closes over the registry and so needs it at declaration time. A
// failure is an unusable CCD_BROWSE_ROOT — a boot misconfiguration that must
// abort the process, which an unhandled top-level rejection duly does.
const browseRoot = await resolveBrowseRoot();
const repos = new RepoRegistry(browseRoot);

app.get('/health', async () => {
  return { ok: true };
});

// POST /api/repos {path} -> RepoEntry — register a repository under the browse
// root, or return the entry an already-known path maps to. Idempotent: ids are
// derived from the path, so re-posting is free and always yields the same id.
app.post<{ Body: { path: string } }>(
  '/api/repos',
  {
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  async (request, reply): Promise<RepoEntry | { error: string }> => {
    try {
      return await repos.register(request.body.path);
    } catch (err) {
      // Only a rejected *path* is the caller's fault. Anything else (a git
      // binary that vanished, an I/O fault) is ours — rethrow it so Fastify
      // reports a 500 instead of blaming the client for a server problem.
      if (!(err instanceof InvalidRepoPathError)) throw err;
      reply.code(400);
      return { error: err.message };
    }
  },
);

// GET /api/repos -> everything the frontend needs to populate a repo picker:
// what is registered, which one to preselect, and where browsing may start.
//
// Annotated, like every other route here: the return type is what makes tsc
// check this object literal against the shape api.ts parses it back into. An
// unannotated handler is structurally whatever it happens to return, so a
// renamed field would compile on both sides and only fail in the browser.
app.get('/api/repos', async (): Promise<ReposListing> => {
  return { repos: repos.list(), defaultRepoId: repos.defaultRepoId, browseRoot };
});

// GET /api/browse?path=<abs> -> subdirectories of `path` (default: the browse
// root), so the user can find a checkout to POST to /api/repos. Directory names
// only — see browse.ts for what this deliberately does not return.
app.get<{ Querystring: { path?: string } }>(
  '/api/browse',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
    },
  },
  async (request, reply): Promise<BrowseListing | { error: string }> => {
    try {
      return await browseDirectory(browseRoot, request.query.path);
    } catch (err) {
      if (!(err instanceof BrowsePathError)) throw err;
      reply.code(400);
      return { error: err.message };
    }
  },
);

/**
 * `?repo=` is OPTIONAL on every data route, falling back to the REPO_ROOT repo.
 * That is what lets this change ship on its own: existing callers (and the
 * current frontend) keep working untouched, and the frontend can start sending
 * a repo id whenever it is ready, in its own commit.
 */
const REPO_QUERY_PROPERTY = { repo: { type: 'string', minLength: 1 } } as const;

type RepoRootResult =
  | { ok: true; root: string }
  | { ok: false; status: number; body: { error: string } };

/**
 * Map a request's optional `repo` id to the repository root git should run in.
 *
 * An unknown id answers **409, not 404**, and the difference carries the whole
 * restart-recovery design. The registry lives in memory, so a backend restart
 * silently empties it while the frontend still holds ids that were valid a
 * moment ago. 404 would read as "no such repository, give up"; 409 says the
 * client's view of server state conflicts with the server's, which is exactly
 * true and is actionable — the frontend re-registers its repo via
 * POST /api/repos (idempotent, same id back) and retries the request once. That
 * single status code is the entire recovery story; nothing else needs to know a
 * restart happened.
 */
function repoRootFor(repo: string | undefined): RepoRootResult {
  if (repo !== undefined) {
    const root = repos.resolveRoot(repo);
    if (root === undefined) return { ok: false, status: 409, body: { error: 'repo_not_registered' } };
    return { ok: true, root };
  }

  const fallback = repos.defaultRoot();
  if (fallback === undefined) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          'no repo specified and no default repo is configured. Pass ?repo=<id> ' +
          'from GET /api/repos, or start the backend with REPO_ROOT set.',
      },
    };
  }
  return { ok: true, root: fallback };
}

// GET /api/branches?repo=<id> -> BranchInfo[] (local + remote-tracking)
app.get<{ Querystring: { repo?: string } }>(
  '/api/branches',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: { ...REPO_QUERY_PROPERTY },
      },
    },
  },
  async (request, reply): Promise<BranchInfo[] | { error: string }> => {
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      reply.code(root.status);
      return root.body;
    }
    return listBranches(root.root);
  },
);

/**
 * Exactly the shapes `GET /api/branches` emits: `HEAD` (the synthetic
 * detached-HEAD entry) or a full refname under `refs/heads` / `refs/remotes`.
 *
 * A whitelist, not a blacklist, and applied before the value reaches git's argv.
 * It happens to exclude a leading `-`, which is the case that matters most (an
 * argument like `--output=/tmp/x` would otherwise be an *option* to `git log`,
 * not a revision), but the point is that nothing outside this shape gets through
 * at all. `git.ts` re-checks and additionally brackets the rev with
 * `--end-of-options` / `--`; see the comment on `listCommits`.
 */
const REF_PATTERN = '^(HEAD|refs/(heads|remotes)/[^ ]+)$';

// GET /api/commits?repo=<id>&ref=<refname> -> CommitInfo[]
//
// `ref` is optional and defaults to HEAD, so callers that predate branch
// selection — including the current frontend — keep working unchanged.
app.get<{ Querystring: { repo?: string; ref?: string } }>(
  '/api/commits',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          ref: { type: 'string', pattern: REF_PATTERN },
          ...REPO_QUERY_PROPERTY,
        },
      },
    },
  },
  async (request, reply): Promise<CommitInfo[] | { error: string }> => {
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      reply.code(root.status);
      return root.body;
    }
    return listCommits(root.root, request.query.ref);
  },
);

/**
 * A comma-separated list of full 40-char SHAs, lowercase — exactly what
 * `GET /api/commits` hands out, and nothing else.
 *
 * A whitelist applied before the value reaches git's argv, on the same rule as
 * REF_PATTERN: full SHAs are the only shape the frontend ever has, so accepting
 * abbreviations or refs here would widen the surface for no caller's benefit.
 * It also excludes a leading `-`, which is the case that matters — an argument
 * like `--output=/tmp/x` reaching `git log` would be an *option*, not a
 * revision. `buildPreview` additionally brackets the revs with
 * `--end-of-options` / `--`; see the comment on `listCommits`.
 */
const SHA_LIST_PATTERN = '^[0-9a-f]{40}(,[0-9a-f]{40})*$';

// The same ceiling `listCommits` puts on the log: a selection cannot name a
// commit the picker never listed, so anything longer is not a real request.
const MAX_SELECTED_COMMITS = 100;

// GET /api/preview?repo=<id>&shas=<sha>,<sha>,... -> Preview
//
// The changed files of a *selection* of commits, each with the revision pair
// its diff should be computed at. One selected commit is the ordinary
// single-commit review, which is why there is no per-commit route beside this
// one. See the doc on `buildPreview` for what a selection means when the
// commits are not adjacent.
app.get<{ Querystring: { shas: string; repo?: string } }>(
  '/api/preview',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['shas'],
        properties: {
          shas: { type: 'string', pattern: SHA_LIST_PATTERN },
          ...REPO_QUERY_PROPERTY,
        },
      },
    },
  },
  async (request, reply): Promise<Preview | { error: string }> => {
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      reply.code(root.status);
      return root.body;
    }

    const shas = request.query.shas.split(',');
    if (shas.length > MAX_SELECTED_COMMITS) {
      reply.code(400);
      return { error: `too many commits selected: ${shas.length} > ${MAX_SELECTED_COMMITS}` };
    }

    try {
      return await buildPreview(root.root, shas);
    } catch (err) {
      // A selection naming a commit this repository does not have is the
      // caller's mistake, not a server fault — most often a stale tab after a
      // force-push. 404 rather than a bare 500 from a rejected git process.
      request.log.warn({ err }, 'preview failed');
      reply.code(404);
      return { error: `commit not found in this repository: ${request.query.shas}` };
    }
  },
);

// GET /api/file?rev=<sha>&path=<p>&repo=<id> -> text/plain (source, or '' if absent at rev)
app.get<{ Querystring: { rev: string; path: string; repo?: string } }>(
  '/api/file',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['rev', 'path'],
        properties: {
          rev: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
          ...REPO_QUERY_PROPERTY,
        },
      },
    },
  },
  async (request, reply) => {
    const { rev, path } = request.query;
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      // Left as JSON (reply.type below is never reached) so an error here is
      // machine-readable like every other route's, not a text/plain surprise.
      reply.code(root.status);
      return root.body;
    }
    const content = await showFile(root.root, rev, path);
    reply.type('text/plain; charset=utf-8');
    return content;
  },
);

// GET /api/def?name=&file=&line=&lang=kotlin&rev=<sha> -> DefLocation[]
//
// buildIndex is cached per-rev (no-op + no re-parse if `rev` was already
// indexed by a prior /api/def or /api/index call), so this is cheap on the
// second-and-later Ctrl+click for a given commit.
app.get<{
  Querystring: { name: string; file: string; line: number; lang: 'kotlin'; rev: string; repo?: string };
}>(
  '/api/def',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['name', 'file', 'line', 'lang', 'rev'],
        properties: {
          name: { type: 'string', minLength: 1 },
          file: { type: 'string', minLength: 1 },
          line: { type: 'integer', minimum: 1 },
          lang: { type: 'string', enum: ['kotlin'] },
          rev: { type: 'string', minLength: 1 },
          ...REPO_QUERY_PROPERTY,
        },
      },
    },
  },
  async (request, reply): Promise<DefLocation[] | { error: string }> => {
    const { name, file, line, lang, rev } = request.query;
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      reply.code(root.status);
      return root.body;
    }
    await resolver.buildIndex(root.root, rev);
    return resolver.resolve(root.root, rev, { name, file, line, lang });
  },
);

// POST /api/index?rev=<sha> -> { ok, count } — prewarm the index for a
// revision ahead of time (used by the M4 shell on commit-select) so the
// first /api/def for that rev doesn't pay the parse cost inline.
app.post<{ Querystring: { rev: string; repo?: string } }>(
  '/api/index',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['rev'],
        properties: {
          rev: { type: 'string', minLength: 1 },
          ...REPO_QUERY_PROPERTY,
        },
      },
    },
  },
  async (request, reply): Promise<{ ok: true; count: number } | { error: string }> => {
    const { rev } = request.query;
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      reply.code(root.status);
      return root.body;
    }
    await resolver.buildIndex(root.root, rev);
    return { ok: true, count: resolver.indexedCount(root.root, rev) };
  },
);

/**
 * A `ping` event every 15s. Two jobs, and the second is why it is a named event
 * rather than the `: ping` comment it started as.
 *
 * Keeping proxies and NAT tables from reaping a connection that is idle by
 * design (a repository nobody is committing to sends nothing for hours) is the
 * obvious one, and a comment would do.
 *
 * The other is liveness, and a comment cannot do it: EventSource never surfaces
 * comment lines to script, so a client has nothing to time out against. That
 * matters because Vite's dev proxy does NOT propagate upstream death — measured,
 * a stream read straight from this server errors ~2.5s after the process dies,
 * while the same stream through the proxy stays open with a dead upstream for
 * over 20s with no error event at all. A named event gives the client a
 * heartbeat it can actually observe, so live.ts can notice the silence and
 * reopen. 15s is three chances inside its 45s watchdog.
 */
const SSE_HEARTBEAT_MS = 15_000;

// GET /api/watch?repo=<id> -> text/event-stream
//
// Emits `event: refs` with `{headSha}` whenever the repository's refs or HEAD
// change (see watch.ts for what does *not* count as a change). The alternative
// was the frontend polling /api/commits on a timer, which costs a `git log` per
// tab per interval and is still late by up to that interval.
app.get<{ Querystring: { repo?: string } }>(
  '/api/watch',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: { ...REPO_QUERY_PROPERTY },
      },
    },
  },
  async (request, reply) => {
    const root = repoRootFor(request.query.repo);
    if (!root.ok) {
      // Still a normal JSON reply — the stream only begins once the repo is known.
      reply.code(root.status);
      return root.body;
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx and friends not to buffer; a buffered event stream arrives
      // in one lump when the connection ends, which is the same as not working.
      'x-accel-buffering': 'no',
    });
    // Fastify must not try to send a reply of its own for the rest of this
    // request's life — from here the raw socket is ours.
    reply.hijack();
    // `retry:` sets the browser's EventSource reconnect delay, so a backend
    // restart is recovered from in ~3s rather than the UA's default. The comment
    // line flushes headers immediately, which is what makes a client (and a dev
    // proxy) prove the stream is live before anything has happened in the repo.
    reply.raw.write('retry: 3000\n\n: connected\n\n');

    const send = (chunk: string): void => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(chunk);
    };

    const unsubscribe = subscribe(root.root, (headSha) => {
      send(`event: refs\ndata: ${JSON.stringify({ headSha })}\n\n`);
    });
    const heartbeat = setInterval(() => send('event: ping\ndata: {}\n\n'), SSE_HEARTBEAT_MS);
    heartbeat.unref();

    // 'close' fires for every ending — tab closed, network dropped, server
    // shutting down — so both the interval and the repo watch are released on
    // all of them. Without this the refcount in watch.ts never reaches zero and
    // the inotify watches leak for the life of the process.
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  },
);

const port = Number(process.env.PORT ?? 5178);
const host = '127.0.0.1';

try {
  app.log.info(`browse root: ${browseRoot}`);

  // REPO_ROOT is now optional — without it the backend starts empty and waits
  // for the frontend to register repos through POST /api/repos. Set but invalid
  // is still fatal, though: that is a typo, not a deliberate choice, and
  // limping on would only surface the mistake as a confusing per-request error.
  if (process.env.REPO_ROOT) {
    const boot = await repos.registerBootRepo(process.env.REPO_ROOT);
    app.log.info(`REPO_ROOT: ${boot.path} (default repo ${boot.id})`);
  } else {
    app.log.info('REPO_ROOT unset — no default repo; register one via POST /api/repos');
  }

  // init() loads the Kotlin WASM grammar + compiles tags.scm once; must
  // finish before any /api/def or /api/index request can be served.
  const tagsScmSource = await readFile(TAGS_SCM_PATH, 'utf8');
  await resolver.init(KOTLIN_WASM_PATH, tagsScmSource);
  app.log.info('TreeSitterResolver initialized');

  const address = await app.listen({ port, host });
  app.log.info(`CtrlClickDiff backend listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
