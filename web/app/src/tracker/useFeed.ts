/**
 * A page's live read of one project's event feed (api.md § The event feed):
 * `GET /tracker/{project}/events/ws` with JSON frames, every surface and every
 * kind, so an agent's write over MCP reaches the page as it commits.
 *
 * * **Each event** is handed to `onEvent`. The page decides what to re-read.
 * * **Each time the socket opens** (`onResync`): anything committed while it
 *   was closed, or before the page's first read landed, is not replayed (no
 *   `since`), so the page re-reads instead.
 * * **While it is down** (closed, refused, a proxy without WebSockets) it
 *   reconnects with backoff, and `onResync` runs every
 *   {@link FEED_FALLBACK_MS} meanwhile: the page degrades to the queue's poll,
 *   never to a page that stops updating.
 * * **Hidden, it closes.** Nothing runs while the tab is in the background;
 *   coming back reconnects, which resyncs.
 *
 * `null` for the project opens nothing (the page does not know it yet).
 *
 * {@link useFeedRefresh} is the plainer way to follow it: re-read on any event,
 * settled so that a burst costs one read (the roadmap and phase pages).
 */

import { useCallback, useEffect, useRef } from 'react';

import type { FeedEvent } from './types';

/** How often a page re-reads while the feed is down (the queue's interval). */
export const FEED_FALLBACK_MS = 10_000;

/** The reconnect backoff: doubling from the first to the last. */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * How long a page waits after a feed event before re-reading, so that a burst
 * (a drag reorder, a release of forty, an agent's run of writes) costs one read.
 */
export const LIVE_SETTLE_MS = 250;

/**
 * The feed's address on this origin: every surface, every kind, one JSON frame
 * per event, drafts and roadmap events included. The feed leaves a draft's
 * writes (2026-10-30) and a frozen ticket's or a phase's (spec:roadmap D19) out
 * by default, and the owner's own page must still follow them. A frozen draft's
 * events carry both flags, so this needs both.
 */
export function feedUrl(project: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return (
    `${scheme}//${window.location.host}/tracker/${encodeURIComponent(project)}/events/ws` +
    '?surface=any&kinds=all&format=json&drafts=true&roadmap=true'
  );
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** A frame as an event, or `null` for anything that is not one. */
function parse(data: unknown): FeedEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const value = JSON.parse(data) as Partial<FeedEvent> | null;
    return value !== null && typeof value === 'object' && typeof value.event_id === 'number'
      ? (value as FeedEvent)
      : null;
  } catch {
    return null;
  }
}

export function useProjectFeed(
  project: string | null,
  onEvent: (event: FeedEvent) => void,
  onResync: () => void,
): void {
  // The latest callbacks, so a re-render never reopens the socket.
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };

  useEffect(() => {
    if (project === null || typeof WebSocket === 'undefined') {
      return undefined;
    }
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;
    let backoff = RECONNECT_FIRST_MS;
    let stopped = false;

    const clearTimers = () => {
      if (reconnect !== null) {
        clearTimeout(reconnect);
        reconnect = null;
      }
      if (fallback !== null) {
        clearInterval(fallback);
        fallback = null;
      }
    };

    const down = () => {
      socket = null;
      if (stopped || hidden()) {
        return;
      }
      if (fallback === null) {
        fallback = setInterval(() => handlers.current.onResync(), FEED_FALLBACK_MS);
      }
      if (reconnect === null) {
        reconnect = setTimeout(() => {
          reconnect = null;
          open();
        }, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    };

    const open = () => {
      if (stopped || socket !== null || hidden()) {
        return;
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(feedUrl(project));
      } catch {
        down();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        if (fallback !== null) {
          clearInterval(fallback);
          fallback = null;
        }
        backoff = RECONNECT_FIRST_MS;
        handlers.current.onResync();
      };
      ws.onmessage = (message: MessageEvent) => {
        const event = parse(message.data);
        if (event !== null) {
          handlers.current.onEvent(event);
        }
      };
      // An error is always followed by a close; the close does the work.
      ws.onclose = () => {
        if (socket === ws) {
          down();
        }
      };
    };

    const shut = () => {
      clearTimers();
      const ws = socket;
      socket = null;
      if (ws !== null) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
    };

    const onVisibility = () => {
      if (hidden()) {
        shut();
      } else {
        backoff = RECONNECT_FIRST_MS;
        open();
      }
    };

    open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      shut();
    };
  }, [project]);
}

/**
 * Re-read on any event in the project, {@link LIVE_SETTLE_MS} after the first
 * of a burst, and at once on each resync.
 */
export function useFeedRefresh(project: string | null, refresh: () => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (settle.current !== null) {
      clearTimeout(settle.current);
      settle.current = null;
    }
  }, []);
  const onEvent = useCallback(() => {
    if (settle.current === null) {
      settle.current = setTimeout(() => {
        settle.current = null;
        latest.current();
      }, LIVE_SETTLE_MS);
    }
  }, []);
  const onResync = useCallback(() => {
    clear();
    latest.current();
  }, [clear]);

  useEffect(() => clear, [clear]);
  useProjectFeed(project, onEvent, onResync);
}
