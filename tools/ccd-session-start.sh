#!/bin/sh
# Records where HEAD was when an agent session started, so that at the end of it
# `tools/ccd-review.mjs` can review exactly what the session added and not
# whatever else the branch was already carrying.
#
# Wire it up as a SessionStart hook (see README, "Review from an agent"). It is
# not installed automatically: a hook is a change to the user's own settings, and
# this repository does not make those.
#
# Contract, the same one Orca's own agent hooks keep: never block, never fail the
# session, never print. A review opener is a convenience, and a convenience that
# can break an agent's startup is not one.
set -u

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ccd/session-base"

top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
head=$(git rev-parse HEAD 2>/dev/null) || exit 0
[ -n "$top" ] && [ -n "$head" ] || exit 0

# Keyed by the worktree path, hashed: two worktrees of one repository are two
# different sessions with two different bases, and a path cannot be a filename.
# The first 16 hex digits, matching digest() in ccd-review.mjs — the two have to
# agree or the file is written where nothing looks for it.
key=$(printf '%s' "$top" | sha256sum | cut -c1-16)

mkdir -p "$CACHE_DIR" 2>/dev/null || exit 0
printf '%s\n' "$head" > "$CACHE_DIR/$key" 2>/dev/null || exit 0
exit 0
