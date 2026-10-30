/**
 * The item page, live: it follows its project's event feed
 * (`/tracker/{project}/events/ws`, JSON frames, every surface and kind) and
 * re-reads the ticket when an item event arrives, so an agent's write over MCP
 * shows without a reload. The feed's socket is the fake in `fakeSocket.ts`.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ItemView } from '../tracker/ItemView';
import { FEED_FALLBACK_MS } from '../tracker/useFeed';
import type { FeedEvent, Item } from '../tracker/types';
import { FakeWebSocket } from './fakeSocket';
import { mountAt } from './harness';
import { EVENTS, TrackerServer, item } from './trackerFixtures';

const ID = 'demo-t0002';
const PATH = `/tracker/items/${ID}`;

let server: TrackerServer;
let current: Item;

beforeEach(() => {
  current = item(ID, { title: 'Next up', body: 'The brief.', events: EVENTS });
  server = new TrackerServer();
  // Each read answers with the ticket as it stands now.
  server.on(PATH, () => ({ body: current }), 'GET');
  server.on(PATH, () => ({ body: current }), 'POST');
  server.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function open() {
  return mountAt('/projects/:project/ticket/:id', <ItemView />, {
    route: `/projects/demo/ticket/${ID}`,
  });
}

function event(target: string, overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    event_id: 10,
    ts: '2026-01-03T00:00:00Z',
    project: 'demo',
    target_kind: 'item',
    target_id: target,
    title: 'Next up',
    author_email: 'agent@example.com',
    agent: 'Some Model 1',
    surface: 'mcp',
    kind: 'edit',
    body: '',
    fields: {},
    before: null,
    ...overrides,
  };
}

function socket(): FakeWebSocket {
  const live = FakeWebSocket.live();
  if (live === undefined) {
    throw new Error('the page opened no feed');
  }
  return live;
}

/** The page's feed, once its effect has opened it (it can land after the first paint). */
const feed = () => waitFor(socket);

const reads = () => server.matching(PATH, 'GET').length;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('the item page, live', () => {
  afterEach(() => setVisibility('visible'));

  it('follows its project’s feed: every surface, every kind, drafts too, as JSON', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    const url = new URL(socket().url);
    expect(url.pathname).toBe('/tracker/demo/events/ws');
    expect(url.searchParams.get('surface')).toBe('any');
    expect(url.searchParams.get('kinds')).toBe('all');
    expect(url.searchParams.get('format')).toBe('json');
    // The feed leaves drafts out by default; the owner's page follows them.
    expect(url.searchParams.get('drafts')).toBe('true');
  });

  it('shows an agent’s write to the ticket without a reload', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    act(() => socket().open());

    current = { ...current, title: 'Renamed by an agent' };
    act(() => socket().send(event(ID, { fields: { title: 'Renamed by an agent' } })));
    expect(await screen.findByRole('heading', { name: 'Renamed by an agent' })).toBeInTheDocument();
  });

  it('re-reads after another ticket’s event too (a move changes its neighbours)', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    act(() => socket().open());
    await waitFor(() => expect(reads()).toBe(2));

    current = { ...current, prev_id: 'demo-t0009' };
    act(() => socket().send(event('demo-t0009', { kind: 'move' })));
    expect(await screen.findByRole('link', { name: 'demo-t0009' })).toBeInTheDocument();
  });

  it('reads once for a burst of events, and ignores other records', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    act(() => socket().open());
    await waitFor(() => expect(reads()).toBe(2));

    act(() => {
      socket().send(event(ID, { event_id: 11 }));
      socket().send(event(ID, { event_id: 12 }));
      socket().send(event('demo-t0005', { event_id: 13, kind: 'move' }));
      socket().send(event('specs/audio', { event_id: 14, target_kind: 'spec' }));
      socket().send('not a frame');
    });
    await waitFor(() => expect(reads()).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reads()).toBe(3);
  });

  it('re-reads when the feed opens, to cover what it missed', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    expect(reads()).toBe(1);

    current = { ...current, title: 'Changed before the feed opened' };
    act(() => socket().open());
    expect(
      await screen.findByRole('heading', { name: 'Changed before the feed opened' }),
    ).toBeInTheDocument();
  });

  it('keeps the page when a live read fails', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    act(() => socket().open());
    await waitFor(() => expect(reads()).toBe(2));

    server.onceOn(PATH, { status: 500, body: { error: 'boom' } }, 'GET');
    act(() => socket().send(event(ID)));
    await waitFor(() => expect(reads()).toBe(3));
    expect(screen.getByRole('heading', { name: 'Next up' })).toBeInTheDocument();
    expect(screen.queryByText(`Could not load ${ID}.`)).toBeNull();
  });

  it('edits against the ticket as it was opened, never sending back someone else’s change', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    act(() => socket().open());

    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });

    // An agent rewrites the body while the owner is in the dialog.
    current = { ...current, body: 'The agent’s brief.' };
    act(() => socket().send(event(ID, { fields: { body: 'The agent’s brief.' } })));
    await waitFor(() => expect(reads()).toBe(3));

    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Next up, renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      title: 'Next up, renamed',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('closes the feed while hidden and reopens it on return', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    const first = socket();
    act(() => first.open());

    act(() => setVisibility('hidden'));
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.live()).toBeUndefined();

    act(() => setVisibility('visible'));
    expect(socket()).not.toBe(first);
  });

  it('reconnects when the feed drops, and polls while it is down', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await feed();
    const first = socket();
    act(() => first.open());
    await waitFor(() => expect(reads()).toBe(2));

    // Down: the first retry is a second away.
    act(() => first.drop());
    expect(FakeWebSocket.live()).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const second = socket();
    expect(second).not.toBe(first);

    // That one fails to connect too; meanwhile the page polls.
    act(() => second.drop());
    await act(() => vi.advanceTimersByTimeAsync(FEED_FALLBACK_MS));
    expect(reads()).toBeGreaterThanOrEqual(3);
  });
});
