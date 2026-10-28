/**
 * The dashboard (specs/tracker m03, TD-03 to TD-05), against a `fetch` double.
 *
 * What it defends, in the order the spec lists it: the three sections in
 * order with the right status words; Acknowledge all done; a drag, Alt+↑ and
 * Move to bottom each becoming one `move` with the right anchor; a refused
 * move snapping back with the server's sentence; blocked items drawn only
 * under Blocked; Unblock never sent without a note; the poll stopping while
 * the tab is hidden; and a 304 changing nothing. Then the owner's approval
 * from the row (rag-t0009) and new work starting owner-approved (rag-t0010).
 * Last, the owner's row tweaks: a gate marker names its own title (rag-t0015)
 * and a row draws no link chips (rag-t0016, rag-t0026, rag-t0031), its labels
 * at its second line's right end. Then the
 * Deferred section, Defer and Resume (rag-t0017). Then the Parallel badge and
 * box (rag-t0013), what a dependency-blocked row waits on (rag-t0018), and the
 * gate marker at a phone's width (rag-t0019). Last, a done gate drawn under
 * Done as the queue's marker, in green (rag-t0021).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { onTestFinished } from 'vitest';
import userEvent from '@testing-library/user-event';

import { QueueView } from '../tracker/QueueView';
import type { Item, QueueView as QueueViewRecord } from '../tracker/types';
import { mountAt } from './harness';
import { QueueList, gateOwnTitle } from '../tracker/QueueList';
import { summary } from '../tracker/ProjectPicker';
import { TrackerServer, gateItem, item, queueRoute, queueView } from './trackerFixtures';

const QUEUE = /^\/tracker\/demo$/;
const PROJECTS = '/tracker/projects';

let server: TrackerServer;
let view: QueueViewRecord;

beforeEach(() => {
  view = queueView();
  server = new TrackerServer();
  server.on(PROJECTS, { body: { projects: [] } });
  server.on(
    QUEUE,
    queueRoute(() => view),
    'GET',
  );
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function open() {
  return mountAt('/projects/:project', <QueueView />, { route: '/projects/demo' });
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

/** The queue's rows, in the order they are drawn. */
function queueIds(): string[] {
  return within(screen.getByRole('list', { name: 'Queue' }))
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('data-id') ?? '');
}

/** Rows stand 40 px apart, by their drawn index, for the drag geometry. */
function stubRowGeometry() {
  // A drag near the viewport's edge scrolls the page; jsdom has no scrolling.
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
    } as DOMRect;
  });
}

describe('the dashboard renders the report', () => {
  it('draws done, the queue with its gate marker, and blocked, in order', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Done', 'Queue', 'Blocked']);

    // Done: in the server's order, oldest first and the latest finished last,
    // just above the queue (rag-t0029); each labelled in words as well as in green.
    const done = within(section('Done')).getAllByRole('listitem');
    expect(done.map((row) => row.getAttribute('data-id'))).toEqual(['demo-t0009', 'demo-t0010']);
    expect(within(done[0]!).getByText('Done')).toBeInTheDocument();

    // The queue in list order, the gate a marker between the items.
    expect(queueIds()).toEqual([
      'demo-t0001',
      'demo-t0002',
      'demo-t0003',
      'demo-t0004',
      'demo-t0005',
    ]);
    const rows = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('In progress')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('dev-3')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Pending')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Agent-approved')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Standard gate')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Release')).toBeInTheDocument();
    expect(rows[2]!.className).toMatch(/marker/);
    expect(within(rows[3]!).getByText('Failed')).toBeInTheDocument();

    // A row draws no link chips (rag-t0031): the ledger link is on the item's page.
    expect(within(rows[0]!).queryByRole('link', { name: /demo-0042/ })).toBeNull();

    // Blocked, with its reason and its note.
    const blocked = within(section('Blocked'));
    expect(section('Blocked').querySelector('[data-state="blocked"]')).toHaveTextContent('Blocked');
    expect(blocked.getByText('Needs review')).toBeInTheDocument();
    expect(blocked.getByText('Waiting on the owner’s eye.')).toBeInTheDocument();
  });

  it('draws Done in the server’s order, oldest first and the latest last, never re-sorted (rag-t0029)', async () => {
    view = queueView({
      done: [
        item('demo-t0012', { status: 'done', queued: false, done_at: '2026-01-01T00:00:00Z' }),
        item('demo-t0003', { status: 'done', queued: false, done_at: '2026-01-02T00:00:00Z' }),
        item('demo-t0020', { status: 'done', queued: false, done_at: '2026-01-03T00:00:00Z' }),
      ],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const done = within(section('Done')).getAllByRole('listitem');
    expect(done.map((row) => row.getAttribute('data-id'))).toEqual([
      'demo-t0012',
      'demo-t0003',
      'demo-t0020',
    ]);
  });

  it('shows a blocked item under Blocked and never in the queue', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(queueIds()).not.toContain('demo-t0006');
    expect(within(section('Blocked')).getByText('Held for review')).toBeInTheDocument();
  });

  it('acknowledges all done through its route and empties the Done section', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/ack-done', () => {
      view = { ...view, done: [] };
      return { body: { project: 'demo', acknowledged: ['demo-t0010', 'demo-t0009'] } };
    });
    open();
    await screen.findByRole('region', { name: 'Done' });

    await user.click(screen.getByRole('button', { name: /Acknowledge all done/ }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Done' })).toBeNull());
    expect(server.last('/tracker/demo/ack-done').body).toEqual({
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('filters to the approvals not yet ratified', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('switch', { name: /Unratified only \(1\)/ }));
    expect(queueIds()).toEqual(['demo-t0002']);
    expect(screen.queryByRole('region', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Blocked' })).toBeNull();
  });
});

describe('reordering', () => {
  beforeEach(() => {
    server.on(/\/tracker\/items\/[^/]+\/move$/, (sent) => ({
      body: item(sent.path.split('/')[3]!),
    }));
  });

  it('turns a drag from the fourth row to above the first into one move before the first', async () => {
    stubRowGeometry();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const grip = screen.getByRole('button', { name: 'Drag demo-t0004 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 140 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 4 });
    // While it is in the hand, the rows it passed have stepped aside.
    const first = screen.getByRole('listitem', { name: /demo-t0001/ });
    expect(first.style.transform).toBe('translateY(40px)');
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 4 });

    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    const sent = server.last(/\/move$/);
    expect(sent.path).toBe('/tracker/items/demo-t0004/move');
    expect(sent.body).toEqual({
      before: 'demo-t0001',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('drops after the row above when the drop is not at the top', async () => {
    stubRowGeometry();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const grip = screen.getByRole('button', { name: 'Drag demo-t0001 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'touch', clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 105 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 105 });

    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).body).toMatchObject({ after: 'demo-t0003' });
  });

  it('sends nothing for a drag that lands where it started, or is cancelled', async () => {
    stubRowGeometry();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const grip = screen.getByRole('button', { name: 'Drag demo-t0002 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 65 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 65 });

    fireEvent.pointerDown(grip, { pointerId: 2, button: 0, pointerType: 'mouse', clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 2, clientY: 190 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 190 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.matching(/\/move$/)).toHaveLength(0);
  });

  it('moves a focused row with Alt+↑ to before the row above', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const row = screen.getByRole('listitem', { name: /demo-t0004/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowUp', altKey: true });

    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).path).toBe('/tracker/items/demo-t0004/move');
    expect(server.last(/\/move$/).body).toMatchObject({ before: 'demo-t0003' });
  });

  it('moves a focused row with Alt+↓ to after the row below', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const row = screen.getByRole('listitem', { name: /demo-t0001/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });

    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).body).toMatchObject({ after: 'demo-t0002' });
  });

  it('moves to the bottom from the row menu', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0002' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to bottom' }));

    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).path).toBe('/tracker/items/demo-t0002/move');
    expect(server.last(/\/move$/).body).toMatchObject({ bottom: true });
  });

  it('moves a gate marker to the top from its menu', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0003' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to top' }));

    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).body).toMatchObject({ top: true });
  });

  it('restores the server’s order and says why when a move is refused', async () => {
    const user = userEvent.setup();
    server.onceOn(/\/move$/, {
      status: 400,
      body: { error: 'the anchor demo-t0001 is not queued' },
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0005' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to top' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'demo-t0005 was not moved: the anchor demo-t0001 is not queued',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The list shows the server’s order.');
    await waitFor(() =>
      expect(queueIds()).toEqual([
        'demo-t0001',
        'demo-t0002',
        'demo-t0003',
        'demo-t0004',
        'demo-t0005',
      ]),
    );
  });

  it('shows a dropped row in its new place until the server answers', async () => {
    let release: () => void = () => {};
    server.onceOn(/\/move$/, () => ({ body: item('demo-t0005') }));
    // Hold the move's answer back to look at the list in the meantime.
    type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const fetchMock = vi.mocked(globalThis.fetch);
    const real = fetchMock.getMockImplementation() as Fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/move')
        ? new Promise<Response>((resolve) => {
            release = () => void real(input, init).then(resolve);
          })
        : real(input, init),
    );
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0005' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to top' }));
    expect(queueIds()[0]).toBe('demo-t0005');

    view = { ...view, queue: [view.queue[4]!, ...view.queue.slice(0, 4)] };
    await act(async () => release());
    await waitFor(() => expect(queueIds()[0]).toBe('demo-t0005'));
  });

  it('cancels a drag when the server’s order changes under it, and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubRowGeometry();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const grip = screen.getByRole('button', { name: 'Drag demo-t0005 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 180 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 10 });

    // A manager's write lands; the next poll brings a different order.
    view = { ...view, queue: [view.queue[1]!, view.queue[0]!, ...view.queue.slice(2)] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The queue changed while you were dragging',
    );
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 10 });
    expect(server.matching(/\/move$/)).toHaveLength(0);
    expect(queueIds().slice(0, 2)).toEqual(['demo-t0002', 'demo-t0001']);
  });
});

