/**
 * Where a list page was scrolled to, kept for the way back (rag-t0040).
 *
 * The owner opens an item from far down the queue, reads it, and goes back:
 * the queue should be where he left it, not at the top. The browser's own
 * scroll restoration cannot do it here: the dashboard draws a spinner first
 * and its rows a moment later, so on a back the browser restores into a page
 * too short to scroll and the position is lost.
 *
 * So each list page (the dashboard, History, Documents) remembers its own
 * window scroll in `sessionStorage`, per project, and puts it back **once its
 * rows have rendered** — never before (the page is too short), and never
 * again in the same visit (the dashboard's 10 s refresh must not move the
 * reader).
 *
 * **A return** restores; anything else starts at the top. A return is:
 *
 * * the browser's back or forward (a `POP` after the page has loaded);
 * * a link that says it goes back: the item page's link to its queue, a
 *   document's link to the documents page, and the Queue / Documents /
 *   History tabs, which carry {@link RETURN_STATE} as router state;
 * * a reload, or coming back to the app from another site with Back (the
 *   page load's own navigation type), as the browser itself would.
 *
 * A pasted link, the Tracker button, or the project picker is a fresh visit:
 * the remembered position is dropped and the page opens at the top.
 *
 * `sessionStorage` is per tab and dies with it, which is the lifetime a scroll
 * position deserves. It is guarded as `paths.ts` guards `localStorage`: a
 * browser that refuses site data throws, and a position that cannot be
 * remembered is simply not restored.
 */

import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router';

const PREFIX = 'rag.tracker.scroll.';

/** The router state a link carries when following it is a return (see above). */
export const RETURN_STATE = { scrollReturn: true } as const;

/** Whether a location's router state marks it as a return. */
export function isReturnState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { scrollReturn?: unknown }).scrollReturn === true
  );
}

// ---- Storage ---------------------------------------------------------------

/** A page's remembered scroll, or `null` when there is none or it is unreadable. */
export function readScroll(key: string): number | null {
  try {
    const stored = window.sessionStorage.getItem(PREFIX + key);
    if (stored === null) {
      return null;
    }
    const y = Number(stored);
    return Number.isFinite(y) && y >= 0 ? y : null;
  } catch {
    return null;
  }
}

export function storeScroll(key: string, y: number): void {
  try {
    window.sessionStorage.setItem(PREFIX + key, String(Math.max(0, Math.round(y))));
  } catch {
    // Storage refused: the page still works, it just will not remember.
  }
}

export function clearScroll(key: string): void {
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // As above.
  }
}

// ---- What kind of arrival this is ------------------------------------------

/**
 * Whether the browser has moved through history since the page loaded.
 *
 * React Router reports the page's first location as a `POP` too, so a `POP`
 * is only a back or forward once a `popstate` has fired. This listener is
 * added when the module loads, before the router's own, so the flag is set
 * before the router renders the location the event brought.
 */
let popped = false;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    popped = true;
  });
}

/** For tests: forget that any history move has happened. */
export function resetHistoryWatch(): void {
  popped = false;
}

/** How the document itself was loaded: `navigate`, `reload` or `back_forward`. */
function pageLoadType(): string | null {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    return entry?.type ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether arriving at a page is a return to it (see the module comment).
 *
 * `afterPop` is whether a history move has happened since the page loaded;
 * `loadType` how the page load itself came about, which decides the first
 * location's case.
 */
export function isReturnVisit(
  navigationType: NavigationType,
  state: unknown,
  afterPop: boolean,
  loadType: string | null,
): boolean {
  if (isReturnState(state)) {
    return true;
  }
  if (navigationType !== 'POP') {
    return false;
  }
  return afterPop || loadType === 'reload' || loadType === 'back_forward';
}

// ---- The hook --------------------------------------------------------------

interface Visit {
  key: string;
  /** Where to put the page once it is ready; `null` is the top. */
  target: number | null;
  /** Restored (or sent to the top) and now saving. */
  settled: boolean;
}

/**
 * Remember and restore a list page's window scroll under `key`.
 *
 * `ready` is whether the page's rows have rendered: the restore waits for it,
 * and happens once per visit. A visit starts when the page mounts or its key
 * changes (a project's Documents tab is part of its key), and the arrival's
 * kind is read then: a later change of the URL in place (a filter) is not a
 * new visit. `key` `null` remembers nothing.
 *
 * Saving starts only after the restore, so the short page drawn while it
 * loads never overwrites the position it is about to return to.
 */
export function useScrollMemory(key: string | null, ready: boolean): void {
  const navigationType = useNavigationType();
  const location = useLocation();
  const state: unknown = location.state;
  const visit = useRef<Visit | null>(null);

  // The arrival: restore or top. Only the key starts a visit, so the
  // navigation type and state are those of the render that changed it; a
  // later change of them (a filter written into the URL) is not read.
  useLayoutEffect(() => {
    if (key === null) {
      visit.current = null;
      return;
    }
    if (isReturnVisit(navigationType, state, popped, pageLoadType())) {
      visit.current = { key, target: readScroll(key), settled: false };
    } else {
      clearScroll(key);
      visit.current = { key, target: null, settled: false };
      // A fresh visit opens at the top at once, rather than at whatever
      // offset the page it came from was scrolled to.
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    }

    const save = () => {
      const current = visit.current;
      if (current !== null && current.key === key && current.settled) {
        storeScroll(key, window.scrollY);
      }
    };
    // Removed in this effect's cleanup, during the commit that unmounts the
    // page: the scroll the browser makes as the next page shortens fires after
    // that, so it is never saved as this page's position.
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [key]);

  useLayoutEffect(() => {
    const current = visit.current;
    if (current === null || current.settled || !ready) {
      return;
    }
    current.settled = true;
    if (current.target !== null && current.target !== window.scrollY) {
      window.scrollTo(0, current.target);
    }
  }, [key, ready]);
}
