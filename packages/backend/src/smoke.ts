// Boot smoke test — Milestone 0 "done when" gate, and the per-language gate
// every grammar added after it must pass too.
//
// Why this exists: there is no prebuilt grammar for any language this tool
// reviews, so each one is built from its own upstream grammar repo with
// tree-sitter-cli. The built `.wasm` and the `web-tree-sitter` *runtime* that
// loads it must be the same ABI generation (both 0.26.x) — a mismatch makes a
// grammar fail to load **silently** in normal use. This script turns that
// silent failure into a loud one by asserting every registered grammar loads
// AND that its tags.scm query actually produces the captures it promises, on
// a trivial sample.
//
// A registered language with no sample is its own silent-failure hazard: a
// grammar nothing exercises can break (or ship broken) without this script
// ever noticing, so a missing SAMPLES row is a smoke failure in its own
// right, not merely a gap in coverage. Every language landing in LANGUAGES
// must bring a row here in the same commit.
//
// Run via `pnpm --filter backend smoke` (see package.json). Exits 0 on
// success, 1 on any failure (missing prerequisite files, ABI mismatch, a
// tags query with an unrecognised definition kind, or a captures mismatch).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

// web-tree-sitter 0.26.x API: named imports, not the old `Parser.Language.load`.
import { Parser, Language, Query } from 'web-tree-sitter';

import { LANGUAGES, grammarKeyFor } from '@ctrlclickdiff/shared';
import { GRAMMARS, treeSitterRuntimeWasm } from './resolver/grammars';
import { assertDefinitionKinds } from './resolver/TreeSitterResolver';

/**
 * One smoke sample per grammar key. `sample` is a trivial, syntactically
 * valid snippet in that language; `expectedNames` are the identifier texts
 * its tags.scm must capture out of it (e.g. a class/type name and a
 * function/method name). Keep samples minimal — this proves the grammar and
 * query pipeline works end to end, not that they handle real code.
 */
const SAMPLES: Readonly<Record<string, { sample: string; expectedNames: readonly string[] }>> = {
  kotlin: {
    sample: 'class Foo { fun bar() {} }',
    expectedNames: ['Foo', 'bar'],
  },
  // Exercises class + method + interface + top-level const, per
  // tags/typescript.scm's four capture kinds (class, function, function,
  // constant) in one sample — the same file also proves the two
  // definition.function patterns (method_definition and the arrow-valued
  // top-level const) don't collide on a name.
  typescript: {
    sample: `
      class Greeter {
        greet() { return 'hi'; }
      }
      interface Named {
        name: string;
      }
      const VERSION = '1.0';
    `,
    expectedNames: ['Greeter', 'greet', 'Named', 'VERSION'],
  },
  // Must contain JSX — this is the sample that proves tsx.wasm (not just
  // typescript.wasm) loads and that tags/typescript.scm's shared query
  // captures a definition.function through actual JSX syntax, which the
  // 'typescript' sample above never touches.
  tsx: {
    sample: `
      export function App() {
        return <div/>;
      }
      const Widget = () => {
        return <span/>;
      };
    `,
    expectedNames: ['App', 'Widget'],
  },
  // Exercises three capture kinds at once: a class with a method
  // (definition.class + definition.function via method_definition), a
  // top-level const (definition.constant), and a JSX expression as that
  // const's value — proving the grammar parses JSX natively rather than
  // needing a second wasm the way tree-sitter-typescript does for `.tsx`.
  javascript: {
    sample: 'class Foo { bar() {} }\nconst baz = <div>{1}</div>;',
    expectedNames: ['Foo', 'bar', 'baz'],
  },
  python: {
    sample: 'MAX_SIZE = 100\n\nclass Foo:\n    def bar(self):\n        pass\n',
    expectedNames: ['MAX_SIZE', 'Foo', 'bar'],
  },
  java: {
    sample: 'class Foo { int bar; void baz() {} }',
    expectedNames: ['Foo', 'bar', 'baz'],
  },
};

