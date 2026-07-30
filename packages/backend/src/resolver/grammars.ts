// Where each language's tree-sitter assets live on disk, keyed by the
// Language.id values in @ctrlclickdiff/shared's registry.
//
// Split from that registry because it is imported by the browser and these are
// filesystem paths. Split from server.ts because smoke.ts needs exactly the same
// two paths, and they used to be computed independently in both — along with
// resolveTreeSitterRuntimeWasm(), which was duplicated verbatim.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Repo layout is packages/backend/src/resolver/, so the repo root is four up. */
const REPO_ROOT = resolvePath(here, '../../../..');

export interface GrammarAssets {
  /** The compiled grammar, committed under vendor/ (no upstream prebuild exists). */
  readonly wasmPath: string;
  /** The tags query naming this language's declarations, beside this file. */
  readonly tagsScmPath: string;
}

/**
 * Keyed by Language.id. Every id in LANGUAGES must appear here — asserted at
 * boot by TreeSitterResolver.init, because a missing grammar makes Ctrl+click
 * answer empty rather than fail, and an empty answer is indistinguishable from
 * "no such symbol".
 */
export const GRAMMARS: Readonly<Record<string, GrammarAssets>> = {
  kotlin: {
    wasmPath: resolvePath(REPO_ROOT, 'vendor/tree-sitter-kotlin.wasm'),
    tagsScmPath: resolvePath(here, 'tags.scm'),
  },
};

/**
 * Resolve the on-disk path to web-tree-sitter's own runtime WASM (the generic
 * engine, distinct from a grammar). Under plain Node/tsx (no bundler),
 * `Parser.init()`'s default `locateFile` heuristics don't reliably find this
 * relative to cwd, so we resolve it explicitly via Node's module resolver and
 * hand it back through an explicit `locateFile` override. Falls back gracefully
 * to `Parser.init()`'s own default behavior if resolution fails — the real
 * failure signal is the grammar load, not this.
 */
export function treeSitterRuntimeWasm(): string | undefined {
  try {
    // Subpath export — works if web-tree-sitter's package.json "exports"
    // exposes the .wasm file directly.
    return require.resolve('web-tree-sitter/tree-sitter.wasm');
  } catch {
    try {
      // Fall back: find the package's main entry and assume the runtime wasm
      // sits alongside it.
      const pkgEntry = require.resolve('web-tree-sitter');
      const candidate = resolvePath(dirname(pkgEntry), 'tree-sitter.wasm');
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
}
