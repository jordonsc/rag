/**
 * The Roadmap tab (spec:roadmap m04, RM-41 to RM-44), against a `fetch` double:
 * the figures and their words, null ETAs included; the window pill being the
 * widget's own choice; released phases' progress; planned phases dragged and
 * moved by key; a server order that changes mid-drag; complete and archived
 * folded; Unarchive; an empty roadmap; New phase; the read's refresh and failure.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { iconRegistry } from '@rag/ui';

import { RoadmapView } from '../tracker/RoadmapView';
import type { Roadmap } from '../tracker/types';
import { ROADMAP_REFRESH_MS } from '../tracker/useRoadmap';
import { LIVE_SETTLE_MS } from '../tracker/useFeed';
import { FakeWebSocket } from './fakeSocket';
import { mountAt } from './harness';
import { TrackerServer, phaseFigures, phaseRecord, phaseSize, roadmap } from './trackerFixtures';

const READ = /^\/tracker\/demo\/roadmap\?window=/;
const WINDOW_KEY = 'rag.tracker.velocityWindow';

let server: TrackerServer;
let current: Roadmap;

const THREE_PLANNED = () =>
  roadmap({
    frozen: 7,
    planned: [
      phaseFigures('demo-p0001', {
        title: 'Creatures',
        size: phaseSize({ frozen: 4, drafts: 1, total: 5 }),
        ahead: 52,
        eta_days: 3.5,
      }),
      phaseFigures('demo-p0002', {
        title: 'Birds',
        size: phaseSize({ frozen: 2, total: 2 }),
        ahead: 54,
        eta_days: 3.75,
      }),
      phaseFigures('demo-p0003', {
        title: 'Fish',
        size: phaseSize({ frozen: 1, total: 1 }),
        ahead: 55,
        eta_days: null,
      }),
    ],
  });

beforeEach(() => {
  current = roadmap();
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
  server.on(READ, () => ({ body: current }), 'GET');
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function open(options: { identity?: string | null } = {}) {
  return mountAt('/projects/:project/roadmap', <RoadmapView />, {
    route: '/projects/demo/roadmap',
    ...options,
  });
}

/** The page, once its figures are in. */
async function ready() {
  await screen.findByRole('list', { name: 'Figures' });
}

function plannedIds(): string[] {
  return within(screen.getByRole('list', { name: 'Planned phases' }))
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('data-id') ?? '');
}

function reads(window?: string): number {
  return server.matching(window === undefined ? READ : `/tracker/demo/roadmap?window=${window}`)
    .length;
}

/** Rows stand 40 px apart, by their drawn index, for the drag geometry. */
function stubRowGeometry() {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = Number(this.dataset.index ?? 0);
    return {
      top: index * 40,
      bottom: index * 40 + 40,
      height: 40,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: index * 40,
      toJSON: () => ({}),
    };
  });
}

function socket(): FakeWebSocket {
  const live = FakeWebSocket.live();
  if (live === undefined) {
    throw new Error('the page opened no feed');
  }
  return live;
}

const feedEvent = (id = 1) => ({
  event_id: id,
  ts: '2026-01-03T00:00:00Z',
  project: 'demo',
  target_kind: 'phase',
  target_id: 'demo-p0001',
  title: 'Creatures',
  author_email: 'agent@example.com',
  agent: 'Some Model 1',
  surface: 'mcp',
  kind: 'edit',
  body: '',
  fields: {},
  before: null,
});

