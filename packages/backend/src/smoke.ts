// Boot smoke test — Milestone 0 "done when" gate.
//
// Why this exists: there is no prebuilt Kotlin WASM grammar, so we build one
// ourselves from fwcd/tree-sitter-kotlin with tree-sitter-cli. The built
// `.wasm` and the `web-tree-sitter` *runtime* that loads it must be the same
// ABI generation (both 0.26.x) — a mismatch makes the grammar fail to load
// **silently** in normal use. This script turns that silent failure into a
// loud one by asserting the language loads AND that the tags.scm query
// actually produces the captures we expect on a trivial sample.
//
// Run via `pnpm --filter backend smoke` (see package.json). Exits 0 on
// success, 1 on any failure (missing prerequisite files, ABI mismatch, or a
// captures mismatch).

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// web-tree-sitter 0.26.x API: named imports, not the old `Parser.Language.load`.
import { Parser, Language, Query } from 'web-tree-sitter';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Repo layout is packages/backend/src/smoke.ts, so the repo root is three
// directories up. Computing these from import.meta.url (rather than
// hardcoding an absolute path) keeps the script correct regardless of where
// the repo is checked out, while still resolving to the exact locations the
// plan specifies:
//   vendor/tree-sitter-kotlin.wasm
//   packages/backend/src/resolver/tags.scm
const REPO_ROOT = resolvePath(here, '../../..');
const KOTLIN_WASM_PATH = resolvePath(REPO_ROOT, 'vendor/tree-sitter-kotlin.wasm');
const TAGS_SCM_PATH = resolvePath(here, 'resolver/tags.scm');

/**
 * Resolve the on-disk path to web-tree-sitter's own runtime WASM
 * (`tree-sitter.wasm` — the generic engine, distinct from the Kotlin
 * grammar). Under plain Node/tsx (no bundler), `Parser.init()`'s default
 * `locateFile` heuristics don't reliably find this relative to cwd, so we
 * resolve it explicitly via Node's module resolver and hand it back through
 * an explicit `locateFile` override. Falls back gracefully — if resolution
 * fails we let `Parser.init()` try its own default behavior rather than
 * hard-failing here (the real failure signal is the Kotlin language load
 * below).
 */
function resolveTreeSitterRuntimeWasm(): string | undefined {
  try {
    // Subpath export — works if web-tree-sitter's package.json "exports"
    // exposes the .wasm file directly.
    return require.resolve('web-tree-sitter/tree-sitter.wasm');
  } catch {
    try {
      // Fall back: find the package's main entry and assume the runtime
      // wasm sits alongside it (true for web-tree-sitter's published layout).
      const pkgEntry = require.resolve('web-tree-sitter');
      const candidate = resolvePath(dirname(pkgEntry), 'tree-sitter.wasm');
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
}

async function main(): Promise<void> {
  console.log('[smoke] initializing web-tree-sitter runtime...');

  const runtimeWasm = resolveTreeSitterRuntimeWasm();
  if (runtimeWasm) {
    console.log(`[smoke] resolved tree-sitter.wasm runtime at: ${runtimeWasm}`);
  } else {
    console.warn(
      '[smoke] could not explicitly resolve web-tree-sitter/tree-sitter.wasm; ' +
        'falling back to the package default locateFile behavior',
    );
  }

  await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

  // The Kotlin WASM and tags.scm are produced by a parallel build step
  // (Milestone 0's "build the Kotlin WASM" step), not by this package —
  // fail with a clear message rather than a confusing stack trace if either
  // is missing (e.g. on a fresh clone before that step has run).
  if (!existsSync(KOTLIN_WASM_PATH)) {
    console.error(
      `[smoke] Kotlin WASM not found at:\n  ${KOTLIN_WASM_PATH}\n` +
        'This is a committed build artifact produced from fwcd/tree-sitter-kotlin ' +
        'via `tree-sitter-cli build --wasm` (see the plan\'s Milestone 0 build step). ' +
        'Build it and commit it to vendor/ before running this smoke test.',
    );
    process.exit(1);
  }

  if (!existsSync(TAGS_SCM_PATH)) {
    console.error(
      `[smoke] tags.scm not found at:\n  ${TAGS_SCM_PATH}\n` +
        'Copy queries/tags.scm from fwcd/tree-sitter-kotlin into ' +
        'packages/backend/src/resolver/ as part of the Milestone 0 build step.',
    );
    process.exit(1);
  }

  let lang: Language;
  try {
    // NOTE: 0.26.x API is `Language.load(path)`, not `Parser.Language.load`.
    lang = await Language.load(KOTLIN_WASM_PATH);
  } catch (err) {
    console.error(
      '[smoke] Kotlin WASM failed to load — likely ABI mismatch; ' +
        'rebuild with tree-sitter-cli ^0.26',
    );
    console.error(err);
    process.exit(1);
    return;
  }

  if (!lang) {
    console.error(
      '[smoke] Kotlin WASM failed to load — likely ABI mismatch; ' +
        'rebuild with tree-sitter-cli ^0.26',
    );
    process.exit(1);
    return;
  }

  console.log('[smoke] Kotlin language loaded OK');

  const parser = new Parser();
  parser.setLanguage(lang);

  const tagsSource = await readFile(TAGS_SCM_PATH, 'utf8');
  const query = new Query(lang, tagsSource);

  const SAMPLE = 'class Foo { fun bar() {} }';
  const tree = parser.parse(SAMPLE);
  if (!tree) {
    console.error('[smoke] parser.parse() returned no tree for the sample source');
    process.exit(1);
    return;
  }

  const captures = query.captures(tree.rootNode);

  console.log(`[smoke] tags.scm produced ${captures.length} capture(s) on the sample:`);
  for (const capture of captures) {
    console.log(`  @${capture.name}: ${JSON.stringify(capture.node.text)}`);
  }

  const capturedTexts = new Set(captures.map((c) => c.node.text));
  const hasFoo = capturedTexts.has('Foo');
  const hasBar = capturedTexts.has('bar');

  if (!hasFoo || !hasBar) {
    console.error(
      `[smoke] expected captured names to include both 'Foo' and 'bar', got: ` +
        `[${[...capturedTexts].join(', ')}]`,
    );
    process.exit(1);
    return;
  }

  console.log("[smoke] OK — tags.scm captured both 'Foo' (class) and 'bar' (function)");
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] unexpected failure:', err);
  process.exit(1);
});
