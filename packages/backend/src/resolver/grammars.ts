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
  /** The tags query naming this language's declarations: `tags/<grammarKey>.scm`. */
  readonly tagsScmPath: string;
}

/**
 * Keyed by grammar key (`grammarKeyFor`, from `@ctrlclickdiff/shared`), NOT
 * `Language.id` — several LANGUAGES entries can share an id (one Monaco
 * language, several tree-sitter grammars) but must not share a grammar key.
 * Every grammar key LANGUAGES names must appear here — asserted at boot by
 * TreeSitterResolver.init, because a missing grammar makes Ctrl+click answer
 * empty rather than fail, and an empty answer is indistinguishable from "no
 * such symbol".
 */
export const GRAMMARS: Readonly<Record<string, GrammarAssets>> = {
  kotlin: {
    wasmPath: resolvePath(REPO_ROOT, 'vendor/tree-sitter-kotlin.wasm'),
    tagsScmPath: resolvePath(here, 'tags/kotlin.scm'),
  },
  typescript: {
    wasmPath: resolvePath(REPO_ROOT, 'vendor/tree-sitter-typescript.wasm'),
    tagsScmPath: resolvePath(here, 'tags/typescript.scm'),
  },
  // Separate grammar, same tags file as `typescript` above — the declaration
  // node shapes tags/typescript.scm names are identical between the two
  // generated grammars (JSX is additive), so compiling that one query
  // against both wasms here at boot is what proves it stays true; see that
  // file's header for the one place they provably differ (type_assertion vs
  // the jsx_* nodes) and why the shared query only uses the intersection.
  tsx: {
    wasmPath: resolvePath(REPO_ROOT, 'vendor/tree-sitter-tsx.wasm'),
    tagsScmPath: resolvePath(here, 'tags/typescript.scm'),
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
 *
 * The filename is `web-tree-sitter.wasm`, not `tree-sitter.wasm` — the
 * package was renamed in 0.26 (it used to publish as `tree-sitter.wasm`
 * alongside `tree-sitter.js`) and both branches here still looked for the
 * old name. That made this function fail silently and return `undefined`
 * on every 0.26.x install; the resolver kept working anyway only because
 * `Parser.init()`'s default `locateFile` falls back to a plain HTTP-style
 * fetch of the wasm next to the loaded JS, which happens to still work
 * under tsx. Check both the subpath export and the sibling filename
 * against the installed package on the next web-tree-sitter upgrade —
 * this is exactly the kind of rename that breaks both silently again.
 */
export function treeSitterRuntimeWasm(): string | undefined {
  try {
    // Subpath export — works if web-tree-sitter's package.json "exports"
    // exposes the .wasm file directly.
    return require.resolve('web-tree-sitter/web-tree-sitter.wasm');
  } catch {
    try {
      // Fall back: find the package's main entry and assume the runtime wasm
      // sits alongside it.
      const pkgEntry = require.resolve('web-tree-sitter');
      const candidate = resolvePath(dirname(pkgEntry), 'web-tree-sitter.wasm');
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
}