describe('the figures', () => {
  it('reads each figure in words, as the widget words it', async () => {
    current = roadmap({ frozen: 45, planned_out_days: 3, queue: { remaining: 48, eta_days: 1.6 } });
    open();
    await ready();
    const figures = screen.getByRole('list', { name: 'Figures' });
    for (const name of [
      'Queue ETA: 1.6 days',
      'Frozen: 45 tickets',
      'Planned out: 3 days',
      'Velocity: 8/day',
    ]) {
      expect(within(figures).getByRole('listitem', { name })).toBeInTheDocument();
    }
  });

  it('draws a null ETA as a dash and speaks it as unknown', async () => {
    current = roadmap({
      velocity_per_day: 0,
      queue: { remaining: 48, eta_days: null },
      planned_out_days: null,
    });
    open();
    await ready();
    const queue = screen.getByRole('listitem', { name: 'Queue ETA: unknown' });
    expect(queue).toHaveTextContent('—');
    expect(screen.getByRole('listitem', { name: 'Planned out: unknown' })).toHaveTextContent('—');
    expect(screen.getByRole('listitem', { name: 'Velocity: 0/day' })).toBeInTheDocument();
  });

  it('says one ticket in the singular', async () => {
    current = roadmap({ frozen: 1 });
    open();
    await ready();
    expect(screen.getByRole('listitem', { name: 'Frozen: 1 ticket' })).toBeInTheDocument();
  });

  it('explains each ETA as active work at this pace, never a date (D24)', async () => {
    open();
    await ready();
    for (const name of ['Queue ETA: 6 days', 'Planned out: 6 days']) {
      const title = screen.getByRole('listitem', { name }).getAttribute('title') ?? '';
      expect(title).toContain('days of active work at this pace');
      expect(title).toContain('takes longer in calendar days');
    }
  });

  it('shares the widget’s window: its key, and passing it to the read', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(reads('7d')).toBe(1);
    await user.click(
      within(screen.getByRole('radiogroup', { name: 'Velocity window' })).getByRole('radio', {
        name: '24 h',
      }),
    );
    await waitFor(() => expect(reads('24h')).toBe(1));
    expect(window.localStorage.getItem(WINDOW_KEY)).toBe('24h');
  });

  it('opens on the window the widget kept', async () => {
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      return key === WINDOW_KEY ? '24h' : real.call(this, key);
    });
    open();
    await ready();
    expect(reads('24h')).toBe(1);
    expect(reads('7d')).toBe(0);
  });
});

describe('released phases', () => {
  it('draws each in the answer’s order, linked, with done of total, open and its ETA', async () => {
    current = roadmap({
      released: [
        phaseFigures('demo-p0005', {
          title: 'Soon',
          state: 'released',
          size: phaseSize({ done: 3, open: 7, total: 10 }),
          eta_days: 1.6,
        }),
        phaseFigures('demo-p0004', {
          title: 'Later',
          state: 'released',
          size: phaseSize({ done: 0, open: 1, drafts: 1, total: 2 }),
          eta_days: null,
        }),
      ],
    });
    open();
    await ready();
    const rows = within(screen.getByRole('region', { name: 'Released' })).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual(['demo-p0005', 'demo-p0004']);
    expect(within(rows[0]!).getByRole('link', { name: 'Soon' })).toHaveAttribute(
      'href',
      '/projects/demo/roadmap/demo-p0005',
    );
    expect(rows[0]).toHaveTextContent('3 of 10 done');
    expect(rows[0]).toHaveTextContent('7 open');
    expect(rows[0]).toHaveTextContent('ETA 1.6 days');
    // The bar is the same 30 %, and a picture of the words beside it.
    const bar = rows[0]!.querySelector('[aria-hidden="true"] > span') as HTMLElement;
    expect(bar.style.width).toBe('30%');
    // Drawn as a dash, read as a word.
    expect(rows[1]).toHaveTextContent('ETA —unknown');
  });

  it('draws no bar past its end and no NaN for an empty phase', async () => {
    current = roadmap({
      released: [
        phaseFigures('demo-p0005', { title: 'Empty', state: 'released', size: phaseSize() }),
      ],
    });
    open();
    await ready();
    const row = within(screen.getByRole('region', { name: 'Released' })).getByRole('listitem');
    expect((row.querySelector('[aria-hidden="true"] > span') as HTMLElement).style.width).toBe(
      '0%',
    );
  });

  it('has no section with none', async () => {
    open();
    await ready();
    expect(screen.queryByRole('region', { name: 'Released' })).toBeNull();
  });
});

