/**
 * Tracker records to render, and a `fetch` double that speaks headers.
 *
 * The ledger's `Server` (fixtures.ts) answers bodies only; the queue view is a
 * conditional read (`ETag`, `If-None-Match`, 304), so this double records the
 * request headers it was sent and answers with headers of its own. Neutral
 * values only, as in `fixtures.ts`: this is a public repository.
 */

import type { Item, QueueView, TrackerEvent } from '../tracker/types';

export const STAMP = '2026-01-02T03:04:05Z';

/** An item, pending and queued, with whatever the test overrides. */
export function item(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    project: 'demo',
    type: 'dev',
    title: `Work ${id}`,
    body: '',
    status: 'pending',
    blocked: false,
    block_reason: null,
    block_note: null,
    approval: 'unapproved',
    assignee: null,
    intensity: null,
    release: false,
    queued: true,
    prev_id: null,
    next_id: null,
    links: [],
    created_at: STAMP,
    updated_at: STAMP,
    done_at: null,
    acknowledged_at: null,
    ...overrides,
  };
}

export function gateItem(id: string, overrides: Partial<Item> = {}): Item {
  return item(id, {
    type: 'gate',
    title: 'Standard gate',
    intensity: 'standard',
    ...overrides,
  });
}

/** The dashboard fixture: two done, five queued with a gate among them, one blocked. */
export function queueView(overrides: Partial<QueueView> = {}): QueueView {
  return {
    project: 'demo',
    exists: true,
    // The server's order: oldest first, the latest finished last (rag-t0029).
    done: [
      item('demo-t0009', {
        status: 'done',
        queued: false,
        title: 'Shipped earlier',
        done_at: '2026-01-02T00:00:00Z',
      }),
      item('demo-t0010', {
        status: 'done',
        queued: false,
        title: 'Shipped the thing',
        done_at: '2026-01-03T00:00:00Z',
      }),
    ],
    queue: [
      item('demo-t0001', {
        status: 'in_progress',
        assignee: 'dev-3',
        title: 'Being built',
        links: [{ kind: 'ledger', target: 'demo-0042' }],
      }),
      item('demo-t0002', { title: 'Next up', approval: 'agent' }),
      gateItem('demo-t0003', { release: true }),
      item('demo-t0004', { status: 'failed', title: 'Broke the gate' }),
      item('demo-t0005', { title: 'Later' }),
    ],
    blocked: [
      item('demo-t0006', {
        blocked: true,
        block_reason: 'review',
        block_note: 'Waiting on the owner’s eye.',
        title: 'Held for review',
      }),
    ],
    ...overrides,
  };
}

export const EVENTS: TrackerEvent[] = [
  {
    event_id: 1,
    ts: STAMP,
    author_email: 'agent@example.com',
    agent: 'Some Model 1',
    surface: 'mcp',
    kind: 'create',
    body: 'Queued by the manager.',
    fields: { type: 'dev', title: 'Next up', approval: 'agent', place: 'bottom' },
  },
  {
    event_id: 2,
    ts: '2026-01-02T04:00:00Z',
    author_email: 'alice@example.com',
    agent: 'Unknown',
    surface: 'web',
    kind: 'note',
    body: 'Looked at it.',
    fields: {},
  },
];

// ---- The fetch double -------------------------------------------------------

export interface TrackerSent {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Responder = (sent: TrackerSent) => Reply;

interface Route {
  match: (sent: TrackerSent) => boolean;
  respond: Responder;
  once: boolean;
}

export class TrackerServer {
  readonly sent: TrackerSent[] = [];
  private routes: Route[] = [];

  /** Answer every request whose path matches (and method, when named). */
  on(match: string | RegExp, reply: Reply | Responder, method?: 'GET' | 'POST'): this {
    this.routes.push({ match: matcher(match, method), respond: responder(reply), once: false });
    return this;
  }

  /** Answer once, ahead of any standing route, then fall through. */
  onceOn(match: string | RegExp, reply: Reply | Responder, method?: 'GET' | 'POST'): this {
    this.routes.unshift({ match: matcher(match, method), respond: responder(reply), once: true });
    return this;
  }

  /** The requests that matched, oldest first. */
  matching(match: string | RegExp, method?: 'GET' | 'POST'): TrackerSent[] {
    const test = matcher(match, method);
    return this.sent.filter(test);
  }

  last(match: string | RegExp, method?: 'GET' | 'POST'): TrackerSent {
    const found = this.matching(match, method).at(-1);
    if (found === undefined) {
      throw new Error(`no ${method ?? ''} request matching ${String(match)} was sent`);
    }
    return found;
  }

  install(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const sent: TrackerSent = {
          path: String(input),
          method: String(init?.method ?? 'GET'),
          body:
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : undefined,
          headers,
        };
        this.sent.push(sent);
        const index = this.routes.findIndex((route) => route.match(sent));
        if (index === -1) {
          return Promise.reject(new TypeError(`no route for ${sent.method} ${sent.path}`));
        }
        const route = this.routes[index]!;
        if (route.once) {
          this.routes.splice(index, 1);
        }
        const reply = route.respond(sent);
        const status = reply.status ?? 200;
        return Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(reply.headers ?? {}),
          text: () =>
            Promise.resolve(
              reply.body === undefined
                ? ''
                : typeof reply.body === 'string'
                  ? reply.body
                  : JSON.stringify(reply.body),
            ),
        } as Response);
      }),
    );
  }
}

function responder(reply: Reply | Responder): Responder {
  return typeof reply === 'function' ? reply : () => reply;
}

function matcher(match: string | RegExp, method?: string): (sent: TrackerSent) => boolean {
  const path =
    typeof match === 'string'
      ? (candidate: string) => candidate === match
      : (candidate: string) => match.test(candidate);
  return (sent) => path(sent.path) && (method === undefined || sent.method === method);
}

/**
 * The queue route as a real server answers it: an ETag per body, and a 304
 * when the request names the current one.
 */
export function queueRoute(views: () => QueueView): Responder {
  return (sent) => {
    const view = views();
    const etag = `"${hash(JSON.stringify(view))}"`;
    if (sent.headers['if-none-match'] === etag) {
      return { status: 304, headers: { etag } };
    }
    return { body: view, headers: { etag } };
  };
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
