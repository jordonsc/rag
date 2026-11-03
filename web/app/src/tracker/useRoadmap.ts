/**
 * A page's read of a project's forward look (spec:roadmap D24, RM-42), the
 * shape of `useVelocity`:
 *
 * * **On mount**, **again whenever `viewKey` changes** (the first key to arrive
 *   is not a change: the mount's read covers it) and **whenever the window
 *   does**, since the figures are per window.
 * * **Every 60 s while the tab is visible**, since the figures move with the
 *   clock even when nothing is written. Hidden, it stops; shown again, it reads
 *   at once and restarts the clock.
 * * **A failed read keeps the last figures**, and a first failure leaves
 *   `roadmap` null, with `error` saying why: the page draws its own
 *   `ErrorState`, having nothing else to show. A new window keeps the figures
 *   in hand until its own arrive; a new project starts from nothing.
 * * **`refresh()`** reads now, and resolves when the read has landed, so a
 *   caller can drop what it was showing in the meantime.
 *
 * Only the newest request may land.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { getRoadmap } from './api';
import type { Roadmap, VelocityWindow } from './types';

/** How often a page re-reads while it is visible. */
export const ROADMAP_REFRESH_MS = 60_000;

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export interface RoadmapRead {
  roadmap: Roadmap | null;
  /** The last read failed. With `roadmap` null, nothing has been read yet. */
  error: LedgerApiError | null;
  refresh: () => Promise<void>;
}

export function useRoadmap(
  project: string,
  window: VelocityWindow,
  viewKey: number | string | null,
  intervalMs = ROADMAP_REFRESH_MS,
): RoadmapRead {
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      const read = await getRoadmap(project, window, abort.signal);
      if (seq === latest.current) {
        setRoadmap(read);
        setError(null);
      }
    } catch (cause) {
      // An abort is a newer read taking over; a failure keeps what is in hand.
      if (seq === latest.current && !isAbort(cause)) {
        setError(asApiError(cause));
      }
    }
  }, [project, window]);

  // A new project starts from nothing. Before the read below, so its answer stands.
  useEffect(() => {
    setRoadmap(null);
    setError(null);
  }, [project]);

  // The mount's read, and a new window's.
  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  // A new view. `null` is no view yet, and the first one is not a change.
  const seenKey = useRef(viewKey);
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

  return { roadmap, error, refresh: load };
}
