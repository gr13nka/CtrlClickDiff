// CtrlClickDiff backend — Fastify app entrypoint.
//
// Milestone 2: replaces the M0 placeholder with the real git-backed endpoints
// (`/api/commits`, `/api/commit/:sha/files`, `/api/file`). Milestone 3 adds
// `/api/def` + `/api/index` backed by `TreeSitterResolver`.
//
// This backend serves exactly ONE git repository, whose path comes from
// REPO_ROOT (see git.ts's getRepoRoot — throws a clear error if unset). All
// routes are namespaced under /api so the frontend's Vite dev server can proxy
// /api -> http://127.0.0.1:5178 (see packages/frontend/vite.config.ts) while
// leaving room for non-API routes (e.g. serving the built frontend) later.

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { ChangedFile, CommitFiles, CommitInfo, DefLocation } from '@ctrlclickdiff/shared';
import { changedKtFiles, getRepoRoot, resolveBaseSha, resolveSha, showFile, listCommits } from './git';
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

app.get('/health', async () => {
  return { ok: true };
});

// GET /api/commits -> CommitInfo[]
app.get('/api/commits', async (): Promise<CommitInfo[]> => {
  return listCommits();
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
      headSha = await resolveSha(sha);
    } catch {
      reply.code(404);
      return { error: `commit not found: ${sha}` };
    }

    const [files, baseSha]: [ChangedFile[], string] = await Promise.all([
      changedKtFiles(headSha),
      resolveBaseSha(headSha),
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
    const content = await showFile(rev, path);
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
    return resolver.resolve({ name, file, line, lang });
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
    return { ok: true, count: resolver.indexedCount(rev) };
  },
);

const port = Number(process.env.PORT ?? 5178);
const host = '127.0.0.1';

try {
  // Read (and validate) REPO_ROOT before binding a port — fail fast and loud
  // if it's unset rather than 500ing on the first request.
  const repoRoot = getRepoRoot();
  app.log.info(`REPO_ROOT: ${repoRoot}`);

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
