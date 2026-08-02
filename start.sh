#!/usr/bin/env bash
# Launch both halves of CtrlClickDiff from one terminal and stop both together.
#
#   ./start.sh                      # no default repo — pick one in the app
#   ./start.sh ~/ccd-sample-repo    # open this repo on first load
#
# This is a convenience wrapper around the two commands in README.md's "Run"
# section. It exists rather than being a two-line script because two details of
# the dev setup are easy to get wrong by hand; both are commented at their spot
# below (process groups, and waiting for the port).

set -euo pipefail

# Job control, so each background job below becomes its own process group and
# the cleanup trap can signal the whole group. Killing the `pnpm dev:backend`
# wrapper on its own does not reliably take its `tsx watch` child with it, and
# the orphan keeps the backend port bound — the next start then either fails to
# bind or, worse, looks fine while serving the old code. (README, "Development
# note".)
set -m

cd "$(dirname "${BASH_SOURCE[0]}")"

BACKEND_PORT="${PORT:-5178}"

usage() {
  cat <<'EOF'
Usage: ./start.sh [repo-path]

Starts the backend and the Vite dev server together; Ctrl+C stops both.

  repo-path   Repo to select on first load (same as REPO_ROOT). Optional:
              without it, pick one with the repo picker in the app.

Honours REPO_ROOT, CCD_BROWSE_ROOT and PORT from the environment — see README.md.
EOF
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  -*) usage >&2; exit 2 ;;
  # Not validated here on purpose: the backend already rejects a set-but-invalid
  # REPO_ROOT fatally, with a better message than this script could give.
  ?*) export REPO_ROOT="$1" ;;
esac

# Bash builtin rather than curl/nc, so the script has no dependency the app
# itself doesn't already have.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$BACKEND_PORT") 2>/dev/null; }

if [[ ! -d node_modules ]]; then
  echo "start.sh: dependencies are not installed — run 'pnpm install' first." >&2
  exit 1
fi

if [[ "$BACKEND_PORT" != 5178 ]]; then
  echo "start.sh: warning — PORT=$BACKEND_PORT, but the Vite dev proxy targets" >&2
  echo "  127.0.0.1:5178 (packages/frontend/vite.config.ts), so /api will not reach" >&2
  echo "  this backend. Unset PORT, or edit that proxy target to match." >&2
fi

if port_open; then
  echo "start.sh: something is already listening on :$BACKEND_PORT." >&2
  echo "  A 'tsx watch' backend can outlive the pnpm process that started it;" >&2
  echo "  find it with 'lsof -i :$BACKEND_PORT'." >&2
  exit 1
fi

pids=()
cleanup() {
  trap - INT TERM EXIT   # idempotent: whichever path got here owns the shutdown
  echo
  echo "start.sh: stopping both halves."
  if ((${#pids[@]})); then
    for pid in "${pids[@]}"; do
      # The negative PID is the whole process group, and is the reason `set -m`
      # is on above: signalling the pnpm wrapper alone leaves `tsx watch` and
      # the backend it spawned alive, still holding the port.
      kill -- "-$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  fi
}
# Ctrl+C and SIGTERM exit here rather than falling back into the script, so the
# "exited on its own" message below stays true to what actually happened.
on_signal() { cleanup; exit 130; }
trap on_signal INT TERM
trap cleanup EXIT

pnpm dev:backend &
pids+=("$!")

# Wait for the port before starting the frontend. The backend loads every
# registered grammar (12 wasms) and registers REPO_ROOT *before* it listens,
# and both of those are fatal on failure — so a URL printed at this point can
# easily belong to a process that is already exiting.
for _ in {1..150}; do
  port_open && break
  kill -0 "${pids[0]}" 2>/dev/null || {
    echo "start.sh: the backend exited during startup — see its output above." >&2
    exit 1
  }
  sleep 0.2
done

if ! port_open; then
  echo "start.sh: backend never listened on :$BACKEND_PORT (waited 30s)." >&2
  exit 1
fi

echo "start.sh: backend up on http://127.0.0.1:$BACKEND_PORT — starting the frontend."

pnpm dev:frontend &
pids+=("$!")

# Return as soon as either half stops; the EXIT trap takes the other one down,
# so a crashed backend does not leave a frontend behind serving 502s.
wait -n || true
echo "start.sh: one half exited on its own — see its output above."