describe('adding and removing', () => {
  it('adds an item at the bottom with its type, title and body, owner-approved', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.click(within(dialog).getByRole('radio', { name: 'Recon' }));
    await user.type(within(dialog).getByLabelText('Title'), 'Map the store');
    await user.type(within(dialog).getByLabelText('Body'), 'Read first.');
    // The owner adding it is the owner's approval: ticked until untouched.
    expect(
      within(dialog).getByRole('checkbox', { name: 'Create it owner-approved' }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toEqual({
      type: 'recon',
      title: 'Map the store',
      body: 'Read first.',
      approval: 'owner',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('adds an item unapproved when the box is unticked, sending no approval', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Map the store');
    // The label ticks and unticks it too.
    await user.click(within(dialog).getByText('Create it owner-approved'));
    expect(
      within(dialog).getByRole('checkbox', { name: 'Create it owner-approved' }),
    ).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    const sent = server.last('/tracker/demo/items', 'POST').body!;
    expect(sent).not.toHaveProperty('approval');
    expect(sent).toMatchObject({ type: 'dev', title: 'Map the store' });
  });

  it('ticks the box again for the next item after one was added unticked', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    let dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'One');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Create it owner-approved' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a ticket' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    expect(
      within(dialog).getByRole('checkbox', { name: 'Create it owner-approved' }),
    ).toBeChecked();
  });

  it('adds a gate with its intensity and release, titled from them', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add gate' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a gate' });
    await user.click(within(dialog).getByRole('radio', { name: 'Full' }));
    await user.click(within(dialog).getByRole('switch', { name: 'Release after this gate' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toEqual({
      type: 'gate',
      title: 'Full gate and release',
      intensity: 'full',
      release: true,
      approval: 'owner',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('adds a gate unapproved when its box is unticked', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add gate' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a gate' });
    const box = within(dialog).getByRole('checkbox', { name: 'Create it owner-approved' });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    const sent = server.last('/tracker/demo/items', 'POST').body!;
    expect(sent).not.toHaveProperty('approval');
    expect(sent).toMatchObject({ type: 'gate', intensity: 'standard' });
  });

  it('removes a row by cancelling it, the note optional, after a confirm', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0005', { body: item('demo-t0005') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0005' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this ticket?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Superseded by t0007');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0005', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0005', 'POST').body).toEqual({
      status: 'cancelled',
      note: 'Superseded by t0007',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('unblocks without a note, sending none', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0006', { body: item('demo-t0006') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(within(section('Blocked')).getByRole('button', { name: 'Unblock' }));
    const dialog = screen.getByRole('dialog', { name: 'Unblock this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unblock' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0006', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0006', 'POST').body).toEqual({
      blocked: false,
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('opens the identity prompt instead of writing when nobody is signed', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project', <QueueView />, { route: '/projects/demo', identity: null });
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: /Set your email to acknowledge/ }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(server.matching('/tracker/demo/ack-done')).toHaveLength(0);
  });
});

describe('approving from the row', () => {
  /** The item's POST answers, and the next queue read carries `approval`. */
  function approves(id: string) {
    server.on(
      `/tracker/items/${id}`,
      (sent) => {
        const approval = sent.body!.approval as Item['approval'];
        const set = (row: Item) => (row.id === id ? { ...row, approval } : row);
        view = {
          ...view,
          done: view.done.map(set),
          queue: view.queue.map(set),
          blocked: view.blocked.map(set),
        };
        return { body: item(id, { approval }) };
      },
      'POST',
    );
  }

  function queueRow(id: string): HTMLElement {
    return within(screen.getByRole('list', { name: 'Queue' }))
      .getAllByRole('listitem')
      .find((row) => row.getAttribute('data-id') === id)!;
  }

  it('ratifies an agent’s approval from its badge after a confirm, without a note', async () => {
    const user = userEvent.setup();
    approves('demo-t0002');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Agent-approved: ratify demo-t0002' }));
    const dialog = screen.getByRole('dialog', { name: 'Ratify the agent’s approval?' });
    // Nothing is written on the badge's click: the confirmation comes first.
    expect(server.matching('/tracker/items/demo-t0002', 'POST')).toHaveLength(0);
    expect(within(dialog).getByText('demo-t0002')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Note (optional)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Ratify' }));

    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0002', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0002', 'POST').body).toEqual({
      approval: 'ratified',
      author_email: 'alice@example.com',
      surface: 'web',
    });
    // The row re-reads: the badge is Ratified now, and no longer a button.
    await waitFor(() => expect(within(queueRow('demo-t0002')).getByText('Ratified')).toBeVisible());
    expect(screen.queryByRole('button', { name: /ratify demo-t0002/ })).toBeNull();
    // The keyboard is back on the row, not lost on the page.
    await waitFor(() => expect(queueRow('demo-t0002')).toHaveFocus());
  });

  it('ratifies from the keyboard, with a note', async () => {
    const user = userEvent.setup();
    approves('demo-t0002');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const badge = screen.getByRole('button', { name: 'Agent-approved: ratify demo-t0002' });
    act(() => badge.focus());
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Ratify the agent’s approval?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Read the brief.');
    await user.click(within(dialog).getByRole('button', { name: 'Ratify' }));

    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0002', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0002', 'POST').body).toEqual({
      approval: 'ratified',
      note: 'Read the brief.',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    approves('demo-t0002');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Agent-approved: ratify demo-t0002' }));
    const dialog = screen.getByRole('dialog', { name: 'Ratify the agent’s approval?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Ratify the agent’s approval?' })).toBeNull();
    expect(server.matching('/tracker/items/demo-t0002', 'POST')).toHaveLength(0);
  });

  it('makes the badge a button only for an agent’s approval', async () => {
    view = queueView({
      queue: [
        item('demo-t0001', { approval: 'ratified' }),
        item('demo-t0002', { approval: 'owner' }),
        item('demo-t0003', { approval: 'agent' }),
      ],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });

    expect(within(queueRow('demo-t0001')).getByText('Ratified')).toBeInTheDocument();
    expect(within(queueRow('demo-t0002')).getByText('Owner-approved')).toBeInTheDocument();
    for (const id of ['demo-t0001', 'demo-t0002']) {
      const row = queueRow(id);
      expect(within(row).queryByRole('button', { name: /ratify/i })).toBeNull();
      expect(within(row).queryByRole('button', { name: /^Approve/ })).toBeNull();
    }
    expect(
      within(queueRow('demo-t0003')).getByRole('button', {
        name: 'Agent-approved: ratify demo-t0003',
      }),
    ).toBeInTheDocument();
    // An agent's approval is ratified, never approved over.
    expect(within(queueRow('demo-t0003')).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('approves an unapproved queued item as the owner after a confirm', async () => {
    const user = userEvent.setup();
    approves('demo-t0005');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    expect(within(queueRow('demo-t0005')).queryByRole('button', { name: /ratify/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve demo-t0005' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve as the owner?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0005', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0005', 'POST').body).toEqual({
      approval: 'owner',
      author_email: 'alice@example.com',
      surface: 'web',
    });
    await waitFor(() =>
      expect(within(queueRow('demo-t0005')).getByText('Owner-approved')).toBeVisible(),
    );
    expect(screen.queryByRole('button', { name: 'Approve demo-t0005' })).toBeNull();
  });

  it('approves a blocked item from its row, and ratifies a done one', async () => {
    const user = userEvent.setup();
    view = queueView({
      done: [item('demo-t0010', { status: 'done', queued: false, approval: 'agent' })],
    });
    approves('demo-t0006');
    approves('demo-t0010');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(
      within(section('Blocked')).getByRole('button', { name: 'Approve demo-t0006' }),
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Approve as the owner?' })).getByRole('button', {
        name: 'Approve',
      }),
    );
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0006', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0006', 'POST').body).toMatchObject({
      approval: 'owner',
    });

    await user.click(
      within(section('Done')).getByRole('button', { name: 'Agent-approved: ratify demo-t0010' }),
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Ratify the agent’s approval?' })).getByRole(
        'button',
        { name: 'Ratify' },
      ),
    );
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0010', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0010', 'POST').body).toMatchObject({
      approval: 'ratified',
    });
  });

  it('offers no Approve on finished work under Done', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(within(section('Done')).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('opens the identity prompt instead of a confirmation when nobody is signed', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project', <QueueView />, { route: '/projects/demo', identity: null });
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Agent-approved: ratify demo-t0002' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Ratify the agent’s approval?' })).toBeNull();
    expect(server.matching('/tracker/items/demo-t0002', 'POST')).toHaveLength(0);
  });
});