describe('planned phases', () => {
  it('draws title, frozen count, drafts only when any, and cumulative ETA', async () => {
    current = THREE_PLANNED();
    open();
    await ready();
    expect(plannedIds()).toEqual(['demo-p0001', 'demo-p0002', 'demo-p0003']);
    const row = (name: string) => screen.getByRole('listitem', { name }) as HTMLElement;
    const first = row('Phase demo-p0001: Creatures');
    expect(within(first).getByRole('link', { name: 'Creatures' })).toHaveAttribute(
      'href',
      '/projects/demo/roadmap/demo-p0001',
    );
    expect(first).toHaveTextContent('4 frozen');
    expect(first).toHaveTextContent('1 draft');
    expect(first).toHaveTextContent('ETA 3.5 days');
    expect(row('Phase demo-p0002: Birds')).not.toHaveTextContent('draft');
    expect(row('Phase demo-p0003: Fish')).toHaveTextContent('ETA —unknown');
  });

  it('never calls a frozen ticket queued, and says ticket, never item', async () => {
    current = {
      ...THREE_PLANNED(),
      archived: [phaseFigures('demo-p0009', { title: 'Old', state: 'archived' })],
    };
    open();
    await ready();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bqueued\b/i);
    expect(text).not.toMatch(/\bitems?\b/i);
  });

  it('turns a drag to the top into one move before the first, shown until the server answers', async () => {
    current = THREE_PLANNED();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubRowGeometry();
    server.on(
      /\/phases\/demo-p0003\/move$/,
      () => {
        return { body: phaseRecord('demo-p0003') };
      },
      'POST',
    );
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/move')
        ? held.then(() => realFetch(input, init))
        : realFetch(input, init),
    );
    open();
    await ready();

    const grip = screen.getByRole('button', { name: 'Drag demo-p0003 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 4 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 4 });

    // Dropped: drawn in its new place, and the grips off while it is saved.
    await waitFor(() => expect(plannedIds()[0]).toBe('demo-p0003'));
    expect(screen.getByRole('button', { name: 'Drag demo-p0001 to reorder' })).toBeDisabled();

    await act(async () => release());
    await waitFor(() =>
      expect(server.last(/\/move$/).body).toEqual({
        before: 'demo-p0001',
        author_email: 'alice@example.com',
        surface: 'web',
      }),
    );
    // The server's order again: this double did not change it.
    await waitFor(() => expect(plannedIds()[0]).toBe('demo-p0001'));
  });

  it('turns a drag lower into one move after the row above', async () => {
    current = THREE_PLANNED();
    stubRowGeometry();
    server.on(/\/move$/, { body: phaseRecord('demo-p0001') }, 'POST');
    open();
    await ready();
    const grip = screen.getByRole('button', { name: 'Drag demo-p0001 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'touch', clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 65 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 65 });
    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).path).toBe('/tracker/demo/phases/demo-p0001/move');
    expect(server.last(/\/move$/).body).toMatchObject({ after: 'demo-p0002' });
  });

  it('sends nothing for a drag that lands where it started, or is cancelled', async () => {
    current = THREE_PLANNED();
    stubRowGeometry();
    open();
    await ready();
    const grip = screen.getByRole('button', { name: 'Drag demo-p0002 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 62 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 62 });

    fireEvent.pointerDown(grip, { pointerId: 2, button: 0, pointerType: 'mouse', clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 2, clientY: 110 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 110 });
    expect(server.matching(/\/move$/)).toHaveLength(0);
  });

  it('moves with Alt+↓ after the row below, and Alt+↑ before the row above', async () => {
    current = THREE_PLANNED();
    server.on(/\/move$/, { body: phaseRecord('demo-p0002') }, 'POST');
    open();
    await ready();
    const row = screen.getByRole('listitem', { name: 'Phase demo-p0002: Birds' });

    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).body).toMatchObject({ after: 'demo-p0003' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Drag demo-p0002 to reorder' })).toBeEnabled(),
    );

    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Phase demo-p0002: Birds' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(2));
    expect(server.last(/\/move$/).body).toMatchObject({ before: 'demo-p0001' });
  });

  it('does not move the top row up or the bottom row down', async () => {
    current = THREE_PLANNED();
    open();
    await ready();
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Phase demo-p0001: Creatures' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Phase demo-p0003: Fish' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(server.matching(/\/move$/)).toHaveLength(0);
  });

  it('cancels a drag when the server’s order changes under it, and says so', async () => {
    current = THREE_PLANNED();
    stubRowGeometry();
    open();
    await ready();
    await waitFor(socket);
    act(() => socket().open());

    const grip = screen.getByRole('button', { name: 'Drag demo-p0003 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 4 });

    const [a, b, c] = current.planned;
    current = { ...current, planned: [b!, a!, c!] };
    act(() => socket().send(feedEvent()));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The roadmap changed while you were dragging',
    );
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 4 });
    expect(server.matching(/\/move$/)).toHaveLength(0);
    expect(plannedIds()).toEqual(['demo-p0002', 'demo-p0001', 'demo-p0003']);
  });

  it('keeps a drag through a read that only changes the figures', async () => {
    current = THREE_PLANNED();
    stubRowGeometry();
    server.on(/\/move$/, { body: phaseRecord('demo-p0003') }, 'POST');
    open();
    await ready();
    await waitFor(socket);
    act(() => socket().open());
    await waitFor(() => expect(reads()).toBe(2));

    const grip = screen.getByRole('button', { name: 'Drag demo-p0003 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 4 });

    current = { ...current, velocity_per_day: 9 };
    act(() => socket().send(feedEvent()));
    await screen.findByRole('listitem', { name: 'Velocity: 9/day' });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.pointerUp(window, { pointerId: 1, clientY: 4 });
    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
  });

  it('shows a refused move in the server’s words, with the server’s order', async () => {
    current = THREE_PLANNED();
    server.on(
      /\/move$/,
      { status: 400, body: { error: 'demo-p0002 is released: only a planned phase moves.' } },
      'POST',
    );
    open();
    await ready();
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Phase demo-p0002: Birds' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('only a planned phase moves.');
    expect(alert).toHaveTextContent('The list shows the server’s order.');
    await waitFor(() => expect(plannedIds()[1]).toBe('demo-p0002'));
  });

  it('prompts for an identity rather than moving, the control still enabled', async () => {
    current = THREE_PLANNED();
    open({ identity: null });
    await ready();
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Phase demo-p0002: Birds' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(await screen.findByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(server.matching(/\/move$/)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Drag demo-p0002 to reorder' })).toBeEnabled();
  });
});

