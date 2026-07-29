// live.ts — the repository watch stream, and nothing else.
//
// `GET /api/watch?repo=<id>` is an SSE stream that emits `event: refs` whenever
// the repository's refs or HEAD actually move (backend watch.ts debounces the
// filesystem noise and deduplicates by a change token, so `.git/index` churn
// produces nothing). This module opens one, hands each event to a callback,
// keeps it open, and closes it on request. It decides nothing about what a
// refresh means; that is shell.ts's business, and keeping it there is what lets
// this file be read in one sitting.
//
// It is also the one /api route that does not go through api.ts. EventSource
// brings its own transport, so repoFetch()'s `repo=` appending and its 409
// restart recovery are simply not reachable from here — the URL is spelled out
// below, and the recovery is reopen(), for the reasons on it.

/** An open watch stream. The only thing a caller can do to one is close it. */
export interface LiveStream {
  close(): void;
}

// Same 3s the backend puts in the stream's `retry:` field, so the two halves of
// "how long until we try again" do not disagree, and the same 3s doubling to
// half a minute if the failure persists. The ceiling is not tuning: reopen()
// below runs on failures a retry cannot fix by itself, and a fixed interval
// against one of those is a request per 3s for as long as the tab is open.
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 30000;

// How long the stream may stay silent before we assume it is dead and reopen.
// The server sends a `ping` event every 15s, so this is three missed beats —
// wide enough that a slow tab or a suspended laptop does not trip it, tight
// enough that a stale stream self-heals in well under a minute.
const SILENCE_TIMEOUT_MS = 45000;

/**
 * Watches `repoId` and calls `onRefsChanged` every time its refs move.
 *
 * The event's payload (`{headSha}`) is deliberately not parsed or passed on. It
 * describes HEAD, while the shell may be reviewing an entirely different branch,
 * so it cannot answer the only question a listener has — "what should I be
 * showing now?". The event is a hint meaning *look again*; the answer comes from
 * re-reading /api/branches and /api/commits, which is what the callback does.
 */
export function watchRepo(repoId: string, onRefsChanged: () => void): LiveStream {
  const url = `/api/watch?repo=${encodeURIComponent(repoId)}`;

  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = RETRY_MIN_MS;
  let closed = false;

  const open = (): void => {
    const es = new EventSource(url);
    source = es;

    // Restarted on every byte the server sends. If it ever fires, the stream
    // has gone quiet for longer than the server's heartbeat can explain, so we
    // throw it away and open a fresh one. See the note in the error handler for
    // why this is not redundant with EventSource's own reconnect: through a dev
    // proxy the socket can stay open over a dead upstream and no error ever
    // fires, which makes silence the only symptom available.
    const heard = (): void => {
      if (closed || source !== es) return;
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (closed || source !== es) return;
        console.debug(`[ccd] watch stream for ${repoId} went silent; reopening`);
        es.close();
        open();
      }, SILENCE_TIMEOUT_MS);
    };

    es.addEventListener('open', () => {
      retryMs = RETRY_MIN_MS;
      heard();
    });

    // The heartbeat carries no information; being received IS the information.
    es.addEventListener('ping', heard);

    es.addEventListener('refs', () => {
      heard();
      onRefsChanged();
    });

    es.addEventListener('error', () => {
      // Ignore an error from a stream we have already replaced or closed.
      if (closed || source !== es) return;

      // Two very different situations arrive through this one handler, and only
      // readyState tells them apart. CONNECTING means the transport dropped and
      // the browser is already retrying by itself, at the server's `retry:`
      // interval — routine, and nothing to add to.
      if (es.readyState !== EventSource.CLOSED) {
        console.debug(`[ccd] watch stream for ${repoId} dropped; the browser is reconnecting`);
        return;
      }

      // NOTE, because it costs an hour to rediscover: when the *backend*
      // restarts under `pnpm dev`, neither branch of this handler runs.
      // Measured: a stream read straight from :5178 errors ~2.5s after the
      // process dies — the drop EventSource retries from — while the same
      // stream through Vite's proxy on :5173 stays open over a dead upstream
      // for 20s+ with no error event at all. That is why the silence watchdog
      // above exists and is not redundant with this handler: a stream can be
      // dead without ever being *errored*, and the only symptom left is that
      // the server's heartbeat stopped arriving.

      // CLOSED means the browser has given up permanently, which per the
      // EventSource spec is what *any* non-200 response causes — and a restarted
      // backend answers 409 for a repo id its fresh in-memory registry has never
      // heard of, exactly the case api.ts's repoFetch() exists to paper over for
      // the fetch-based routes. An EventSource cannot re-POST the repo path and
      // retry, so all this can do is keep asking. It is not a wasted loop: the
      // first ordinary request the shell makes re-registers the repository, and
      // the next attempt after that connects.
      console.debug(`[ccd] watch stream for ${repoId} closed; retrying in ${retryMs}ms`);
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    });
  };

  open();

  return {
    close(): void {
      closed = true;
      clearTimeout(timer);
      clearTimeout(silenceTimer);
      source?.close();
      source = null;
    },
  };
}
