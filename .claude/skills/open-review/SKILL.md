---
name: open-review
description: Use at the end of an iteration, once the work is committed, to open a CtrlClickDiff review of exactly those commits in front of the human — a tab in Orca's embedded browser when running under Orca. Also use when asked to "open the review", "show me the diff", or "send this for review".
---

# Open the review

Run, from anywhere inside the worktree:

```bash
node tools/ccd-review.mjs
```

It works out which commits this iteration added, registers the worktree with the
CtrlClickDiff backend, prints the review URL and opens it. Nothing else is
needed — do not compute SHAs, build the URL, or open a browser by hand.

## Read the exit code, then say what happened

- **0** — the review is open. Report the printed URL, so it survives in the
  transcript after the tab is closed.
- **2** — the iteration left no commits. Say exactly that: CtrlClickDiff reviews
  commits, so an uncommitted working tree has nothing to show. Commit the work
  first, then run it again. Do not pass `--base` to manufacture a range.
- **1** — a real failure, and stderr says which. The two common ones are the
  backend not running (`./start.sh`) and a worktree outside the browse root
  (`CCD_BROWSE_ROOT`). Relay the message; it is written for a human.

## Flags worth knowing

- `--base=<rev>` — review commits since `<rev>` instead of since the session
  started. Use only when the human names a starting point.
- `--no-open` — print the URL without opening anything.
- `--shas=<sha>,<sha>` — review exactly these commits.

Everything else the tool decides for itself, and it is the one place those
decisions live: do not reimplement any of it in a prompt.
