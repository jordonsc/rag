/**
 * The API client: the one module that talks to `rag-serve`.
 *
 * Two things here are worth more than the rest and are tested hardest.
 *
 * * **The `author_agent: null` guarantee.** A null agent is what files a write
 *   as a person's rather than an agent's, and it is invisible: populate it and
 *   nothing breaks, nothing warns, and the ledger simply starts attributing
 *   people's amendments to a robot. The type stops the obvious version of that
 *   mistake; these tests stop the rest.
 * * **The two response shapes.** `POST /ledger/search` answers with reranked
 *   vector hits or with plain SQLite rows depending on one flag in the request,
 *   and `GET /ledger/{id}` answers a retired id with a **200** carrying a
 *   redirect. Getting either wrong renders a page that looks empty rather than
 *   wrong.
 */

import { join } from 'node:path';

import {
  LedgerApiError,
  appendEvent,
  asApiError,
  authorFields,
  createTopic,
  creatorFields,
  getInfo,
  getTopic,
  isAbort,
  moveTopic,
  searchArchived,
  searchLedger,
  setArchived,
} from '../api';
import type { ArchivedHit, LedgerEvent, RankedHit, Topic, TopicRecord } from '../api';
import { SRC, matching, read, sourceFiles } from './sources';

// ---- Fixtures ---------------------------------------------------------------
//
// Neutral values throughout: this is a public repository, and a fixture is the
// easiest place for a real host or a real address to end up committed.

const AUTHOR = 'alice@example.com';

const TOPIC: Topic = {
  topic_id: 'rag-0009',
  type: 'decision',
  repo: 'rag',
  title: 'Serve the viewer from the same origin',
  summary: 'Whether to serve the SPA from rag-serve or a separate host.',
  current_state: 'Same origin. No CORS configuration exists.',
  status: 'accepted',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
  creator_email: AUTHOR,
  creator_agent: null,
  tags: ['web', 'deploy'],
  archived: false,
  archived_at: null,
};

const RECORD: TopicRecord = { ...TOPIC, events: [], links: [] };

const EVENT: LedgerEvent = {
  event_id: 4,
  ts: '2026-01-03T03:04:05Z',
  author_email: AUTHOR,
  author_agent: null,
  kind: 'note',
  body: 'Checked against the deployed unit.',
  new_state: null,
  new_status: null,
  new_title: null,
  new_tags: null,
};

const RANKED: RankedHit = {
  corpus: 'ledger',
  repo: 'rag',
  rel_path: '',
  path: '',
  language: '',
  start_line: 0,
  end_line: 0,
  text: 'Serve the viewer from the same origin\n\nWhether to serve…',
  ann_score: 0.71,
  rerank_score: 0.93,
  topic_id: 'rag-0009',
  type: 'decision',
  status: 'accepted',
  title: 'Serve the viewer from the same origin',
};

const ARCHIVED: ArchivedHit = {
  topic_id: 'rag-0002',
  type: 'investigation',
  status: 'wontfix',
  repo: 'rag',
  title: 'An abandoned spike',
  summary: 'Whether to add a browse endpoint.',
  current_state: 'Dropped.',
  updated_at: '2025-12-01T00:00:00Z',
  archived_at: '2025-12-02T00:00:00Z',
};

// ---- Fetch double -----------------------------------------------------------

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];

/** Answer the next request with this status and body text. */
function answer(status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.mocked(globalThis.fetch).mockImplementationOnce((path, init) => {
    const options = init ?? {};
    calls.push({
      path: String(path),
      method: String(options.method ?? 'GET'),
      body:
        typeof options.body === 'string'
          ? (JSON.parse(options.body) as Record<string, unknown>)
          : undefined,
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    } as Response);
  });
}

/** Answer by rejecting, the way a dead server or an abort does. */
function fail(cause: unknown): void {
  vi.mocked(globalThis.fetch).mockImplementationOnce(() => Promise.reject(cause));
}

