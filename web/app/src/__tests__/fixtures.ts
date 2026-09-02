/**
 * Ledger records to render, and a `fetch` double to serve them.
 *
 * Neutral values only — this is a public MIT repository, and a test fixture is
 * the easiest place for a real hostname or a real address to be committed by
 * accident.
 */

import type {
  ArchivedHit,
  InfoResponse,
  LedgerEvent,
  PromptsResponse,
  RankedHit,
  SavedPrompt,
  SummariseResponse,
  Topic,
  TopicRecord,
} from '../api';

export const AUTHOR = 'alice@example.com';

export const TOPIC: Topic = {
  topic_id: 'rag-0009',
  type: 'decision',
  repo: 'rag',
  title: 'Serve the viewer from the same origin',
  summary: 'Whether to serve the SPA from `rag-serve` or from a host of its own.',
  current_state: 'Same origin. No CORS configuration exists, and none should be added.',
  status: 'accepted',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
  creator_email: AUTHOR,
  creator_agent: null,
  tags: ['web', 'deploy'],
  archived: false,
  archived_at: null,
};

export const EVENTS: LedgerEvent[] = [
  {
    event_id: 1,
    ts: '2026-01-02T03:04:05Z',
    author_email: 'agent@example.com',
    author_agent: 'Some Model 1',
    kind: 'note',
    body: 'Opened while sizing the work.',
    new_state: null,
    new_status: null,
    new_title: null,
    new_tags: null,
  },
  {
    event_id: 2,
    ts: '2026-01-03T03:04:05Z',
    author_email: AUTHOR,
    author_agent: null,
    kind: 'status_change',
    body: 'Agreed after the proxy question was settled.',
    new_state: 'Same origin.',
    new_status: 'accepted',
    new_title: null,
    new_tags: ['web', 'deploy'],
  },
];

export const RECORD: TopicRecord = {
  ...TOPIC,
  events: EVENTS,
  links: [{ rel: 'supersedes', other_topic_id: 'rag-0003' }],
};

export const RANKED: RankedHit = {
  corpus: 'ledger',
  repo: 'rag',
  rel_path: '',
  path: '',
  language: '',
  start_line: 0,
  end_line: 0,
  text: 'Serve the viewer from the same origin\n\nWhether to serve the SPA from rag-serve.',
  ann_score: 0.71,
  rerank_score: 0.93,
  topic_id: 'rag-0009',
  type: 'decision',
  status: 'accepted',
  title: 'Serve the viewer from the same origin',
};

export const ARCHIVED_HIT: ArchivedHit = {
  topic_id: 'rag-0002',
  type: 'investigation',
  status: 'wontfix',
  repo: 'rag',
  title: 'Whether to add a browse endpoint',
  summary: 'A zero-query listing for live topics.',
  current_state: 'Dropped — the archive already lists without a query.',
  updated_at: '2025-12-01T00:00:00Z',
  archived_at: '2025-12-02T00:00:00Z',
};

export function liveSearch(results: RankedHit[] = [RANKED]) {
  return {
    query: 'origin',
    top_k: 8,
    reranked: true,
    candidates: 40,
    timings: { embed_ms: 90, search_ms: 12, rerank_ms: 400, total_ms: 502 },
    results,
  };
}

export function archivedSearch(results: ArchivedHit[] = [ARCHIVED_HIT]) {
  return { query: '', archived: true as const, count: results.length, results };
}

/**
 * `GET /info`, with summarising switched on.
 *
 * The whole response, not the half this feature reads: a partial fixture would
 * let a component start depending on a field that happens to be absent here and
 * present in production, which is the wrong way round for a test to fail.
 */
export const INFO: InfoResponse = {
  collection: 'rag_corpus',
  points: 1200,
  embed_model: 'voyage-4-large',
  rerank_model: 'rerank-2.5',
  dimensions: 1024,
  over_fetch: 50,
  default_top_k: 8,
  qdrant_url: 'http://localhost:6334',
  retrieval_ready: true,
  summarise_ready: true,
  summarise_models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  summarise_default_model: 'claude-sonnet-5',
  summarise_system_prompt: 'Read and summarise succinctly, using bullet points where apt.',
};

/** The same, with whatever this test needs changed. */
export function info(overrides: Partial<InfoResponse> = {}): InfoResponse {
  return { ...INFO, ...overrides };
}

/**
 * `GET /prompts`, with a library of two.
 *
 * **The built-in default is deliberately not among them.** It comes from
 * `/info` and is not a file; a fixture that listed it here would be describing
 * a server that cannot exist, and would hide the bug where the UI starts
 * treating it as deletable.
 */
export const PROMPTS: SavedPrompt[] = [
  { name: 'Terse', body: 'One sentence. No bullets.' },
  { name: 'What changed', body: 'List only what changed, newest first.' },
];

/** The same, with whatever this test needs changed. */
export function prompts(overrides: Partial<PromptsResponse> = {}): PromptsResponse {
  return { configured: true, prompts: PROMPTS, ...overrides };
}

/** `POST /ledger/{id}/summarise`. Markdown, because bullet points are the point. */
export const SUMMARY: SummariseResponse = {
  summary: '- Served same-origin.\n- Decided once the proxy question was settled.',
  model: 'claude-sonnet-5',
  usage: { input_tokens: 1240, output_tokens: 96 },
  truncated: false,
};

// ---- The fetch double -------------------------------------------------------

export interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/**
 * A `fetch` stub that answers by path.
 *
 * Routes are matched in order by a predicate on the path, so a test can say
 * "any GET of a topic returns this record" once and then assert on what the
 * write actually sent — which is the thing worth checking.
 */
export class Server {
  readonly sent: Sent[] = [];
  private routes: Array<{
    match: (path: string) => boolean;
    status: number;
    body: unknown;
    once: boolean;
  }> = [];

  on(match: string | RegExp, body: unknown, status = 200): this {
    this.routes.push({ match: matcher(match), status, body, once: false });
    return this;
  }

  /** Answers once, then falls through to any later route for the same path. */
  onceOn(match: string | RegExp, body: unknown, status = 200): this {
    this.routes.unshift({ match: matcher(match), status, body, once: true });
    return this;
  }

  /** The most recent request, or the most recent one matching a path. */
  last(match?: string | RegExp): Sent {
    const test = match === undefined ? () => true : matcher(match);
    const found = [...this.sent].reverse().find((call) => test(call.path));
    if (found === undefined) {
      throw new Error(`no request matching ${String(match)} was sent`);
    }
    return found;
  }

  /** How many requests matched. */
  count(match: string | RegExp): number {
    const test = matcher(match);
    return this.sent.filter((call) => test(call.path)).length;
  }

  install(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        this.sent.push({
          path,
          method: String(init?.method ?? 'GET'),
          body:
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : undefined,
        });
        const index = this.routes.findIndex((route) => route.match(path));
        if (index === -1) {
          return Promise.reject(new TypeError(`no route for ${path}`));
        }
        const route = this.routes[index]!;
        if (route.once) {
          this.routes.splice(index, 1);
        }
        return Promise.resolve({
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          text: () =>
            Promise.resolve(
              typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
            ),
        } as Response);
      }),
    );
  }
}

function matcher(match: string | RegExp): (path: string) => boolean {
  return typeof match === 'string' ? (path) => path === match : (path) => match.test(path);
}