describe('the row tweaks', () => {
  /** True when `first` comes before `second` in the document. */
  function before(first: Element, second: Element): boolean {
    return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  /**
   * The two-line row (rag-t0026): the approval on the first line, at its
   * right. No link chips anywhere on the row (rag-t0031, which took them off
   * the dashboard); the labels hold the second line's right end, where the
   * chips were.
   */
  function approvalNoChipsLabelsAtEnd(row: HTMLElement, topic: string) {
    expect(within(row).queryByRole('link', { name: new RegExp(topic) })).toBeNull();
    expect(row.querySelector('[class*="chipMore"]')).toBeNull();
    const approval = row.querySelector('[data-approval]');
    expect(approval).not.toBeNull();
    const line2 = row.querySelector('[class*="cellLine2"]');
    expect(line2).not.toBeNull();
    expect(line2!.contains(approval)).toBe(false);
    expect(approval!.closest('[class*="cellMeta"]')).not.toBeNull();
    const labels = within(row).getByLabelText('Labels');
    expect(line2!.contains(labels)).toBe(true);
    expect(labels.closest('[class*="line2End"]')).not.toBeNull();
    expect(labels.closest('[class*="line2Start"]')).toBeNull();
    expect(before(approval!, labels)).toBe(true);
  }

  it('names a gate by its own title on its marker, whole in the tooltip', async () => {
    const title = 'Gate: suit heat buffer + heat power m01–m03 + heat rods m02–m04';
    view = queueView({
      queue: [item('demo-t0001'), gateItem('demo-t0003', { title, release: true })],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const marker = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem')[1]!;
    const shown = within(marker).getByText(title);
    expect(shown).toHaveAttribute('title', title);
    expect(shown.className).toMatch(/markerTitle/);
    // The marker still says what the gate is.
    expect(within(marker).getByText('Standard gate')).toBeInTheDocument();
    expect(within(marker).getByText('Release')).toBeInTheDocument();
    expect(within(marker).getByRole('link')).toHaveAccessibleName(expect.stringContaining(title));
  });

  it('does not repeat a default title the marker already says', async () => {
    view = queueView({
      queue: [gateItem('demo-t0003', { title: 'Standard gate and release', release: true })],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const marker = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem')[0]!;
    expect(within(marker).queryByText('Standard gate and release')).toBeNull();
    expect(marker.querySelector('[title="Standard gate and release"]')).toBeNull();
  });

  it('tells a gate’s own title from its default one', () => {
    expect(gateOwnTitle(gateItem('g', { title: 'Standard gate' }))).toBeNull();
    expect(
      gateOwnTitle(
        gateItem('g', { title: 'full gate and release', intensity: 'full', release: true }),
      ),
    ).toBeNull();
    expect(gateOwnTitle(gateItem('g', { title: 'Gate', intensity: null }))).toBeNull();
    expect(gateOwnTitle(gateItem('g', { title: '  ' }))).toBeNull();
    // The marker's own name, with or without the release the badge shows.
    expect(gateOwnTitle(gateItem('g', { title: 'Standard gate', release: true }))).toBeNull();
    // The default for another intensity or release is the gate's own title.
    expect(gateOwnTitle(gateItem('g', { title: 'Full gate' }))).toBe('Full gate');
    expect(gateOwnTitle(gateItem('g', { title: 'Standard gate and release' }))).toBe(
      'Standard gate and release',
    );
    expect(gateOwnTitle(gateItem('g', { title: ' Tracker m06 ' }))).toBe('Tracker m06');
  });

  it('draws no link chips on any dashboard row, its labels at the second line’s end (rag-t0031)', async () => {
    const tagged = { labels: ['Physics'] };
    view = queueView({
      done: [
        item('demo-t0010', {
          ...tagged,
          status: 'done',
          queued: false,
          approval: 'ratified',
          links: [{ kind: 'ledger', target: 'demo-0043' }],
          done_at: '2026-01-03T00:00:00Z',
        }),
      ],
      review: [
        item('demo-t0011', {
          ...tagged,
          status: 'review',
          approval: 'agent',
          links: [{ kind: 'spec', target: 'tracker' }],
        }),
      ],
      queue: [
        item('demo-t0001', {
          ...tagged,
          approval: 'owner',
          links: [
            { kind: 'ledger', target: 'demo-0042' },
            { kind: 'item', target: 'demo-t0099' },
            { kind: 'ledger', target: 'demo-0050' },
            { kind: 'ledger', target: 'demo-0051' },
          ],
        }),
        item('demo-t0002', {
          ...tagged,
          approval: 'agent',
          links: [{ kind: 'ledger', target: 'demo-0044' }],
        }),
        item('demo-t0004', { ...tagged, links: [{ kind: 'ledger', target: 'demo-0045' }] }),
      ],
      blocked: [
        item('demo-t0006', {
          ...tagged,
          blocked: true,
          block_reason: 'review',
          approval: 'agent',
          links: [{ kind: 'ledger', target: 'demo-0046' }],
        }),
        item('demo-t0012', {
          ...tagged,
          blocked: true,
          block_reason: 'dependency',
          depends_on: ['demo-t0002'],
          links: [{ kind: 'item', target: 'demo-t0098' }],
        }),
      ],
      deferred: [
        item('demo-t0007', {
          ...tagged,
          status: 'deferred',
          links: [{ kind: 'concept', target: 'later.md' }],
        }),
      ],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const rows = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem');
    approvalNoChipsLabelsAtEnd(rows[0]!, 'demo-0042'); // Owner-approved badge
    for (const hidden of [/demo-t0099/, /demo-0050/, /demo-0051/]) {
      expect(within(rows[0]!).queryByRole('link', { name: hidden })).toBeNull();
    }
    approvalNoChipsLabelsAtEnd(rows[1]!, 'demo-0044'); // the Agent-approved ratify button
    approvalNoChipsLabelsAtEnd(rows[2]!, 'demo-0045'); // Approve
    approvalNoChipsLabelsAtEnd(within(section('Done')).getAllByRole('listitem')[0]!, 'demo-0043');
    approvalNoChipsLabelsAtEnd(within(section('Review')).getAllByRole('listitem')[0]!, 'tracker');
    approvalNoChipsLabelsAtEnd(
      within(section('Deferred')).getAllByRole('listitem')[0]!,
      'later\\.md',
    );
    const [held, waiting] = within(section('Blocked')).getAllByRole('listitem');
    approvalNoChipsLabelsAtEnd(held!, 'demo-0046');
    approvalNoChipsLabelsAtEnd(waiting!, 'demo-t0098');
    // What a dependency waits on is the block's reason, not a link chip: it stays.
    expect(within(waiting!).getByText('waits on')).toBeInTheDocument();
    expect(within(waiting!).getByRole('link', { name: /demo-t0002/ })).toHaveAttribute(
      'href',
      '/projects/demo/ticket/demo-t0002',
    );
  });

  it('draws no second-line end on a row with no labels', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const row = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem')[0]!;
    expect(row.querySelector('[class*="cellLine2"]')).not.toBeNull();
    expect(row.querySelector('[class*="line2End"]')).toBeNull();
  });

  it('draws no link chips in the list on its own, its labels at the second line’s end', () => {
    mountAt(
      '/',
      <QueueList
        project="demo"
        items={[
          item('demo-t0001', {
            approval: 'ratified',
            labels: ['Physics'],
            links: [{ kind: 'ledger', target: 'demo-0042' }],
          }),
        ]}
        reorderable
        revision={1}
        onMove={() => {}}
        onRemove={() => {}}
        onDefer={() => {}}
        onApproval={() => {}}
        onInterrupted={() => {}}
      />,
    );
    approvalNoChipsLabelsAtEnd(screen.getAllByRole('listitem')[0]!, 'demo-0042');
  });
});

describe('deferred (rag-t0017)', () => {
  function withDeferred() {
    view = queueView({
      deferred: [
        item('demo-t0007', { status: 'deferred', title: 'Put aside' }),
        item('demo-t0008', {
          status: 'deferred',
          title: 'Aside and held',
          blocked: true,
          block_reason: 'redesign',
          block_note: 'Ask first.',
          approval: 'agent',
        }),
      ],
    });
  }

  it('draws Deferred below Blocked, each row teal and in words, never in the queue', async () => {
    withDeferred();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Done', 'Queue', 'Blocked', 'Deferred']);
    expect(queueIds()).not.toContain('demo-t0007');
    expect(within(section('Blocked')).queryByText('Aside and held')).toBeNull();

    const rows = within(section('Deferred')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual(['demo-t0007', 'demo-t0008']);
    for (const row of rows) {
      const dot = row.querySelector('[data-state]');
      expect(dot).toHaveAttribute('data-state', 'deferred');
      expect(dot).toHaveTextContent('Deferred');
      expect(within(row).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    }
    // Deferred and blocked: shown as deferred, its block beside it.
    expect(within(rows[1]!).getByText('Needs redesign')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Ask first.')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText(/Needs/)).toBeNull();
    // Its approval is the owner's to ratify from the row, as elsewhere.
    expect(
      within(rows[1]!).getByRole('button', { name: 'Agent-approved: ratify demo-t0008' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Unratified only (2)')).toBeInTheDocument();
  });

  it('draws no Deferred section when nothing is deferred, or the server sends none', async () => {
    const { deferred: _omitted, ...older } = queueView({ deferred: [] });
    view = older as QueueViewRecord;
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(screen.queryByRole('region', { name: 'Deferred' })).toBeNull();
  });

  it('defers a queued row from its menu after a confirm, the note optional', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0005', { body: item('demo-t0005') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0005' }));
    await user.click(screen.getByRole('menuitem', { name: 'Defer' }));
    const dialog = screen.getByRole('dialog', { name: 'Defer this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Defer' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0005', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0005', 'POST').body).toEqual({
      status: 'deferred',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('sends nothing when the defer is cancelled', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0003' }));
    await user.click(screen.getByRole('menuitem', { name: 'Defer gate' }));
    const dialog = screen.getByRole('dialog', { name: 'Defer this gate?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.matching(/\/tracker\/items\//, 'POST')).toHaveLength(0);
  });

  it('resumes a deferred row to pending, with a note', async () => {
    const user = userEvent.setup();
    withDeferred();
    server.on('/tracker/items/demo-t0007', { body: item('demo-t0007') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const row = within(section('Deferred')).getAllByRole('listitem')[0]!;
    await user.click(within(row).getByRole('button', { name: 'Resume' }));
    const dialog = screen.getByRole('dialog', { name: 'Resume this ticket?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Back on');
    await user.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0007', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0007', 'POST').body).toEqual({
      status: 'pending',
      note: 'Back on',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('counts deferred in the project picker, and says nothing when there are none', () => {
    const base = { name: 'demo', created_at: '', queued: 5, blocked: 1, done_unacknowledged: 0 };
    expect(summary({ ...base, deferred: 2 })).toBe('5 queued · 1 blocked · 2 deferred');
    expect(summary({ ...base, deferred: 0 })).toBe('5 queued · 1 blocked');
    expect(summary(base)).toBe('5 queued · 1 blocked');
  });

  it('colours deferred with the teal token, which the design system defines', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    expect(sheet).toMatch(/\.status_deferred\s*\{\s*--status-colour:\s*var\(--rag-teal\);/);
    expect(sheet).toMatch(/\.section_deferred\s*\{\s*border-left:[^;]*var\(--rag-teal\);/);
    const tokens = readFileSync(resolve(__dirname, '../../../ui/src/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--rag-teal:\s*#[0-9a-f]{6};/);
  });
});

describe('parallel, dependencies and the marker on a phone', () => {
  it('badges a parallel row in the queue, and no other (rag-t0013)', async () => {
    view = queueView({
      queue: [item('demo-t0002'), gateItem('demo-t0003'), item('demo-t0005', { parallel: true })],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const rows = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem');
    expect(within(rows[2]!).getByText('Parallel')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('Parallel')).toBeNull();
  });

  it('adds a parallel item when its box is ticked, and the box starts unticked', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    const box = within(dialog).getByRole('checkbox', { name: /^Parallel/ });
    expect(box).not.toBeChecked();
    await user.type(within(dialog).getByLabelText('Title'), 'Scratch build');
    await user.click(box);
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toEqual({
      type: 'dev',
      title: 'Scratch build',
      body: '',
      approval: 'owner',
      parallel: true,
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('says under Blocked what a dependency waits on, each a link to its item (rag-t0018)', async () => {
    view = queueView({
      blocked: [
        item('demo-t0006', {
          blocked: true,
          block_reason: 'dependency',
          depends_on: ['demo-t0001', 'demo-t0002'],
          title: 'Waits on the spec',
        }),
        item('demo-t0007', { blocked: true, block_reason: 'review', title: 'Held' }),
      ],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const blocked = section('Blocked');
    const [waiting, held] = within(blocked).getAllByRole('listitem');
    expect(within(waiting!).getByText('Waits on tickets')).toBeInTheDocument();
    const waits = within(waiting!).getByText('waits on').parentElement!;
    expect(
      within(waits)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['demo-t0001', '/projects/demo/ticket/demo-t0001'],
      ['demo-t0002', '/projects/demo/ticket/demo-t0002'],
    ]);
    expect(within(held!).queryByText('waits on')).toBeNull();
  });

  it('keeps the marker’s id and gives its title a line of its own at a phone’s width (rag-t0019)', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    const at = sheet.indexOf('@media (max-width: 40rem)');
    expect(at).toBeGreaterThan(-1);
    const phone = sheet.slice(at);
    // The id is never hidden on a phone.
    expect(phone).not.toMatch(/\.markerId\s*\{[^}]*display:\s*none/);
    expect(sheet).not.toMatch(/\.markerId\s*\{[^}]*display:\s*none/);
    // The label takes the row and wraps, and the title takes a whole line,
    // cut with an ellipsis (the base rule keeps overflow and text-overflow).
    expect(phone).toMatch(/\.markerLabel\s*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*wrap;/);
    expect(phone).toMatch(/\.markerLabel > \.markerTitle\s*\{[^}]*flex:\s*1 1 100%;/);
    expect(sheet).toMatch(
      /\.markerLabel > \.markerTitle\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/,
    );
    // The dashed rules shrink to a stub rather than squeezing the label.
    expect(phone).toMatch(/\.marker \.rule\s*\{[^}]*flex:\s*0 0 var\(--rag-space-2\);/);
  });
});

describe('the 10 s refresh', () => {
  it('asks conditionally, and a 304 changes nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const before = screen.getByRole('list', { name: 'Queue' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    const reads = server.matching(QUEUE, 'GET');
    expect(reads).toHaveLength(2);
    expect(reads[0]!.headers['if-none-match']).toBeUndefined();
    expect(reads[1]!.headers['if-none-match']).toMatch(/^".+"$/);
    // Same node, same rows: nothing was re-rendered from scratch.
    expect(screen.getByRole('list', { name: 'Queue' })).toBe(before);
    expect(queueIds()).toHaveLength(5);
  });

  it('picks up a manager’s write on the next tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await screen.findByRole('heading', { name: 'demo' });

    view = {
      ...view,
      done: [item('demo-t0005', { status: 'done', queued: false, title: 'Later' }), ...view.done],
      queue: view.queue.slice(0, 4),
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(within(section('Done')).getByText('Later')).toBeInTheDocument());
  });

  it('stops while the tab is hidden and refreshes at once when it is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    onTestFinished(() => {
      delete (document as { visibilityState?: unknown }).visibilityState;
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(server.matching(QUEUE, 'GET')).toHaveLength(1);

    state = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(server.matching(QUEUE, 'GET')).toHaveLength(1);

    state = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(server.matching(QUEUE, 'GET')).toHaveLength(2));
  });
});

describe('the route', () => {
  it('refuses a project name the server would refuse, without a request', () => {
    mountAt('/projects/:project', <QueueView />, { route: '/projects/items' });
    expect(screen.getByText('“items” is not a project name.')).toBeInTheDocument();
    expect(server.matching(/^\/tracker\//)).toHaveLength(0);
  });

  it('remembers the project for the Tracker button', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(window.localStorage.getItem('rag.tracker.project')).toBe('demo');
  });
});

describe('a done gate under Done (rag-t0021)', () => {
  const title = 'Gate: heat rods m02–m04';

  function doneGateView() {
    return queueView({
      done: [
        gateItem('demo-t0012', {
          title,
          release: true,
          status: 'done',
          queued: false,
          done_at: '2026-01-04T00:00:00Z',
        }),
        item('demo-t0010', { status: 'done', queued: false, title: 'Shipped the thing' }),
      ],
      queue: [item('demo-t0001'), gateItem('demo-t0003', { title, release: true })],
    });
  }

  it('draws it as the queue’s marker line, linked to its item page', async () => {
    view = doneGateView();
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const [marker, row] = within(section('Done')).getAllByRole('listitem');
    expect(marker).toHaveAttribute('data-id', 'demo-t0012');
    expect(marker!.className).toMatch(/marker/);
    expect(marker!.className).not.toMatch(/flatRow/);
    // The same label as in the queue: intensity, title, Release, state, id.
    expect(within(marker!).getByText('Standard gate')).toBeInTheDocument();
    expect(within(marker!).getByText(title)).toHaveAttribute('title', title);
    expect(within(marker!).getByText('Release')).toBeInTheDocument();
    expect(within(marker!).getByText('Done')).toBeInTheDocument();
    expect(within(marker!).getByText('demo-t0012')).toBeInTheDocument();
    const link = within(marker!).getByRole('link');
    expect(link).toHaveAttribute('href', '/projects/demo/ticket/demo-t0012');
    expect(link.className).toMatch(/markerLabel/);
    expect(link.className).toMatch(/markerDone/);
    // Two dashed rules either side, in the done tone; no type badge column.
    const rules = marker!.querySelectorAll('[class*="rule"]');
    expect(rules).toHaveLength(2);
    rules.forEach((rule) => expect(rule.className).toMatch(/markerDone/));
    expect(marker!.querySelector('[data-type]')).toBeNull();
    // A done item that is not a gate stays a plain row.
    expect(row!.className).toMatch(/flatRow/);
  });

  it('keeps the queue’s marker purple: only Done’s takes the green', async () => {
    view = doneGateView();
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const queued = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem')[1]!;
    expect(queued.className).toMatch(/marker/);
    expect(within(queued).getByRole('link', { name: /Standard gate/ }).className).not.toMatch(
      /markerDone/,
    );
    queued
      .querySelectorAll('[class*="rule"]')
      .forEach((rule) => expect(rule.className).not.toMatch(/markerDone/));
  });

  it('colours the done tone with the done status’s green, the queue’s with the purple', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    const done = sheet.match(/\.status_done\s*\{\s*--status-colour:\s*(var\(--rag-[a-z]+\));/);
    expect(done).not.toBeNull();
    expect(sheet).toMatch(
      new RegExp(
        `\\.markerDone\\s*\\{\\s*--marker-colour:\\s*${done![1]!.replace(/[()]/g, '\\$&')};`,
      ),
    );
    expect(sheet).toMatch(
      /\.rule\s*\{[^}]*border-top:\s*2px dashed var\(--marker-colour, var\(--rag-extra\)\);/,
    );
    expect(sheet).toMatch(
      /\.markerLabel\s*\{[^}]*color:\s*var\(--marker-colour, var\(--rag-extra\)\);/,
    );
  });
});

describe('review (rag-t0024)', () => {
  function withReview() {
    view = queueView({
      review: [
        item('demo-t0011', { status: 'review', title: 'Look at the copy', approval: 'owner' }),
        item('demo-t0012', {
          status: 'review',
          title: 'Look and wait',
          blocked: true,
          block_reason: 'redesign',
          block_note: 'Redraw first.',
          approval: 'agent',
        }),
      ],
    });
  }

  it('draws Review between Done and the queue, red and in its own word, never in the queue', async () => {
    withReview();
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Done', 'Review', 'Queue', 'Blocked']);
    expect(queueIds()).not.toContain('demo-t0011');
    expect(within(section('Blocked')).queryByText('Look and wait')).toBeNull();

    const rows = within(section('Review')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual(['demo-t0011', 'demo-t0012']);
    for (const row of rows) {
      const dot = row.querySelector('[data-state]');
      expect(dot).toHaveAttribute('data-state', 'review');
      expect(dot).toHaveTextContent('Review');
      expect(dot).not.toHaveTextContent('Failed');
      expect(within(row).getByRole('button', { name: /^Confirm demo-t/ })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: /^Send back demo-t/ })).toBeInTheDocument();
    }
    // In review and blocked: shown under Review, its block and note beside it.
    expect(within(rows[1]!).getByText('Needs redesign')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Redraw first.')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole('button', { name: 'Agent-approved: ratify demo-t0012' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Unratified only (2)')).toBeInTheDocument();
  });

  it('draws no Review section when nothing is in review, or the server sends none', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
  });

  it('confirms a review row to done after a confirm, the note optional', async () => {
    const user = userEvent.setup();
    withReview();
    server.on('/tracker/items/demo-t0011', { body: item('demo-t0011') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Confirm demo-t0011' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm this ticket?' });
    expect(server.matching('/tracker/items/demo-t0011', 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0011', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0011', 'POST').body).toEqual({
      status: 'done',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('sends a review row back to in progress, with a note', async () => {
    const user = userEvent.setup();
    withReview();
    server.on('/tracker/items/demo-t0012', { body: item('demo-t0012') }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Send back demo-t0012' }));
    const dialog = screen.getByRole('dialog', { name: 'Send this ticket back?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Not yet');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0012', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0012', 'POST').body).toEqual({
      status: 'in_progress',
      note: 'Not yet',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    withReview();
    open();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Confirm demo-t0011' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(server.matching(/\/tracker\/items\//, 'POST')).toHaveLength(0);
  });

  it('counts review first in the project picker, and says nothing when there are none', () => {
    const base = { name: 'demo', created_at: '', queued: 5, blocked: 1, done_unacknowledged: 0 };
    expect(summary({ ...base, review: 2 })).toBe('5 queued · 2 in review · 1 blocked');
    expect(summary({ ...base, review: 0 })).toBe('5 queued · 1 blocked');
    expect(summary(base)).toBe('5 queued · 1 blocked');
  });

  it('colours review with failed’s red, but draws its dot as a diamond', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    expect(sheet).toMatch(/\.status_review\s*\{\s*--status-colour:\s*var\(--rag-crit\);/);
    expect(sheet).toMatch(/\.status_review \.statusDot\s*\{[^}]*transform:\s*rotate\(45deg\);/);
    expect(sheet).not.toMatch(/\.status_failed \.statusDot/);
    expect(sheet).toMatch(/\.section_review\s*\{\s*border-left:[^;]*var\(--rag-crit\);/);
  });
});

/** `@rag/ui`'s tokens, name to value, read from its stylesheet. */
function tokens(): Record<string, string> {
  const css = readFileSync(resolve(__dirname, '../../../ui/src/tokens.css'), 'utf8');
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/(--rag-[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** `color-mix(in srgb, a share, b)`, as a hex colour. */
function mix(a: string, b: string, share: number): string {
  const [ca, cb] = [channels(a), channels(b)];
  return `#${ca
    .map((v, i) =>
      Math.round(v * share + cb[i]! * (1 - share))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The WCAG 2 contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = channels(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('the row polish (rag-t0023, rag-t0025, rag-t0026)', () => {
  function queueRowOf(id: string): HTMLElement {
    return within(screen.getByRole('list', { name: 'Queue' }))
      .getAllByRole('listitem')
      .find((row) => row.getAttribute('data-id') === id)!;
  }

  it('tints an in-progress row, and only that row (rag-t0023)', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(queueRowOf('demo-t0001').className).toMatch(/rowInProgress/);
    for (const id of ['demo-t0002', 'demo-t0003', 'demo-t0004', 'demo-t0005']) {
      expect(queueRowOf(id).className).not.toMatch(/rowInProgress/);
    }
  });

  /** A `--rag-inprogress-row*` token: its share of the owner's blue, and the ground it is mixed into. */
  function tint(name: string): { share: number; ground: string; hex: string } {
    const css = readFileSync(resolve(__dirname, '../../../ui/src/tokens.css'), 'utf8');
    const m = new RegExp(
      `${name}:\\s*color-mix\\(in srgb, var\\(--rag-inprogress\\) (\\d+)%, var\\((--rag-[a-z0-9-]+)\\)\\);`,
    ).exec(css);
    expect(m, name).not.toBeNull();
    const share = Number(m![1]) / 100;
    const t = tokens();
    const ground = t[m![2]!]!;
    return { share, ground: m![2]!, hex: mix(t['--rag-inprogress']!, ground, share) };
  }

  it('tints an in-progress row a dark navy near its neighbours, deeper under the pointer (rag-t0033)', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    expect(sheet).toMatch(
      /\.rowInProgress:not\(\.lifted\)\s*\{\s*background:\s*var\(--rag-inprogress-row\);\s*\}/,
    );
    expect(sheet).toMatch(
      /\.rowInProgress:not\(\.lifted\):hover\s*\{\s*background:\s*var\(--rag-inprogress-row-hover\);\s*\}/,
    );
    // rag-t0029's solid fill is gone.
    expect(sheet).not.toMatch(/background:\s*var\(--rag-inprogress\);/);
    const t = tokens();
    expect(t['--rag-inprogress']).toBe('#0b61ac');
    const rest = tint('--rag-inprogress-row');
    const hover = tint('--rag-inprogress-row-hover');
    // A low share of the blue over the row's own ground, the panel.
    expect(rest.ground).toBe('--rag-surface');
    expect(hover.ground).toBe('--rag-surface');
    expect(rest.share).toBeGreaterThanOrEqual(0.15);
    expect(rest.share).toBeLessThanOrEqual(0.25);
    expect(rest.hex).toBe('#162839');
    // Clearly apart from a plain row (more than a plain row's hover step) but
    // close to it: nowhere near the solid blue's step.
    const plainStep = contrast(t['--rag-surface2']!, t['--rag-surface']!);
    expect(contrast(rest.hex, t['--rag-surface']!)).toBeGreaterThan(plainStep);
    expect(contrast(rest.hex, t['--rag-surface']!)).toBeLessThan(1.3);
    expect(contrast(t['--rag-inprogress']!, t['--rag-surface']!)).toBeGreaterThan(2);
    // A dark navy: blue-led, and dark in every channel.
    const [r, g, b] = channels(rest.hex);
    expect(b).toBeGreaterThan(r! + 20);
    expect(Math.max(r!, g!, b!)).toBeLessThan(80);
    // The hover is the same tint a visible step deeper.
    expect(hover.share).toBeGreaterThan(rest.share);
    expect(contrast(hover.hex, rest.hex)).toBeGreaterThanOrEqual(1.05);
  });

  it('keeps the palette’s own foregrounds on an in-progress row, each 4.5:1 on the tint and its hover (rag-t0033)', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    // No re-pointing of the foregrounds, and no on-blue family left behind.
    expect(sheet).not.toMatch(/\.rowInProgress\s*\{/);
    expect(sheet).not.toMatch(/--rag-on-inprogress/);
    const tokensCss = readFileSync(resolve(__dirname, '../../../ui/src/tokens.css'), 'utf8');
    expect(tokensCss).not.toMatch(/--rag-on-inprogress|--rag-inprogress-hover:/);
    const t = tokens();
    const grounds = [tint('--rag-inprogress-row').hex, tint('--rag-inprogress-row-hover').hex];
    for (const role of ['bright', 'text', 'dim', 'acc', 'good', 'warn', 'crit']) {
      for (const ground of grounds) {
        expect(
          contrast(t[`--rag-${role}`]!, ground),
          `${role} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Why the hover is not the tint over a plain row's hover grey: dim fails there.
    const overGrey = mix(
      t['--rag-inprogress']!,
      t['--rag-surface2']!,
      tint('--rag-inprogress-row').share,
    );
    expect(contrast(t['--rag-dim']!, overGrey)).toBeLessThan(4.5);
  });

  /** A `--rag-tint-*` share token, as a fraction. */
  function tintShare(name: string): number {
    const css = readFileSync(resolve(__dirname, '../../../ui/src/tokens.css'), 'utf8');
    const m = new RegExp(`${name}:\\s*(\\d+)%;`).exec(css);
    expect(m, name).not.toBeNull();
    return Number(m![1]) / 100;
  }

  /**
   * A row's tinted controls, at rest and under the pointer: the Approve
   * (`accent`) and Unblock (`caution`) buttons and the ratify pill. Each fill
   * is its role at a `--rag-tint-*` share over the row; a hovered one's text
   * is its role lifted by `--rag-tint-lift` of `--rag-bright` (rag-t0034).
   */
  function tintedControls(): Array<{
    what: string;
    role: string;
    rest: string;
    hover: string;
  }> {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    const button = readFileSync(
      resolve(__dirname, '../../../ui/src/components/Button.module.css'),
      'utf8',
    );
    const body = (css: string, selector: RegExp) => {
      const m = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, String(selector)).not.toBeNull();
      return m![1]!;
    };
    const fillShare = (text: string, role: string, what: string) => {
      const m = new RegExp(
        `background:\\s*color-mix\\(in srgb, var\\(--rag-${role}\\) var\\((--rag-tint-[a-z-]+)\\), transparent\\);`,
      ).exec(text);
      expect(m, what).not.toBeNull();
      return m![1]!;
    };
    const lifted = (text: string, role: string, what: string) => {
      expect(text, what).toMatch(
        new RegExp(
          `color:\\s*color-mix\\(in srgb, var\\(--rag-bright\\) var\\(--rag-tint-lift\\), var\\(--rag-${role}\\)\\);`,
        ),
      );
    };
    const out: Array<{ what: string; role: string; rest: string; hover: string }> = [];
    for (const [what, css, restSel, hoverSel, role] of [
      ['Approve (accent)', button, /\.accent/, /\.accent:hover:not\(:disabled\)/, 'acc'],
      ['Unblock (caution)', button, /\.caution/, /\.caution:hover:not\(:disabled\)/, 'warn'],
      [
        'ratify pill',
        sheet,
        /\.approvalButton > span/,
        /\.approvalButton:hover > span,\s*\.approvalButton:focus-visible > span/,
        'warn',
      ],
    ] as const) {
      const hoverBody = body(css, hoverSel);
      lifted(hoverBody, role, what);
      out.push({
        what,
        role,
        rest: fillShare(body(css, restSel), role, what),
        hover: fillShare(hoverBody, role, what),
      });
    }
    return out;
  }

  it('draws an in-progress row’s buttons and ratify pill as on any row, readable over the tint (rag-t0033)', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    // rag-t0029's dark control fills are gone.
    expect(sheet).not.toMatch(/\.rowInProgress \.(cellMeta|approvalButton)/);
    const t = tokens();
    const rest = tint('--rag-inprogress-row').hex;
    for (const c of tintedControls()) {
      const fg = t[`--rag-${c.role}`]!;
      const ground = mix(fg, rest, tintShare(c.rest));
      expect(contrast(fg, ground), c.what).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps hovered Approve, Unblock and ratify-pill text at 4.5:1 on plain, highlighted and in-progress rows (rag-t0034)', () => {
    const t = tokens();
    // Under the pointer the row is hovered too: a plain row's hover is the
    // highlighted ground, surface2; an in-progress row's is its deeper tint.
    // Keyboard focus lights the pill on a row at rest, so those count too.
    const grounds: Record<string, string> = {
      plain: t['--rag-surface']!,
      'plain or highlighted, hovered': t['--rag-surface2']!,
      'in progress': tint('--rag-inprogress-row').hex,
      'in progress, hovered': tint('--rag-inprogress-row-hover').hex,
    };
    const lift = tintShare('--rag-tint-lift');
    for (const c of tintedControls()) {
      const role = t[`--rag-${c.role}`]!;
      const text = mix(t['--rag-bright']!, role, lift);
      // The hover is still a lift: a deeper fill than at rest.
      expect(tintShare(c.hover), c.what).toBeGreaterThan(tintShare(c.rest));
      for (const [where, row] of Object.entries(grounds)) {
        const ground = mix(role, row, tintShare(c.hover));
        expect(contrast(text, ground), `${c.what} on ${where}`).toBeGreaterThanOrEqual(4.5);
      }
      // Without the lifted text, the deeper fill fails on the in-progress hover.
      const deep = mix(role, grounds['in progress, hovered']!, tintShare(c.hover));
      expect(contrast(role, deep), c.what).toBeLessThan(4.5);
    }
    // The pill lifts with the caution button's tokens, not a share of its own.
    const [, caution, pill] = tintedControls();
    expect(pill!.rest).toBe(caution!.rest);
    expect(pill!.hover).toBe(caution!.hover);
  });

  it('draws the in-progress row’s Approve, ratify pill and Unblock in its row, Approve still the tinted button', async () => {
    view = queueView({
      queue: [
        item('demo-t0001', { status: 'in_progress', approval: 'unapproved' }),
        item('demo-t0002', { status: 'in_progress', approval: 'agent' }),
      ],
      blocked: [
        item('demo-t0006', { status: 'in_progress', blocked: true, block_reason: 'review' }),
      ],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const approve = screen.getByRole('button', { name: 'Approve demo-t0001' });
    expect(approve.closest('li')!.className).toMatch(/rowInProgress/);
    expect(approve.className).toMatch(/accent/);
    const ratify = screen.getByRole('button', { name: 'Agent-approved: ratify demo-t0002' });
    expect(ratify.className).toMatch(/approvalButton/);
    expect(ratify.closest('li')!.className).toMatch(/rowInProgress/);
    const blocked = within(section('Blocked')).getAllByRole('listitem')[0]!;
    expect(blocked.className).toMatch(/rowInProgress/);
    expect(within(blocked).getByRole('button', { name: 'Unblock' })).toBeInTheDocument();
  });

  it('draws Approve as the design system’s tinted button, not a ghost (rag-t0025)', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const approve = screen.getByRole('button', { name: 'Approve demo-t0005' });
    expect(approve.className).toMatch(/accent/);
    expect(approve.className).not.toMatch(/ghost/);
  });

  it('fills the ratify badge at rest and deepens it on hover and focus, never to a row’s colour', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    expect(sheet).toMatch(
      /\.approvalButton > span\s*\{\s*background:\s*color-mix\(in srgb, var\(--rag-warn\) var\(--rag-tint-warn\), transparent\);/,
    );
    const hover =
      /\.approvalButton:hover > span,\s*\.approvalButton:focus-visible > span\s*\{([^}]*)\}/.exec(
        sheet,
      );
    expect(hover).not.toBeNull();
    expect(hover![1]).toMatch(/var\(--rag-warn\)/);
    expect(hover![1]).not.toMatch(/--rag-surface2|--rag-acc/);
  });

  it('draws a queue row on two lines: status, id, title and approval, then type and assignee (rag-t0026)', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const row = queueRowOf('demo-t0001');
    const line2 = row.querySelector('[class*="cellLine2"]')!;
    expect(line2).not.toBeNull();
    // Line one: the status, the id, the title; none of them on line two.
    for (const text of ['In progress', 'demo-t0001', 'Being built']) {
      expect(line2.contains(within(row).getByText(text))).toBe(false);
    }
    // Line two: the type and the assignee; no link chips (rag-t0031).
    expect(within(line2 as HTMLElement).getByText('Dev')).toBeInTheDocument();
    expect(within(line2 as HTMLElement).getByText('dev-3')).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /demo-0042/ })).toBeNull();
    // The menu stays on line one.
    expect(
      line2.contains(within(row).getByRole('button', { name: 'Actions for demo-t0001' })),
    ).toBe(false);
    // A gate marker stays one line.
    expect(queueRowOf('demo-t0003').querySelector('[class*="cellLine2"]')).toBeNull();
  });

  it('gives every Done, Review, Blocked and Deferred row the second line, its actions on the first', async () => {
    view = queueView({
      review: [item('demo-t0011', { status: 'review' })],
      deferred: [item('demo-t0007', { status: 'deferred' })],
    });
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const cases: Array<[string, string | null]> = [
      ['Done', null],
      ['Review', 'Confirm demo-t0011'],
      ['Blocked', 'Unblock'],
      ['Deferred', 'Resume'],
    ];
    for (const [name, action] of cases) {
      const row = within(section(name)).getAllByRole('listitem')[0]!;
      const line2 = row.querySelector('[class*="cellLine2"]');
      expect(line2, name).not.toBeNull();
      expect(within(line2 as HTMLElement).getByText('Dev')).toBeInTheDocument();
      if (action !== null) {
        const button = within(row).getByRole('button', { name: action });
        expect(line2!.contains(button), name).toBe(false);
        expect(button.closest('[class*="cellMeta"]'), name).not.toBeNull();
      }
    }
    // Blocked: the reason is on line two.
    const blocked = within(section('Blocked')).getAllByRole('listitem')[0]!;
    expect(
      blocked
        .querySelector('[class*="cellLine2"]')!
        .contains(within(blocked).getByText('Needs review')),
    ).toBe(true);
  });

  it('lays the two lines out at a phone’s width with the title wrapping, and nothing wider', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    const phone = sheet.slice(sheet.indexOf('@media (max-width: 40rem)'));
    expect(phone).toMatch(/\.row\s*\{[^}]*'grip line2 line2 menu'/);
    expect(phone).toMatch(/\.flatRow\s*\{[^}]*'line2 line2'/);
    expect(phone).toMatch(/\.row \.cellTitle\s*\{[^}]*white-space:\s*normal;/);
    expect(phone).toMatch(/\.flatRow \.cellTitle\s*\{[^}]*white-space:\s*normal;/);
    // The second line wraps rather than widening the page.
    expect(sheet).toMatch(/\.cellLine2\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/);
    // The labels at its right end (rag-t0031) wrap from the right, and a long
    // one is cut with an ellipsis rather than drawn wider than the row.
    expect(sheet).toMatch(/\.line2End > \.labels\s*\{[^}]*justify-content:\s*flex-end;/);
    expect(sheet).toMatch(/\.labels\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/);
    expect(sheet).toMatch(/\.label\s*\{[^}]*max-width:\s*min\(14rem, 100%\);/);
    expect(sheet).toMatch(/\.label > span\s*\{[^}]*text-overflow:\s*ellipsis;/);
  });

  it('still turns a drag over taller two-line rows into one move before the first', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = Number(this.dataset.index ?? 0);
      return {
        top: index * 64,
        bottom: index * 64 + 64,
        height: 64,
        left: 0,
        right: 600,
        width: 600,
        x: 0,
        y: index * 64,
        toJSON: () => ({}),
      } as DOMRect;
    });
    server.on(/\/tracker\/items\/[^/]+\/move$/, (sent) => ({
      body: item(sent.path.split('/')[3]!),
    }));
    open();
    await screen.findByRole('heading', { name: 'demo' });

    const grip = screen.getByRole('button', { name: 'Drag demo-t0004 to reorder' });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientY: 220 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 4 });
    // The rows it passed step aside by a whole two-line row.
    expect(screen.getByRole('listitem', { name: /demo-t0001/ }).style.transform).toBe(
      'translateY(64px)',
    );
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 4 });
    await waitFor(() => expect(server.matching(/\/move$/)).toHaveLength(1));
    expect(server.last(/\/move$/).body).toMatchObject({ before: 'demo-t0001' });
  });
});
