/**
 * A phase's page (spec:roadmap m04, RM-45, RM-46), against a `fetch` double: its
 * title and body edited with Ctrl+S; frozen rows sortable with no Defer; Add ticket
 * sending `phase` and keeping its text per phase; released rows grouped; Release's
 * and Recall's words, counts and warnings; what the answer said replacing them;
 * Archive refused in the server's words; the author gate.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { phaseEditBody, PhaseView } from '../tracker/PhaseView';
import type { Item, PhaseRecord, TrackerEvent } from '../tracker/types';
import { FakeWebSocket } from './fakeSocket';
import { mountAt } from './harness';
import {
  EVENTS,
  TrackerServer,
  frozenItem,
  gateItem,
  item,
  phaseRecord,
  phaseSize,
} from './trackerFixtures';

const ID = 'demo-p0001';
const URL_BASE = `/tracker/demo/phases/${ID}`;
const READ = `${URL_BASE}?tickets=true&history=true`;

let server: TrackerServer;
let current: PhaseRecord;

const FROZEN = (): Item[] => [
  frozenItem('demo-t0001', { title: 'First', next_id: 'demo-t0002' }),
  frozenItem('demo-t0002', { title: 'Second', prev_id: 'demo-t0001', next_id: 'demo-t0003' }),
  frozenItem('demo-t0003', { title: 'A draft of it', prev_id: 'demo-t0002', draft: true }),
];

function planned(overrides: Partial<PhaseRecord> = {}): PhaseRecord {
  return phaseRecord(ID, {
    tickets: FROZEN(),
    size: phaseSize({ frozen: 2, drafts: 1, total: 3 }),
    ...overrides,
  });
}

function released(tickets: Item[], overrides: Partial<PhaseRecord> = {}): PhaseRecord {
  return phaseRecord(ID, {
    state: 'released',
    released_at: '2026-01-05T00:00:00Z',
    tickets,
    size: phaseSize({ open: tickets.length, total: tickets.length }),
    ...overrides,
  });
}

beforeEach(() => {
  current = planned();
  server = new TrackerServer();
  server.on(READ, () => ({ body: current }), 'GET');
  server.on(URL_BASE, () => ({ body: current }), 'POST');
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(options: { identity?: string | null; id?: string } = {}) {
  const { id = ID, identity } = options;
  return mountAt('/projects/:project/roadmap/:id', <PhaseView />, {
    route: `/projects/demo/roadmap/${id}`,
    ...(identity === undefined ? {} : { identity }),
  });
}

/** The page, once the phase is in. */
async function ready(title = 'Creatures') {
  await screen.findByRole('heading', { name: title, level: 1 });
}

function outcome(overrides: Record<string, unknown> = {}) {
  return { ...current, moved: 2, placed: 'bottom', waiting: [], ...overrides };
}

describe('the page', () => {
  it('draws the title, the state, the body, and a way back to the roadmap', async () => {
    current = planned({ body: 'What **this** phase is for.' });
    open();
    await ready();
    expect(screen.getByText('Planned')).toBeInTheDocument();
    expect(screen.getByText('this').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'demo roadmap' })).toHaveAttribute(
      'href',
      '/projects/demo/roadmap',
    );
  });

  it.each([
    [1, '3 in all, 1 draft'],
    [2, '3 in all, 2 drafts'],
  ])('counts %i drafts in the right number', async (drafts, words) => {
    current = planned({ size: phaseSize({ frozen: 2, drafts, total: 3 }) });
    open();
    await ready();
    const count = screen.getByText('Tickets', { selector: 'dt' }).nextElementSibling;
    // Exactly: as a substring, "1 draft" is found in "1 drafts" too.
    expect(count?.textContent).toBe(words);
  });

  it('renders an attached image, as the ticket page renders a body', async () => {
    current = planned({ body: '![plan](att:3fa9c2e1b07d)' });
    open();
    await ready();
    expect(screen.getByRole('img', { name: 'plan' })).toHaveAttribute(
      'src',
      '/tracker/attachments/3fa9c2e1b07d',
    );
  });

  it('names a phase that does not exist here, a phase of another project alike', async () => {
    server.on(`/tracker/demo/phases/other-p0001?tickets=true&history=true`, {
      status: 404,
      body: { error: 'no phase "other-p0001" in project demo' },
    });
    open({ id: 'other-p0001' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('There is no phase other-p0001 in demo.');
    expect(alert).toHaveTextContent('no phase "other-p0001" in project demo');
  });

  it('says ticket, never item, and frozen, never queued, of a frozen ticket', async () => {
    open();
    await ready();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bitems?\b/i);
    expect(text).not.toMatch(/\bqueued\b/i);
  });

  it('follows the feed, roadmap events included, for one read a burst', async () => {
    open();
    await ready();
    const socket = await waitFor(() => {
      const live = FakeWebSocket.live();
      if (live === undefined) {
        throw new Error('no feed');
      }
      return live;
    });
    expect(new URL(socket.url).searchParams.get('roadmap')).toBe('true');
    act(() => socket.open());
    await waitFor(() => expect(server.matching(READ)).toHaveLength(2));

    current = { ...current, title: 'Renamed by an agent' };
    act(() => {
      socket.send({ event_id: 1, target_kind: 'phase', target_id: ID });
      socket.send({ event_id: 2, target_kind: 'item', target_id: 'demo-t0001' });
    });
    await ready('Renamed by an agent');
    expect(server.matching(READ)).toHaveLength(3);
  });
});

