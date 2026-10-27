/**
 * The dashboard's live read of one project's queue (D14).
 *
 * * **Every 10 s while the tab is visible**, a conditional request
 *   (`If-None-Match`). A 304 changes nothing: no state update, no render. So a
 *   manager's writes appear without a reload, and an idle dashboard costs a
 *   header round trip.
 * * **Hidden, it stops.** No timer runs while the tab is in the background;
 *   coming back refreshes at once and restarts the clock.
 * * **At once after the viewer's own write**: `refresh()`, which resolves when
 *   the new view is in hand, so a caller can drop whatever it was showing in
 *   the meantime.
 *
 * Only the newest request may land: a poll that set out before a write must
 * not paint the order from before it over the order after it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { getQueue } from './api';
import type { QueueView } from './types';

/** How often the dashboard asks (D14). */
export const QUEUE_REFRESH_MS = 10_000;

export type QueueState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      view: QueueView;
      /** Bumped on every view that differs from the last: a 304 never bumps it. */
      revision: number;
      /** A refresh failed; `view` is the last good one. */
      error: LedgerApiError | null;
    }
  | { kind: 'error'; error: LedgerApiError };

export interface QueueHandle {
  state: QueueState;
  /** Re-read now (conditionally). Resolves once the answer is applied. */
  refresh: () => Promise<void>;
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function useQueue(project: string, intervalMs = QUEUE_REFRESH_MS): QueueHandle {
  const [state, setState] = useState<QueueState>({ kind: 'loading' });
  const etag = useRef<string | null>(null);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      const fetched = await getQueue(project, etag.current, abort.signal);
      if (seq !== latest.current) {
        return;
      }
      if (fetched.kind === 'unchanged') {
        // A 304: what is on screen is current. Clear a stale error only.
        setState((prev) =>
          prev.kind === 'ready' && prev.error !== null ? { ...prev, error: null } : prev,
        );
        return;
      }
      etag.current = fetched.etag;
      setState((prev) => ({
        kind: 'ready',
        view: fetched.view,
        revision: prev.kind === 'ready' ? prev.revision + 1 : 1,
        error: null,
      }));
    } catch (cause) {
      if (isAbort(cause) || seq !== latest.current) {
        return;
      }
      const error = asApiError(cause);
      setState((prev) => (prev.kind === 'ready' ? { ...prev, error } : { kind: 'error', error }));
    }
  }, [project]);

  // A new project starts from nothing: no validator, no view.
  useEffect(() => {
    etag.current = null;
    setState({ kind: 'loading' });
    void load();
    return () => {
      latest.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  // The poll: only while visible.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) {
        timer = setInterval(() => void load(), intervalMs);
      }
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (hidden()) {
        stop();
      } else {
        void load();
        start();
      }
    };
    if (!hidden()) {
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);

  return { state, refresh: load };
}