const sent = (): Call => {
  const call = calls.at(-1);
  if (call === undefined) {
    throw new Error('no request was sent');
  }
  return call;
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Reads ------------------------------------------------------------------

describe('getTopic', () => {
  it('returns a topic record', async () => {
    answer(200, RECORD);
    const fetched = await getTopic('rag-0009');
    expect(fetched.kind).toBe('topic');
    expect(fetched.kind === 'topic' && fetched.record.topic_id).toBe('rag-0009');
    expect(sent()).toMatchObject({ path: '/ledger/rag-0009', method: 'GET' });
  });

  /**
   * The case a naive client renders as an empty page: the id was retired by a
   * move, and the server says so with a **200** and a pointer rather than a
   * 404. It is not a topic, it has no title, no summary and no events, and
   * anything that treats it as one shows a blank record for an id that is
   * perfectly good.
   */
  it('detects a moved id answered with a 200 pointer', async () => {
    answer(200, {
      moved: true,
      topic_id: 'rag-0009',
      moved_to: 'example-0004',
      moved_at: '2026-02-01T00:00:00Z',
      detail: 'Moved to wiki.',
    });
    const fetched = await getTopic('rag-0009');
    expect(fetched.kind).toBe('moved');
    expect(fetched.kind === 'moved' && fetched.pointer.moved_to).toBe('example-0004');
  });

  it('does not mistake a topic whose body lacks a moved key for a pointer', async () => {
    answer(200, RECORD);
    await expect(getTopic('rag-0009')).resolves.toMatchObject({ kind: 'topic' });
  });

  it('encodes the id into the path', async () => {
    answer(200, RECORD);
    await getTopic('rag 0009/../secret');
    expect(sent().path).toBe('/ledger/rag%200009%2F..%2Fsecret');
  });
});

describe('the two search shapes', () => {
  it('reads a live search as ranked hits', async () => {
    answer(200, {
      query: 'origin',
      top_k: 8,
      reranked: true,
      candidates: 40,
      timings: { embed_ms: 90, search_ms: 12, rerank_ms: 400, total_ms: 502 },
      results: [RANKED],
    });
    const response = await searchLedger({ query: 'origin' });
    expect(response.reranked).toBe(true);
    expect(response.results[0]?.topic_id).toBe('rag-0009');
    // The display label and the matched chunk are separate fields, and the
    // view depends on being able to tell them apart.
    expect(response.results[0]?.title).toBe('Serve the viewer from the same origin');
    expect(response.results[0]?.rerank_score).toBeCloseTo(0.93);
  });

  it('reads an archived search as plain rows', async () => {
    answer(200, { query: '', archived: true, count: 1, results: [ARCHIVED] });
    const response = await searchArchived();
    expect(response.archived).toBe(true);
    expect(response.count).toBe(1);
    expect(response.results[0]?.archived_at).toBe('2025-12-02T00:00:00Z');
    // No scores, no chunk text: an archived topic is out of the vector index.
    expect(response.results[0]).not.toHaveProperty('ann_score');
  });

  it('marks only the archived request with the flag', async () => {
    answer(200, { query: 'x', top_k: 8, reranked: false, candidates: 0, timings: {}, results: [] });
    await searchLedger({ query: 'x' });
    expect(sent().body).not.toHaveProperty('archived');

    answer(200, { query: '', archived: true, count: 0, results: [] });
    await searchArchived();
    expect(sent().body).toMatchObject({ archived: true, query: '' });
  });

  it('omits empty filters rather than sending them', async () => {
    answer(200, { query: 'x', top_k: 8, reranked: false, candidates: 0, timings: {}, results: [] });
    await searchLedger({ query: 'x', repo: '', top_k: 5, status: 'open' });
    expect(sent().body).toEqual({ query: 'x', top_k: 5, status: 'open' });
  });

  it('sends the archived query as a blank string when none is given', async () => {
    // The blank query is what makes the archive a listing rather than a
    // search — the server allows it on this path and rejects it on the other.
    answer(200, { query: '', archived: true, count: 0, results: [] });
    await searchArchived({ repo: 'rag' });
    expect(sent().body).toEqual({ archived: true, query: '', repo: 'rag' });
  });
});

describe('getInfo', () => {
  it('reads the server description', async () => {
    answer(200, { collection: 'corpus', points: 12, retrieval_ready: true });
    await expect(getInfo()).resolves.toMatchObject({ retrieval_ready: true });
    expect(sent()).toMatchObject({ path: '/info', method: 'GET' });
  });
});

// ---- Failure ----------------------------------------------------------------

describe('errors', () => {
  it("surfaces the server's own stated reason", async () => {
    answer(400, { error: 'query must not be empty' });
    const error = await searchLedger({ query: ' ' }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LedgerApiError);
    expect((error as LedgerApiError).message).toBe('query must not be empty');
    expect((error as LedgerApiError).status).toBe(400);
  });

  /**
   * The 422 is the odd one out and the reason `detail` exists at all. Axum
   * rejects a body that will not deserialise **before** the handler runs, so it
   * never gets the `{"error": …}` treatment every deliberate failure gets — it
   * comes back as framework prose in plain text. The client has to invent the
   * sentence, and has to keep the original, because the framework's text is
   * the only thing that names the missing field.
   */
  it('explains a 422 itself and keeps the framework text as detail', async () => {
    const raw = 'Failed to deserialize the JSON body into the target type: missing field `body`';
    answer(422, raw);
    const error = (await appendEvent('rag-0009', {
      ...authorFields(AUTHOR),
      body: 'a note',
    }).catch((cause: unknown) => cause)) as LedgerApiError;
    expect(error.status).toBe(422);
    expect(error.message).toContain('rejected before it reached the ledger');
    expect(error.message).not.toContain('deserialize');
    expect(error.detail).toBe(raw);
  });

  it('does not invent an error shape for a 422 that happens to be JSON', async () => {
    answer(422, { error: 'something else' });
    const error = (await getInfo().catch((cause: unknown) => cause)) as LedgerApiError;
    expect(error.message).toContain('rejected before it reached the ledger');
  });

  it('says so plainly when a failure states no reason', async () => {
    answer(500, 'upstream exploded');
    const error = (await getInfo().catch((cause: unknown) => cause)) as LedgerApiError;
    expect(error.message).toBe('The server answered 500 with no stated reason.');
    expect(error.detail).toBe('upstream exploded');
  });

  it('ignores an error key that is empty or not a string', async () => {
    answer(503, { error: '' });
    await expect(getInfo()).rejects.toMatchObject({
      message: 'The server answered 503 with no stated reason.',
      unavailable: true,
    });
  });

  it('reports an unreachable server as status 0', async () => {
    fail(new TypeError('Failed to fetch'));
    const error = (await getInfo().catch((cause: unknown) => cause)) as LedgerApiError;
    expect(error.status).toBe(0);
    expect(error.message).toBe('The server could not be reached.');
  });

  it('rethrows an abort untouched so a superseded request can be ignored', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    fail(abort);
    const error = await getInfo(new AbortController().signal).catch((cause: unknown) => cause);
    expect(error).toBe(abort);
    expect(isAbort(error)).toBe(true);
    expect(error).not.toBeInstanceOf(LedgerApiError);
  });

  it('reports a 200 that is not JSON rather than throwing a parse error', async () => {
    answer(200, '<!doctype html><title>index</title>');
    const error = (await getInfo().catch((cause: unknown) => cause)) as LedgerApiError;
    expect(error.message).toBe('The server answered with something that is not JSON.');
    expect(error.detail).toContain('doctype');
  });

  it('narrows an arbitrary rejection through asApiError', () => {
    const original = new LedgerApiError(404, 'no such topic');
    expect(asApiError(original)).toBe(original);
    const wrapped = asApiError(new Error('boom'));
    expect(wrapped).toBeInstanceOf(LedgerApiError);
    expect(wrapped.status).toBe(0);
    expect(wrapped.detail).toContain('boom');
  });
});

