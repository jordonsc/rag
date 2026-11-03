/**
 * The queue page's read of a project's velocity (spec:velocity D15).
 *
 * * **On mount**, and **again whenever the queue view changes** (`viewKey`,
 *   the queue's own revision: its refresh brought a different view, so a
 *   ticket may have moved). The first view to arrive is not a change: the
 *   mount's read already covers it.
 * * **Every 60 s while the tab is visible**, since the windows move with the
 *   clock even when nothing is written. Hidden, it stops; shown again, it
 *   reads at once and restarts the clock (the `useQueue` pattern).
 * * **A failed read keeps the last good figures**, and a first read that
 *   fails leaves `null`: the widget draws nothing rather than an error, since
 *   the queue's own banner covers a dead server.
 *
 * Only the newest request may land, as in `useQueue`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getVelocity } from './api';
import type { Velocity } from './types';

/** How often the widget re-reads while the page is visible (D15). */
export const VELOCITY_REFRESH_MS = 60_000;

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function useVelocity(
  project: string,
  viewKey: number | null,
  intervalMs = VELOCITY_REFRESH_MS,
): Velocity | null {
  const [velocity, setVelocity] = useState<Velocity | null>(null);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      const read = await getVelocity(project, abort.signal);
      if (seq === latest.current) {
        setVelocity(read);
      }
    } catch {
      // A failure, or an abort: the last good figures stay, or none.
    }
  }, [project]);

  // The mount's read; a new project starts from nothing.
  useEffect(() => {
    setVelocity(null);
    void load();
    return () => {
      latest.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  // A new queue view. `null` is no view yet, and the first one is not a change.
  const seenKey = useRef<number | null>(viewKey);
  useEffect(() => {
    const previous = seenKey.current;
    seenKey.current = viewKey;
    if (previous !== null && viewKey !== null && viewKey !== previous) {
      void load();
    }
  }, [viewKey, load]);

  // The clock: only while visible.
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

  return velocity;
}