describe('editing', () => {
  it('sends only what changed, and Save closes', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Beasts');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.matching(URL_BASE, 'POST')).toHaveLength(1));
    expect(server.last(URL_BASE, 'POST').body).toEqual({
      title: 'Beasts',
      author_email: 'alice@example.com',
      surface: 'web',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('saves on the spot with Ctrl+S and stays open, the next save sending only what is new', async () => {
    const user = userEvent.setup();
    server.onceOn(URL_BASE, () => ({ body: { ...current, body: 'New body.' } }), 'POST');
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    const body = within(dialog).getByLabelText('Body');
    await user.clear(body);
    await user.type(body, 'New body.');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(server.matching(URL_BASE, 'POST')).toHaveLength(1));
    expect(server.last(URL_BASE, 'POST').body).toMatchObject({ body: 'New body.' });
    expect(screen.getByRole('dialog', { name: `Edit ${ID}` })).toBeInTheDocument();

    // It now compares against what was saved: nothing is new, so nothing is sent.
    await within(dialog).findByText('Saved.');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(server.matching(URL_BASE, 'POST')).toHaveLength(1);
  });

  it('does nothing on Ctrl+S with nothing changed or a blank title', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await user.clear(within(dialog).getByLabelText('Title'));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(server.matching(URL_BASE, 'POST')).toHaveLength(0);
  });

  it('diffs against the phase as it opened, so another’s change is not sent back', () => {
    const opened = { title: 'Creatures', body: 'Body' };
    expect(phaseEditBody(opened, 'Creatures', 'Body')).toEqual({});
    expect(phaseEditBody(opened, ' Beasts ', 'Body')).toEqual({ title: 'Beasts' });
    expect(phaseEditBody(opened, 'Creatures', 'Other')).toEqual({ body: 'Other' });
  });

  it('prompts for an identity rather than opening the editor', async () => {
    const user = userEvent.setup();
    open({ identity: null });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
  });
});

describe('frozen tickets', () => {
  it('lists those with frozen, in the server’s order, named for what they are', async () => {
    current = planned({
      tickets: [...FROZEN(), item('demo-t0009', { phase: ID, title: 'Pulled' })],
    });
    open();
    await ready();
    const rows = within(screen.getByRole('list', { name: 'Frozen tickets' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual([
      'demo-t0001',
      'demo-t0002',
      'demo-t0003',
    ]);
    // A pulled one is in the queue, and said apart.
    expect(screen.getByRole('heading', { name: 'In the queue or finished 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pulled' })).toBeInTheDocument();
  });

  it('draws no chip for the phase on its own rows', async () => {
    open();
    await ready();
    expect(screen.queryByRole('link', { name: ID })).toBeNull();
  });

  it('shows a draft and a block on the row', async () => {
    current = planned({
      tickets: [
        frozenItem('demo-t0001', { title: 'One', draft: true }),
        frozenItem('demo-t0002', {
          title: 'Two',
          blocked: true,
          block_reason: 'dependency',
          depends_on: ['demo-t0007'],
        }),
      ],
    });
    open();
    await ready();
    const rows = within(screen.getByRole('list', { name: 'Frozen tickets' })).getAllByRole(
      'listitem',
    );
    expect(rows[0]).toHaveTextContent('Draft');
    expect(rows[1]).toHaveTextContent('Waits on tickets');
    expect(within(rows[1]!).getByRole('link', { name: 'demo-t0007' })).toBeInTheDocument();
  });

  it('marks a frozen gate that is a draft or blocked; a plain one says neither', async () => {
    current = planned({
      tickets: [
        gateItem('demo-t0001', { frozen: true, queued: false, phase: ID, draft: true }),
        gateItem('demo-t0002', {
          frozen: true,
          queued: false,
          phase: ID,
          blocked: true,
          block_reason: 'review',
        }),
        gateItem('demo-t0003', { frozen: true, queued: false, phase: ID }),
      ],
    });
    open();
    await ready();
    const marker = (id: string) =>
      screen.getByRole('listitem', { name: `Gate ${id}: Standard gate` });
    expect(within(marker('demo-t0001')).getByText('Draft').closest('[title]')).toHaveAttribute(
      'title',
      expect.stringContaining('A draft'),
    );
    expect(within(marker('demo-t0001')).queryByText('Blocked')).toBeNull();
    expect(within(marker('demo-t0002')).getByText('Blocked')).toBeInTheDocument();
    expect(within(marker('demo-t0002')).queryByText('Draft')).toBeNull();
    expect(within(marker('demo-t0003')).queryByText('Draft')).toBeNull();
    expect(within(marker('demo-t0003')).queryByText('Blocked')).toBeNull();
  });

  it('moves one by key within the phase, after the row below', async () => {
    server.on(/\/move$/, { body: frozenItem('demo-t0001') }, 'POST');
    open();
    await ready();
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Ticket demo-t0001: First' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).path).toBe('/tracker/items/demo-t0001/move');
    expect(server.last(/\/move$/).body).toEqual({
      after: 'demo-t0002',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('says a refused move in the server’s words', async () => {
    server.on(
      /\/move$/,
      { status: 400, body: { error: 'demo-t0002 is not in phase demo-p0001.' } },
      'POST',
    );
    open();
    await ready();
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Ticket demo-t0001: First' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('is not in phase demo-p0001.');
  });

  it('offers no Defer (D5), and Make draft on a published row only', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0001' }));
    const names = screen.getAllByRole('menuitem').map((entry) => entry.textContent);
    expect(names).toEqual(['Open', 'Move to top', 'Move to bottom', 'Make draft', 'Remove']);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0003' }));
    const draft = screen.getAllByRole('menuitem').map((entry) => entry.textContent);
    expect(draft).toEqual(['Open', 'Move to top', 'Move to bottom', 'Publish', 'Remove']);
  });

  it('publishes a frozen draft, saying it stays frozen', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0003', { body: frozenItem('demo-t0003') }, 'POST');
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0003' }));
    await user.click(screen.getByRole('menuitem', { name: 'Publish' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish this ticket?' });
    expect(dialog).toHaveTextContent('It stays frozen');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(server.last('/tracker/items/demo-t0003', 'POST').body).toMatchObject({ draft: false }),
    );
  });

  it('removes one by cancelling it', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0001', { body: frozenItem('demo-t0001') }, 'POST');
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0001' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(server.last('/tracker/items/demo-t0001', 'POST').body).toMatchObject({
        status: 'cancelled',
      }),
    );
  });

  it('says so with none', async () => {
    current = phaseRecord(ID);
    open();
    await ready();
    expect(screen.getByText('No frozen tickets')).toBeInTheDocument();
  });
});

describe('adding to it', () => {
  it('sends `phase` with a ticket, and says it joins this phase', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: frozenItem('demo-t0011') }, 'POST');
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Wings');
    await user.click(within(dialog).getByRole('button', { name: 'Add to this phase' }));
    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toMatchObject({
      type: 'dev',
      title: 'Wings',
      phase: ID,
    });
  });

  it('sends `phase` with a gate', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: gateItem('demo-t0011') }, 'POST');
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add gate' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a gate' });
    await user.click(within(dialog).getByRole('button', { name: 'Add to this phase' }));
    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toMatchObject({
      type: 'gate',
      phase: ID,
    });
  });

  it('keeps unsent text per phase, apart from the queue’s', async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Wings');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(window.localStorage.getItem(`rag.tracker.kept:demo:new-item-${ID}:title`)).toBe('Wings');
    expect(window.localStorage.getItem('rag.tracker.kept:demo:new-item:title')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Add a ticket' })).getByLabelText('Title'),
    ).toHaveValue('Wings');
  });

  it('adds to a released phase too, straight into the queue, and says so', async () => {
    const user = userEvent.setup();
    current = released([item('demo-t0001', { phase: ID })]);
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Add a ticket' })).getByRole('button', {
        name: 'Add to the bottom of the queue',
      }),
    ).toBeInTheDocument();
  });

  it('offers neither on an archived phase, which refuses them', async () => {
    current = phaseRecord(ID, { state: 'archived', tickets: [] });
    open();
    await ready();
    expect(screen.queryByRole('button', { name: 'Add ticket' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add gate' })).toBeNull();
  });
});

describe('released tickets', () => {
  const MIXED = () => [
    item('demo-t0001', { phase: ID, title: 'Working', status: 'in_progress' }),
    item('demo-t0002', { phase: ID, title: 'Looked at', status: 'review' }),
    item('demo-t0003', { phase: ID, title: 'Waiting' }),
    item('demo-t0004', { phase: ID, title: 'Waiting too' }),
    item('demo-t0005', {
      phase: ID,
      title: 'Stuck',
      blocked: true,
      block_reason: 'review',
      block_note: 'Needs a look.',
    }),
    item('demo-t0006', { phase: ID, title: 'Aside', status: 'deferred' }),
    item('demo-t0007', { phase: ID, title: 'Broke', status: 'failed' }),
    item('demo-t0008', {
      phase: ID,
      title: 'Finished',
      status: 'done',
      queued: false,
      done_at: '2026-01-03T00:00:00Z',
    }),
    item('demo-t0009', { phase: ID, title: 'Dropped', status: 'cancelled', queued: false }),
  ];

  it('groups them by status, in order, each with a count', async () => {
    current = released(MIXED());
    open();
    await ready();
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual(['In progress', 'Review', 'Failed', 'Pending', 'Blocked', 'Deferred']);
    const pending = screen.getByRole('region', { name: 'Pending' });
    expect(within(pending).getByRole('heading', { name: 'Pending 2' })).toBeInTheDocument();
    expect(within(pending).getByRole('link', { name: 'Waiting' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Blocked' })).toHaveTextContent('Needs a look.');
    // A failed ticket has a home: it is still in the queue.
    expect(screen.getByRole('region', { name: 'Failed' })).toHaveTextContent('Broke');
  });

  it('folds Done and Cancelled behind their counts', async () => {
    const user = userEvent.setup();
    current = released(MIXED());
    open();
    await ready();
    expect(screen.queryByRole('link', { name: 'Finished' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Dropped' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done (1)' }));
    expect(screen.getByRole('link', { name: 'Finished' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancelled (1)' }));
    expect(screen.getByRole('link', { name: 'Dropped' })).toBeInTheDocument();
  });

  it('has no drag and no menu: they are the queue’s now', async () => {
    current = released(MIXED());
    open();
    await ready();
    expect(screen.queryByRole('button', { name: /^Drag / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull();
  });

  it('tells a released phase with none so', async () => {
    current = released([]);
    open();
    await ready();
    expect(screen.getByText('No tickets')).toBeInTheDocument();
  });
});

describe('Release', () => {
  async function pressRelease() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Release' }));
    return { user, dialog: screen.getByRole('dialog', { name: 'Release this phase?' }) };
  }

  it('states the count, where, what agents see, and the drafts apart', async () => {
    open();
    await ready();
    const { dialog, user } = await pressRelease();
    expect(dialog).toHaveTextContent(
      'Release “Creatures”? 2 tickets join the queue, at the bottom. They become visible to agents, and one notice is sent.',
    );
    expect(dialog).toHaveTextContent('1 draft goes with them: they stay drafts');

    await user.click(within(dialog).getByRole('radio', { name: 'At the top' }));
    expect(dialog).toHaveTextContent('2 tickets join the queue, at the top.');
  });

  it('says one ticket in the singular, and nothing of drafts with none', async () => {
    current = planned({ tickets: [frozenItem('demo-t0001')] });
    open();
    await ready();
    const { dialog } = await pressRelease();
    expect(dialog).toHaveTextContent('1 ticket joins the queue, at the bottom.');
    expect(dialog).toHaveTextContent('It becomes visible to agents');
    expect(dialog).not.toHaveTextContent('draft');
  });

  it('says what an empty phase’s release does', async () => {
    current = phaseRecord(ID);
    open();
    await ready();
    const { dialog } = await pressRelease();
    expect(dialog).toHaveTextContent('nothing joins the queue');
  });

  it('warns of `would_wait`, each id a link, and does not refuse', async () => {
    current = planned({ would_wait: [{ ticket: 'demo-t0090', on: 'demo-t0001' }] });
    open();
    await ready();
    const { dialog } = await pressRelease();
    const note = within(dialog).getByRole('note');
    expect(note).toHaveTextContent('Left waiting across the boundary');
    expect(note).toHaveTextContent('demo-t0090 waits on demo-t0001');
    expect(within(note).getByRole('link', { name: 'demo-t0090' })).toHaveAttribute(
      'href',
      '/projects/demo/ticket/demo-t0090',
    );
    expect(within(dialog).getByRole('button', { name: 'Release' })).toBeEnabled();
  });

  it('offers no before or after a queued ticket', async () => {
    open();
    await ready();
    const { dialog } = await pressRelease();
    const places = within(within(dialog).getByRole('radiogroup'));
    expect(places.getAllByRole('radio')).toHaveLength(2);
    expect(places.getByRole('radio', { name: 'At the bottom' })).toBeInTheDocument();
    expect(places.getByRole('radio', { name: 'At the top' })).toBeInTheDocument();
  });

  it('sends the placement and the note, then says what moved', async () => {
    server.on(`${URL_BASE}/release`, () => ({ body: outcome({ placed: 'top' }) }), 'POST');
    open();
    await ready();
    const { dialog, user } = await pressRelease();
    await user.click(within(dialog).getByRole('radio', { name: 'At the top' }));
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Go.');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(server.matching(`${URL_BASE}/release`)).toHaveLength(1));
    expect(server.last(`${URL_BASE}/release`).body).toEqual({
      top: true,
      note: 'Go.',
      author_email: 'alice@example.com',
      surface: 'web',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Released: 2 tickets joined the queue, at the top.',
    );
  });

  it('sends the bottom by default', async () => {
    server.on(`${URL_BASE}/release`, () => ({ body: outcome() }), 'POST');
    open();
    await ready();
    const { dialog, user } = await pressRelease();
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(server.matching(`${URL_BASE}/release`)).toHaveLength(1));
    expect(server.last(`${URL_BASE}/release`).body).toMatchObject({ bottom: true });
  });

  it('shows `waiting` from the answer, in case the phase changed under the dialog', async () => {
    current = planned({ would_wait: [{ ticket: 'demo-t0090', on: 'demo-t0001' }] });
    server.on(
      `${URL_BASE}/release`,
      () => ({ body: outcome({ waiting: [{ ticket: 'demo-t0091', on: 'demo-t0002' }] }) }),
      'POST',
    );
    open();
    await ready();
    const { dialog, user } = await pressRelease();
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Left waiting across the boundary');
    expect(status).toHaveTextContent('demo-t0091 waits on demo-t0002');
    expect(status).not.toHaveTextContent('demo-t0090');
  });

  it('keeps a refusal in the dialog, in the server’s words', async () => {
    server.on(
      `${URL_BASE}/release`,
      {
        status: 400,
        body: { error: 'demo-p0001 is released: only a planned phase can be released' },
      },
      'POST',
    );
    open();
    await ready();
    const { dialog, user } = await pressRelease();
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'only a planned phase can be released',
    );
  });

  it('asks who is writing rather than opening', async () => {
    const user = userEvent.setup();
    open({ identity: null });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Release' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Release this phase?' })).toBeNull();
  });

  it('is absent from a released phase, as Recall is from a planned one', async () => {
    open();
    await ready();
    expect(screen.queryByRole('button', { name: 'Recall' })).toBeNull();
  });
});

describe('Recall', () => {
  const LINKED = () => [
    item('demo-t0001', { phase: ID, title: 'Waiting' }),
    item('demo-t0002', { phase: ID, title: 'Blocked', blocked: true, block_reason: 'review' }),
    item('demo-t0003', { phase: ID, title: 'A draft', draft: true }),
    item('demo-t0004', { phase: ID, title: 'Working', status: 'in_progress' }),
    item('demo-t0005', { phase: ID, title: 'Looked at', status: 'review' }),
    item('demo-t0006', { phase: ID, title: 'Finished', status: 'done', queued: false }),
  ];

  async function pressRecall() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Recall' }));
    return { user, dialog: screen.getByRole('dialog', { name: 'Recall this phase?' }) };
  }

  it('counts from the tickets: pending, blocked or a draft or neither, and in progress or review', async () => {
    current = released(LINKED());
    open();
    await ready();
    const { dialog } = await pressRecall();
    expect(dialog).toHaveTextContent(
      'Recall “Creatures”? 3 pending tickets go back to the phase, out of the queue. 2 tickets in progress or review stay where they are.',
    );
    expect(dialog).not.toHaveTextContent('failed or deferred');
  });

  it('says what else stays, and the singular', async () => {
    current = released([
      item('demo-t0001', { phase: ID }),
      item('demo-t0002', { phase: ID, status: 'in_progress' }),
      item('demo-t0003', { phase: ID, status: 'failed' }),
      item('demo-t0004', { phase: ID, status: 'deferred' }),
    ]);
    open();
    await ready();
    const { dialog } = await pressRecall();
    expect(dialog).toHaveTextContent('1 pending ticket goes back');
    expect(dialog).toHaveTextContent('1 ticket in progress or review stays where it is.');
    expect(dialog).toHaveTextContent('2 failed or deferred tickets stay too.');
  });

  it('warns of `would_wait`, then shows `waiting` from the answer', async () => {
    current = released(LINKED(), { would_wait: [{ ticket: 'demo-t0090', on: 'demo-t0001' }] });
    server.on(
      `${URL_BASE}/recall`,
      () => ({
        body: outcome({
          moved: 3,
          placed: null,
          waiting: [{ ticket: 'demo-t0092', on: 'demo-t0003' }],
        }),
      }),
      'POST',
    );
    open();
    await ready();
    const { dialog, user } = await pressRecall();
    expect(within(dialog).getByRole('note')).toHaveTextContent('demo-t0090 waits on demo-t0001');
    await user.click(within(dialog).getByRole('button', { name: 'Recall' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Recalled: 3 tickets went back to the phase, frozen.');
    expect(status).toHaveTextContent('demo-t0092 waits on demo-t0003');
    expect(server.last(`${URL_BASE}/recall`).body).toEqual({
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('is absent from an archived phase', async () => {
    current = phaseRecord(ID, {
      state: 'archived',
      released_at: '2026-01-01T00:00:00Z',
      tickets: [],
    });
    open();
    await ready();
    expect(screen.queryByRole('button', { name: 'Recall' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });
});

describe('Archive and Unarchive', () => {
  it('shows the store’s refusal when an open ticket holds it', async () => {
    const user = userEvent.setup();
    server.on(
      `${URL_BASE}/archive`,
      {
        status: 400,
        body: {
          error: 'demo-p0001 is planned and has 3 open tickets: cancel, move or release them first',
        },
      },
      'POST',
    );
    open();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this phase?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('has 3 open tickets');
    expect(screen.getByRole('dialog', { name: 'Archive this phase?' })).toBeInTheDocument();
  });

  it('archives, then re-reads', async () => {
    const user = userEvent.setup();
    server.on(`${URL_BASE}/archive`, { body: phaseRecord(ID, { state: 'archived' }) }, 'POST');
    open();
    await ready();
    const before = server.matching(READ).length;
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this phase?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(server.matching(READ).length).toBeGreaterThan(before));
    expect(server.matching(`${URL_BASE}/archive`)).toHaveLength(1);
  });

  it('offers Unarchive by state, saying where it goes', async () => {
    const user = userEvent.setup();
    current = phaseRecord(ID, { state: 'archived', tickets: [] });
    server.on(`${URL_BASE}/unarchive`, { body: phaseRecord(ID) }, 'POST');
    open();
    await ready();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    const dialog = screen.getByRole('dialog', { name: 'Unarchive this phase?' });
    expect(dialog).toHaveTextContent('at the bottom, as a planned phase');
    await user.click(within(dialog).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(server.matching(`${URL_BASE}/unarchive`)).toHaveLength(1));
  });
});

describe('the history', () => {
  const RELEASE: TrackerEvent = {
    event_id: 3,
    ts: '2026-01-05T00:00:00Z',
    author_email: 'alice@example.com',
    agent: 'Owner',
    surface: 'web',
    kind: 'release',
    body: 'Phase released.',
    fields: { state: 'released', tickets: 40, placed: 'bottom' },
  };

  it('folds it, and names each kind', async () => {
    const user = userEvent.setup();
    current = planned({ events: [...EVENTS, RELEASE] });
    open();
    await ready();
    expect(screen.queryByText('Phase released')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'History (3)' }));
    expect(screen.getByText('Phase released')).toBeInTheDocument();
    expect(screen.getByText('Tickets moved')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });
});