// ---- The author guarantee ---------------------------------------------------

describe('the author fields', () => {
  it('builds an author with a null agent and nothing else', () => {
    const fields = authorFields(AUTHOR);
    expect(fields).toEqual({ author_email: AUTHOR, author_agent: null });
    expect(Object.keys(fields).sort()).toEqual(['author_agent', 'author_email']);
    // Null, not undefined and not absent: the server distinguishes a person's
    // write from an agent's by this field being present and empty.
    expect(fields.author_agent).toBeNull();
    expect('author_agent' in fields).toBe(true);
  });

  it('names the pair creator_* for create, and only for create', () => {
    expect(creatorFields(AUTHOR)).toEqual({ creator_email: AUTHOR, creator_agent: null });
    expect(creatorFields(AUTHOR)).not.toHaveProperty('author_email');
    expect(authorFields(AUTHOR)).not.toHaveProperty('creator_email');
  });

  it('sends a null agent on every write that reaches the wire', async () => {
    answer(200, EVENT);
    await appendEvent('rag-0009', { ...authorFields(AUTHOR), body: 'a note' });
    expect(sent().body).toMatchObject({ author_email: AUTHOR, author_agent: null });

    answer(200, TOPIC);
    await setArchived('rag-0009', { ...authorFields(AUTHOR), archived: true });
    expect(sent().body).toMatchObject({ author_email: AUTHOR, author_agent: null });

    answer(200, TOPIC);
    await moveTopic('rag-0009', { ...authorFields(AUTHOR), repo: 'example' });
    expect(sent().body).toMatchObject({ author_email: AUTHOR, author_agent: null });

    answer(200, TOPIC);
    await createTopic({
      ...creatorFields(AUTHOR),
      type: 'decision',
      repo: 'rag',
      title: 'A title',
      summary: 'A summary',
      initial_state: 'Proposed.',
    });
    expect(sent().body).toMatchObject({ creator_email: AUTHOR, creator_agent: null });
    expect(sent().body).not.toHaveProperty('author_agent');
  });

  it('serialises the null agent rather than dropping it as undefined', async () => {
    answer(200, EVENT);
    await appendEvent('rag-0009', { ...authorFields(AUTHOR), body: 'a note' });
    const raw = JSON.stringify(sent().body);
    expect(raw).toContain('"author_agent":null');
  });

  /**
   * The structural half of the guarantee.
   *
   * Everything that performs a write spreads the gate's fields rather than
   * naming the author fields itself, so `authorFields` / `creatorFields` are
   * the only two places the pair is ever constructed. A form that assembled
   * `{ author_email, author_agent: 'ledger-ui' }` inline would compile — the
   * type only constrains what those two functions return — and would silently
   * file every human amendment as an agent's.
   */
  it('is the only place a write body names the author fields', () => {
    const writers = sourceFiles().filter(
      (path) =>
        path !== join(SRC, 'api', 'client.ts') &&
        /\b(appendEvent|createTopic|setArchived|moveTopic)\s*\(/.test(read(path)),
    );
    // Guards against the filter silently matching nothing.
    expect(writers.length).toBeGreaterThanOrEqual(4);

    for (const path of writers) {
      const source = read(path);
      expect({ path, hit: /author_agent|creator_agent/.test(source) }).toEqual({
        path,
        hit: false,
      });
      expect({ path, hit: /(author|creator)_email\s*:/.test(source) }).toEqual({
        path,
        hit: false,
      });
    }
  });

  /**
   * `summary` is the original framing and there is no `set_summary` on any
   * server path. The way it would be lost is a UI convenience: a "fix the
   * summary" field added here, and a `set_summary` added to the server to
   * serve it. Matching the field form (`set_summary:`) rather than the word
   * leaves the prose that explains the rule free to name it.
   */
  it('has no set_summary field on any path', () => {
    expect(matching(/set_summary\s*[:?]/)).toEqual([]);
  });
});

// ---- The last guard before a request leaves ---------------------------------

describe('client-side refusals', () => {
  it('refuses an append with no note, however much else it amends', async () => {
    await expect(
      appendEvent('rag-0009', {
        ...authorFields(AUTHOR),
        body: '   ',
        set_status: 'resolved',
      }),
    ).rejects.toMatchObject({ status: 0, message: expect.stringContaining('needs a note') });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses any write with no author address', async () => {
    const blank = { author_email: ' ', author_agent: null } as const;
    await expect(appendEvent('rag-0009', { ...blank, body: 'x' })).rejects.toBeInstanceOf(
      LedgerApiError,
    );
    await expect(setArchived('rag-0009', { ...blank, archived: true })).rejects.toBeInstanceOf(
      LedgerApiError,
    );
    await expect(moveTopic('rag-0009', { ...blank, repo: 'example' })).rejects.toBeInstanceOf(
      LedgerApiError,
    );
    await expect(
      createTopic({
        creator_email: '',
        creator_agent: null,
        type: 'defect',
        repo: 'rag',
        title: 'A title',
        summary: 'A summary',
        initial_state: 'Open.',
      }),
    ).rejects.toBeInstanceOf(LedgerApiError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /** A blank repo used to mint a topic called `-0001`. */
  it('refuses a create with a blank project', async () => {
    await expect(
      createTopic({
        ...creatorFields(AUTHOR),
        type: 'decision',
        repo: '   ',
        title: 'A title',
        summary: 'A summary',
        initial_state: 'Proposed.',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('A project is required') });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a create with no title or no summary', async () => {
    const base = {
      ...creatorFields(AUTHOR),
      type: 'decision' as const,
      repo: 'rag',
      initial_state: 'Proposed.',
    };
    await expect(createTopic({ ...base, title: ' ', summary: 'A summary' })).rejects.toBeInstanceOf(
      LedgerApiError,
    );
    await expect(createTopic({ ...base, title: 'A title', summary: ' ' })).rejects.toBeInstanceOf(
      LedgerApiError,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a move with no destination', async () => {
    await expect(
      moveTopic('rag-0009', { ...authorFields(AUTHOR), repo: '  ' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('destination project') });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * **The two calls that mint an id both refuse a project an id cannot hold.**
   * The forms check it too; this is the layer both of them funnel through, and
   * the one a future caller would reach without a form. A slash is the case
   * that cannot be recovered from: it mints an id `/topic/:id` can never match,
   * and on a move it retires the only id that could have been opened instead.
   */
  it.each(['wiki/docs', 'a project', 'proj?ect'])('refuses to mint an id from %j', async (repo) => {
    await expect(
      createTopic({
        ...creatorFields(AUTHOR),
        type: 'decision',
        repo,
        title: 'A title',
        summary: 'A summary',
        initial_state: 'Proposed.',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Letters, digits') });
    await expect(moveTopic('rag-0009', { ...authorFields(AUTHOR), repo })).rejects.toMatchObject({
      message: expect.stringContaining('Letters, digits'),
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows an archive restore with the flag the other way', async () => {
    answer(200, { ...TOPIC, archived: false });
    await setArchived('rag-0009', { ...authorFields(AUTHOR), archived: false });
    expect(sent()).toMatchObject({
      path: '/ledger/rag-0009/archive',
      method: 'POST',
      body: { archived: false },
    });
  });
});

describe('write endpoints', () => {
  it('posts each write to its own path', async () => {
    answer(200, EVENT);
    await appendEvent('rag-0009', { ...authorFields(AUTHOR), body: 'note' });
    expect(sent().path).toBe('/ledger/rag-0009/append');

    answer(200, TOPIC);
    await moveTopic('rag-0009', { ...authorFields(AUTHOR), repo: 'example' });
    expect(sent().path).toBe('/ledger/rag-0009/move');

    answer(200, TOPIC);
    await createTopic({
      ...creatorFields(AUTHOR),
      type: 'decision',
      repo: 'rag',
      title: 'A title',
      summary: 'A summary',
      initial_state: 'Proposed.',
    });
    expect(sent()).toMatchObject({ path: '/ledger', method: 'POST' });
  });

  it('returns the new id a move minted rather than the one it retired', async () => {
    answer(200, { ...TOPIC, topic_id: 'example-0004', repo: 'example' });
    const moved = await moveTopic('rag-0009', { ...authorFields(AUTHOR), repo: 'example' });
    expect(moved.topic_id).toBe('example-0004');
  });

  it('sends JSON with a content type', async () => {
    answer(200, EVENT);
    await appendEvent('rag-0009', { ...authorFields(AUTHOR), body: 'note' });
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });
});