describe('an empty roadmap', () => {
  it('says what a phase is, offers New phase, and calls the tickets frozen', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const planned = screen.getByRole('region', { name: 'Planned' });
    expect(within(planned).getByText('No planned phases')).toBeInTheDocument();
    expect(within(planned).getByText(/its tickets are frozen/)).toBeInTheDocument();
    await user.click(within(planned).getByRole('button', { name: 'New phase' }));
    expect(screen.getByRole('dialog', { name: 'New phase' })).toBeInTheDocument();
  });
});

describe('complete and archived', () => {
  beforeEach(() => {
    current = roadmap({
      complete: [
        phaseFigures('demo-p0007', {
          title: 'Finished',
          state: 'released',
          size: phaseSize({ done: 4, cancelled: 1, total: 5, complete: true }),
        }),
      ],
      archived: [
        phaseFigures('demo-p0008', { title: 'Dropped', state: 'archived' }),
        phaseFigures('demo-p0009', {
          title: 'Shelved',
          state: 'archived',
          released_at: '2026-01-01T00:00:00Z',
        }),
      ],
    });
  });

  it('folds each behind its count until asked', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.queryByRole('link', { name: 'Finished' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Dropped' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Complete (1)' }));
    expect(screen.getByRole('link', { name: 'Finished' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Complete' })).toHaveTextContent('4 of 5 done');
    expect(screen.getByRole('list', { name: 'Complete' })).toHaveTextContent('1 cancelled');
    // Complete is no archive: it has nothing to unarchive.
    expect(screen.queryByRole('button', { name: /^Unarchive/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Archived (2)' }));
    expect(screen.getByRole('link', { name: 'Dropped' })).toBeInTheDocument();
  });

  it('has neither fold with none in it', async () => {
    current = roadmap();
    open();
    await ready();
    expect(screen.queryByRole('button', { name: /^Complete/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });

  it('unarchives from the row, saying where it goes, and re-reads', async () => {
    const user = userEvent.setup();
    server.on(/\/unarchive$/, { body: phaseRecord('demo-p0008') }, 'POST');
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Archived (2)' }));

    await user.click(screen.getByRole('button', { name: 'Unarchive Shelved' }));
    let dialog = screen.getByRole('dialog', { name: 'Unarchive this phase?' });
    expect(dialog).toHaveTextContent('back to being a released phase');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.matching(/\/unarchive$/)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Unarchive Dropped' }));
    dialog = screen.getByRole('dialog', { name: 'Unarchive this phase?' });
    expect(dialog).toHaveTextContent('at the bottom, as a planned phase');
    const before = reads();
    await user.click(within(dialog).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(server.matching(/\/unarchive$/)).toHaveLength(1));
    expect(server.last(/\/unarchive$/).path).toBe('/tracker/demo/phases/demo-p0008/unarchive');
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('prompts for an identity rather than opening Unarchive', async () => {
    const user = userEvent.setup();
    open({ identity: null });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Archived (2)' }));
    await user.click(screen.getByRole('button', { name: 'Unarchive Dropped' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Unarchive this phase?' })).toBeNull();
  });
});

describe('New phase', () => {
  it('creates it with a title and a body and opens its page', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/phases', { body: phaseRecord('demo-p0012') }, 'POST');
    open();
    await ready();
    await user.click(screen.getAllByRole('button', { name: 'New phase' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'New phase' });
    await user.type(within(dialog).getByLabelText('Title'), 'Creatures');
    await user.type(within(dialog).getByLabelText('Body'), 'Things that move.');
    await user.click(within(dialog).getByRole('button', { name: 'Add to the roadmap' }));
    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/roadmap/demo-p0012'),
    );
    expect(server.last('/tracker/demo/phases', 'POST').body).toEqual({
      title: 'Creatures',
      body: 'Things that move.',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('sends nothing without a title, and says so', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getAllByRole('button', { name: 'New phase' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'New phase' });
    await user.click(within(dialog).getByRole('button', { name: 'Add to the roadmap' }));
    expect(within(dialog).getByText('A phase needs a title.')).toBeInTheDocument();
    expect(server.matching('/tracker/demo/phases', 'POST')).toHaveLength(0);
  });

  it('keeps the server’s refusal in the dialog', async () => {
    const user = userEvent.setup();
    server.on(
      '/tracker/demo/phases',
      { status: 400, body: { error: 'Refused, plainly.' } },
      'POST',
    );
    open();
    await ready();
    await user.click(screen.getAllByRole('button', { name: 'New phase' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'New phase' });
    await user.type(within(dialog).getByLabelText('Title'), 'Creatures');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Refused, plainly.');
  });

  it('asks who is writing rather than writing', async () => {
    const user = userEvent.setup();
    open({ identity: null });
    await ready();
    await user.click(screen.getAllByRole('button', { name: 'New phase' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'New phase' });
    await user.click(within(dialog).getByRole('button', { name: 'Set your email' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(server.matching('/tracker/demo/phases', 'POST')).toHaveLength(0);
  });
});

describe('the read (RM-42)', () => {
  it('shows an error state on a first failure, with Retry, and the tabs still there', async () => {
    const user = userEvent.setup();
    server.onceOn(READ, { status: 500, body: { error: 'The store is down.' } });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('The store is down.');
    expect(screen.getByRole('navigation', { name: 'demo pages' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Retry/i }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the last figures when a later read fails, and says so', async () => {
    open();
    await ready();
    await waitFor(socket);
    server.onceOn(READ, { status: 500, body: { error: 'The store is down.' } });
    act(() => socket().open());
    expect(await screen.findByRole('status')).toHaveTextContent('Could not refresh');
    expect(screen.getByRole('listitem', { name: 'Queue ETA: 6 days' })).toBeInTheDocument();
  });

  it('asks the feed for roadmap events, and reads once for a burst of them', async () => {
    current = THREE_PLANNED();
    open();
    await ready();
    await waitFor(socket);
    expect(new URL(socket().url).searchParams.get('roadmap')).toBe('true');
    act(() => socket().open());
    await waitFor(() => expect(reads()).toBe(2));

    current = { ...current, frozen: 8 };
    act(() => {
      socket().send(feedEvent(1));
      socket().send(feedEvent(2));
      socket().send(feedEvent(3));
    });
    await screen.findByRole('listitem', { name: 'Frozen: 8 tickets' });
    await new Promise((resolve) => setTimeout(resolve, LIVE_SETTLE_MS + 50));
    expect(reads()).toBe(3);
  });

  it('re-reads every 60 s while visible, and not while hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await ready();
    const before = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROADMAP_REFRESH_MS);
    });
    expect(reads()).toBe(before + 1);

    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('hidden');
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROADMAP_REFRESH_MS * 2);
      });
      expect(reads()).toBe(before + 1);
    } finally {
      setVisibility('visible');
    }
    await waitFor(() => expect(reads()).toBe(before + 2));
  });
});

describe('the tab (RM-41)', () => {
  it('marks itself on its own page, and is under /projects, not /tracker', async () => {
    open();
    await ready();
    const tabs = screen.getByRole('navigation', { name: 'demo pages' });
    const tab = within(tabs).getByRole('link', { name: 'Roadmap' });
    expect(tab).toHaveAttribute('aria-current', 'page');
    expect(tab).toHaveAttribute('href', '/projects/demo/roadmap');
  });

  it('has its glyph: a name the registry does not hold is a silent grey circle', () => {
    expect(iconRegistry.map).toBeDefined();
  });

  it('is on every project page, through the one switch', () => {
    const dir = resolve(__dirname, '../tracker');
    for (const file of ['QueueView.tsx', 'DocsView.tsx', 'HistoryView.tsx', 'RoadmapView.tsx']) {
      expect(readFileSync(resolve(dir, file), 'utf8'), file).toMatch(/<ProjectTabs\b/);
    }
  });

  it('wraps within its column, so four tabs never scroll a phone sideways', () => {
    // jsdom has no layout, so this pins the rule rather than a width. Measured in
    // Chromium: 402 px on one line at full padding, 326 px with the phone rule.
    const sheet = readFileSync(resolve(__dirname, '../tracker/docs.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const body = (css: string, selector: string) =>
      new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const track = body(sheet, 'projectTabs');
    expect(track).toMatch(/flex-wrap:\s*wrap;/);
    expect(track).toMatch(/max-width:\s*100%;/);
    expect(track).not.toMatch(/nowrap|min-width|overflow-x/);

    const phone = /@media \(max-width: 40rem\) \{([\s\S]*?)\n\}/.exec(sheet)?.[1] ?? '';
    expect(body(phone, 'projectTabs')).toMatch(/gap:\s*var\(--rag-space-1\) 0;/);
    expect(body(phone, 'projectTab')).toMatch(/padding:\s*0 var\(--rag-space-1\);/);
  });

  it('refuses a project name the server would refuse, before any read', () => {
    mountAt('/projects/:project/roadmap', <RoadmapView />, { route: '/projects/items/roadmap' });
    expect(screen.getByRole('alert')).toHaveTextContent('“items” is not a project name.');
    expect(server.matching(READ)).toHaveLength(0);
  });
});
