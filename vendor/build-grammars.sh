#!/usr/bin/env bash
# Build one or more tree-sitter grammar wasms into vendor/, from pinned
# upstream commits, with a pinned tree-sitter-cli version.
#
# Why pinned this tightly: web-tree-sitter@0.26.x (the runtime
# packages/backend loads grammars with) only speaks one wasm ABI generation.
# tree-sitter-cli emits whatever ABI its own version defaults to, and a
# mismatch between the CLI that built a wasm and the runtime that loads it
# does NOT raise an error at load time -- the grammar just fails to produce
# captures, silently, at some later point in a resolve. So every wasm in
# this directory MUST be built with tree-sitter-cli 0.26.10 exactly; that
# version number IS the ABI guarantee, not a suggestion. See vendor/README.md
# for the provenance record (upstream repo, pinned commit, cli version,
# byte size, sha256) kept per grammar -- update it whenever a row here
# changes.
set -euo pipefail

readonly TS_CLI_VERSION="0.26.10"
readonly VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tracks the in-progress workdir so a single EXIT trap can clean up after a
# failed build. NOT a `trap ... RETURN` inside build_one: bash's RETURN trap
# is not scoped to the function that sets it -- it stays the active trap and
# fires again on every later function return (including main's, at the very
# end of a normal run), by which point $workdir is out of scope and errors
# under `set -u`. One EXIT trap, cleared by build_one on its own success
# path, avoids that.
CLEANUP_DIR=""
trap '[[ -n "$CLEANUP_DIR" ]] && rm -rf "$CLEANUP_DIR"' EXIT

# Pin table: one row per grammar key, "url|commit-sha|subdir".
# subdir is '' when the grammar lives at the repo root. Append a row here
# and nothing else needs to change to build it.
declare -A GRAMMARS=(
  [kotlin]="https://github.com/fwcd/tree-sitter-kotlin|c8ac3d2627240160b999a2c100de3babbdb8f419|"
  [typescript]="https://github.com/tree-sitter/tree-sitter-typescript|75b3874edb2dc714fb1fd77a32013d0f8699989f|typescript"
  [tsx]="https://github.com/tree-sitter/tree-sitter-typescript|75b3874edb2dc714fb1fd77a32013d0f8699989f|tsx"
  [javascript]="https://github.com/tree-sitter/tree-sitter-javascript|58404d8cf191d69f2674a8fd507bd5776f46cb11|"
  [python]="https://github.com/tree-sitter/tree-sitter-python|26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64|"
  [java]="https://github.com/tree-sitter/tree-sitter-java|e10607b45ff745f5f876bfa3e94fbcc6b44bdc11|"
  [go]="https://github.com/tree-sitter/tree-sitter-go|2346a3ab1bb3857b48b29d779a1ef9799a248cd7|"
  [rust]="https://github.com/tree-sitter/tree-sitter-rust|77a3747266f4d621d0757825e6b11edcbf991ca5|"
  [c]="https://github.com/tree-sitter/tree-sitter-c|b780e47fc780ddc8da13afa35a3f4ed5c157823d|"
  [cpp]="https://github.com/tree-sitter/tree-sitter-cpp|8b5b49eb196bec7040441bee33b2c9a4838d6967|"
  [csharp]="https://github.com/tree-sitter/tree-sitter-c-sharp|9150f7d56bb47f1a809fa23623f1ba1413e93fa9|"
)

usage() {
  echo "Usage: $(basename "${BASH_SOURCE[0]}") <key> [<key>...]"
  echo "       $(basename "${BASH_SOURCE[0]}") --all"
  echo
  echo "Builds vendor/tree-sitter-<key>.wasm from the pinned upstream commit,"
  echo "with tree-sitter-cli ${TS_CLI_VERSION} (must match the web-tree-sitter"
  echo "runtime's ABI generation -- see the header comment in this script)."
  echo
  echo "Known keys:"
  printf '  %-12s %-45s %-42s %s\n' "key" "upstream" "commit" "subdir"
  for key in "${!GRAMMARS[@]}"; do
    IFS='|' read -r url sha subdir <<<"${GRAMMARS[$key]}"
    printf '  %-12s %-45s %-42s %s\n' "$key" "$url" "$sha" "${subdir:-(root)}"
  done
}

build_one() {
  local key="$1"
  local row="${GRAMMARS[$key]:-}"
  if [[ -z "$row" ]]; then
    echo "error: unknown grammar key '$key'" >&2
    exit 1
  fi
  local url sha subdir
  IFS='|' read -r url sha subdir <<<"$row"

  local workdir
  workdir="$(mktemp -d)"
  CLEANUP_DIR="$workdir"

  echo "== $key: fetching $url @ $sha =="
  git init --quiet "$workdir"
  git -C "$workdir" remote add origin "$url"
  git -C "$workdir" fetch --depth 1 origin "$sha"
  git -C "$workdir" checkout --quiet --detach FETCH_HEAD

  local grammar_dir="$workdir"
  if [[ -n "$subdir" ]]; then
    grammar_dir="$workdir/$subdir"
  fi

  # Fallback, not run unconditionally: if the upstream's committed
  # src/parser.c predates the ABI this tree-sitter-cli emits, `build` fails
  # to compile it. Regenerating from grammar.js first fixes that. Uncomment
  # if a grammar needs it:
  # npx --yes "tree-sitter-cli@${TS_CLI_VERSION}" generate --quiet
  #   (run with $grammar_dir as the working directory)

  local out_wasm="$workdir/out.wasm"
  echo "== $key: building with tree-sitter-cli@${TS_CLI_VERSION} =="
  (cd "$grammar_dir" && npx --yes "tree-sitter-cli@${TS_CLI_VERSION}" build --wasm -o "$out_wasm" .)

  local dest="$VENDOR_DIR/tree-sitter-${key}.wasm"
  cp "$out_wasm" "$dest"

  local size sha256
  size="$(stat -c '%s' "$dest")"
  sha256="$(sha256sum "$dest" | cut -d' ' -f1)"
  echo "== $key: wrote $dest =="
  echo "   size:   ${size} bytes"
  echo "   sha256: ${sha256}"

  rm -rf "$workdir"
  CLEANUP_DIR=""
}

main() {
  if [[ "$#" -eq 0 ]]; then
    usage
    exit 1
  fi

  local keys=()
  if [[ "$1" == "--all" ]]; then
    keys=("${!GRAMMARS[@]}")
  else
    keys=("$@")
  fi

  for key in "${keys[@]}"; do
    build_one "$key"
  done
}

main "$@"