async function main(): Promise<void> {
  console.log('[smoke] initializing web-tree-sitter runtime...');

  const runtimeWasm = treeSitterRuntimeWasm();
  if (runtimeWasm) {
    console.log(`[smoke] resolved tree-sitter.wasm runtime at: ${runtimeWasm}`);
  } else {
    console.warn(
      '[smoke] could not explicitly resolve web-tree-sitter/tree-sitter.wasm; ' +
        'falling back to the package default locateFile behavior',
    );
  }

  await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

  // Registry order, deduplicated by grammar key — several LANGUAGES entries
  // can share a grammar key on purpose (see grammarKeyFor), and a key should
  // only be exercised once.
  const keys = new Set(LANGUAGES.map(grammarKeyFor));

  for (const key of keys) {
    const grammar = GRAMMARS[key];
    if (!grammar) {
      console.error(
        `[smoke] '${key}' is registered in LANGUAGES but has no grammar assets in ` +
          'resolver/grammars.ts GRAMMARS — a registered language has no grammar assets.',
      );
      process.exit(1);
      return;
    }

    const sample = SAMPLES[key];
    if (!sample) {
      console.error(
        `[smoke] '${key}' has grammar assets but no SAMPLES entry in this file — ` +
          'a registered grammar has no smoke sample, and a grammar nothing exercises ' +
          'can break silently. Add a SAMPLES row for it.',
      );
      process.exit(1);
      return;
    }

    // The grammar and tags assets are produced by a parallel build step, not
    // by this package — fail with a clear message rather than a confusing
    // stack trace if either is missing (e.g. on a fresh clone before that
    // step has run).
    if (!existsSync(grammar.wasmPath)) {
      console.error(
        `[smoke] '${key}' WASM not found at:\n  ${grammar.wasmPath}\n` +
          'This is a committed build artifact. See vendor/README.md for this ' +
          "grammar's upstream source and rebuild instructions, and build it " +
          'with tree-sitter-cli ^0.26 (the ABI web-tree-sitter@0.26.x expects) ' +
          'before running this smoke test.',
      );
      process.exit(1);
      return;
    }

    if (!existsSync(grammar.tagsScmPath)) {
      console.error(
        `[smoke] '${key}' tags.scm not found at:\n  ${grammar.tagsScmPath}\n` +
          "Copy this grammar's queries/tags.scm from its upstream repo (see " +
          'vendor/README.md) into that path.',
      );
      process.exit(1);
      return;
    }

    let lang: Language;
    try {
      // NOTE: 0.26.x API is `Language.load(path)`, not `Parser.Language.load`.
      lang = await Language.load(grammar.wasmPath);
    } catch (err) {
      console.error(
        `[smoke] '${key}' WASM failed to load — likely ABI mismatch; ` +
          'rebuild with tree-sitter-cli ^0.26',
      );
      console.error(err);
      process.exit(1);
      return;
    }

    if (!lang) {
      console.error(
        `[smoke] '${key}' WASM failed to load — likely ABI mismatch; ` +
          'rebuild with tree-sitter-cli ^0.26',
      );
      process.exit(1);
      return;
    }

    console.log(`[smoke] '${key}' language loaded OK`);

    const parser = new Parser();
    parser.setLanguage(lang);

    const tagsSource = await readFile(grammar.tagsScmPath, 'utf8');
    const query = new Query(lang, tagsSource);

    // Boot catches a tags query naming a definition kind this resolver
    // doesn't recognise (see assertDefinitionKinds's doc); smoke should
    // catch the same thing rather than pass on a grammar boot would reject.
    assertDefinitionKinds(query, key);

    const tree = parser.parse(sample.sample);
    if (!tree) {
      console.error(`[smoke] '${key}' parser.parse() returned no tree for the sample source`);
      process.exit(1);
      return;
    }

    const captures = query.captures(tree.rootNode);
    const capturedTexts = new Set(captures.map((c) => c.node.text));

    const missing = sample.expectedNames.filter((name) => !capturedTexts.has(name));
    if (missing.length > 0) {
      console.error(
        `[smoke] '${key}' expected captured names to include ` +
          `[${sample.expectedNames.join(', ')}], missing [${missing.join(', ')}]. ` +
          `Actually captured: [${[...capturedTexts].join(', ')}]`,
      );
      process.exit(1);
      return;
    }

    console.log(`[smoke] ${key} OK — captured [${sample.expectedNames.join(', ')}]`);
  }

  console.log(`[smoke] all ${keys.size} grammars OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] unexpected failure:', err);
  process.exit(1);
});
