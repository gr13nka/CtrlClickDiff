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
import type { ChangedFile, CommitFiles, CommitInfo, DefLocation } from '@ctrlclickdiff/shared';
import { changedKtFiles, getRepoRoot, resolveBaseSha, resolveSha, showFile, listCommits } from './git';
import { InvalidRepoPathError, RepoRegistry, resolveBrowseRoot, type RepoEntry } from './repos';
import { TreeSitterResolver } from './resolver/TreeSitterResolver';

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
app.get('/api/repos', async () => {
  return { repos: repos.list(), defaultRepoId: repos.defaultRepoId, browseRoot };
});

// GET /api/commits -> CommitInfo[]
app.get('/api/commits', async (): Promise<CommitInfo[]> => {
  return listCommits(getRepoRoot());
});

// GET /api/commit/:sha/files -> CommitFiles
app.get<{ Params: { sha: string } }>(
  '/api/commit/:sha/files',
  {
    schema: {
      params: {
        type: 'object',
        required: ['sha'],
        properties: {
          sha: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  async (request, reply): Promise<CommitFiles | { error: string }> => {
    const { sha } = request.params;

    // Resolve to a concrete 40-char SHA first (git rev-parse) so headSha is
    // stable regardless of what the caller passed (abbreviated sha, "HEAD",
    // ...) and so the base-sha/changed-files lookups below operate on the
    // same canonical commit. An unresolvable ref (typo, unknown sha) is a
    // client error, not a server fault — surface it as 404 rather than a
    // bare 500 from a rejected git process.
    let headSha: string;
    try {
      headSha = await resolveSha(getRepoRoot(), sha);
    } catch {
      reply.code(404);
      return { error: `commit not found: ${sha}` };
    }

    const [files, baseSha]: [ChangedFile[], string] = await Promise.all([
      changedKtFiles(getRepoRoot(), headSha),
      resolveBaseSha(getRepoRoot(), headSha),
    ]);

    return { headSha, baseSha, files };
  },
);

// GET /api/file?rev=<sha>&path=<p> -> text/plain (source, or '' if absent at rev)
app.get<{ Querystring: { rev: string; path: string } }>(
  '/api/file',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['rev', 'path'],
        properties: {
          rev: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  async (request, reply) => {
    const { rev, path } = request.query;
    const content = await showFile(getRepoRoot(), rev, path);
    reply.type('text/plain; charset=utf-8');
    return content;
  },
);

// GET /api/def?name=&file=&line=&lang=kotlin&rev=<sha> -> DefLocation[]
//
// buildIndex is cached per-rev (no-op + no re-parse if `rev` was already
// indexed by a prior /api/def or /api/index call), so this is cheap on the
// second-and-later Ctrl+click for a given commit.
app.get<{ Querystring: { name: string; file: string; line: number; lang: 'kotlin'; rev: string } }>(
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
        },
      },
    },
  },
  async (request): Promise<DefLocation[]> => {
    const { name, file, line, lang, rev } = request.query;
    await resolver.buildIndex(getRepoRoot(), rev);
    return resolver.resolve(getRepoRoot(), rev, { name, file, line, lang });
  },
);

// POST /api/index?rev=<sha> -> { ok, count } — prewarm the index for a
// revision ahead of time (used by the M4 shell on commit-select) so the
// first /api/def for that rev doesn't pay the parse cost inline.
app.post<{ Querystring: { rev: string } }>(
  '/api/index',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['rev'],
        properties: {
          rev: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  async (request): Promise<{ ok: true; count: number }> => {
    const { rev } = request.query;
    await resolver.buildIndex(getRepoRoot(), rev);
    return { ok: true, count: resolver.indexedCount(getRepoRoot(), rev) };
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
