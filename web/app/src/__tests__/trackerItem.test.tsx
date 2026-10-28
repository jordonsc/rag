/**
 * The item page (specs/tracker m03, TD-06): the record, its body with `att:`
 * images resolved, its links, its history with the surface and agent on every
 * entry, and its writes, each one `POST /tracker/items/{id}` with
 * `surface: 'web'`; a note optional on every write but Add note (D7, amended
 * by the owner 2026-10-27).
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ItemView } from '../tracker/ItemView';
import { dependencyCandidates, editBody } from '../tracker/ItemActions';
import { NOTE_ROWS } from '../tracker/dialogs';
import { mountAt } from './harness';
import { EVENTS, TrackerServer, gateItem, item } from './trackerFixtures';

const ID = 'demo-t0002';
const PATH = `/tracker/items/${ID}`;

let server: TrackerServer;

const RECORD = item(ID, {
  title: 'Next up',
  approval: 'agent',
  body: 'The brief.\n\n![terrain](att:3fa9c2e1b07d)',
  prev_id: 'demo-t0001',
  next_id: 'demo-t0003',
  links: [
    { kind: 'ledger', target: 'demo-0042' },
    { kind: 'milestone', target: 'audio/m03' },
    { kind: 'spec', target: 'audio' },
  ],
  events: EVENTS,
});

beforeEach(() => {
  server = new TrackerServer();
  server.on(PATH, { body: RECORD }, 'GET');
  server.on(PATH, { body: RECORD }, 'POST');
  server.on('/tracker/demo/specs/audio/milestones/m03', {
    body: { path: 'specs/audio/m03-music.md' },
  });
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(options: { identity?: string | null } = {}) {
  return mountAt('/projects/:project/ticket/:id', <ItemView />, {
    route: `/projects/demo/ticket/${ID}`,
    ...options,
  });
}

describe('the item page', () => {
  it('renders the record, the body with its attachment, and the links', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Next up' })).toBeInTheDocument();
    // The badge in the head (the history's create entry says it too).
    expect(screen.getAllByText('Agent-approved')[0]).toBeInTheDocument();

    const image = screen.getByRole('img', { name: 'terrain' });
    expect(image).toHaveAttribute('src', '/tracker/attachments/3fa9c2e1b07d');

    expect(screen.getByRole('link', { name: 'demo-0042' })).toHaveAttribute(
      'href',
      '/topic/demo-0042',
    );
    expect(screen.getByRole('link', { name: 'audio' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/master.md',
    );
    // A milestone's path holds its name, so it is looked up before it links.
    expect(await screen.findByRole('link', { name: 'audio/m03' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/m03-music.md',
    );
    expect(screen.getByRole('link', { name: 'demo-t0001' })).toHaveAttribute(
      'href',
      '/projects/demo/ticket/demo-t0001',
    );
  });

  it('shows the history in order with the surface and the agent on each entry', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    const entries = screen
      .getAllByRole('listitem')
      .filter((entry) => entry.hasAttribute('data-kind'));
    expect(entries.map((entry) => entry.getAttribute('data-kind'))).toEqual(['create', 'note']);

    const created = within(entries[0]!);
    expect(created.getByText('agent@example.com')).toBeInTheDocument();
    expect(created.getByText(/Some Model 1/)).toBeInTheDocument();
    expect(created.getByText('MCP')).toBeInTheDocument();
    expect(created.getByText('to the bottom')).toBeInTheDocument();

    const noted = within(entries[1]!);
    expect(noted.getByText(/you, on the web/)).toBeInTheDocument();
    expect(noted.getByText('web')).toBeInTheDocument();
  });

  it('ratifies an agent’s approval by sending ratified, with a note', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: 'Ratify' }));
    const dialog = screen.getByRole('dialog', { name: 'Ratify the agent’s approval?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Read it, agreed');
    await user.click(within(dialog).getByRole('button', { name: 'Ratify' }));

    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      approval: 'ratified',
      note: 'Read it, agreed',
      author_email: 'alice@example.com',
      surface: 'web',
    });
    // Re-read by id after the write.
    await waitFor(() => expect(server.matching(PATH, 'GET')).toHaveLength(2));
  });

  it('approves an unapproved item as the owner', async () => {
    const user = userEvent.setup();
    server.onceOn(PATH, { body: { ...RECORD, approval: 'unapproved' } }, 'GET');
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    expect(screen.queryByRole('button', { name: 'Ratify' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve as the owner?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Go');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(server.last(PATH, 'POST').body).toMatchObject({ approval: 'owner', note: 'Go' }),
    );
  });

  it('changes the status with a note, offering the allowed transitions', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: /Status…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Change the status' });
    const select = within(dialog).getByLabelText('New status');
    const offered = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(offered).toEqual(['in_progress', 'done', 'failed', 'review', 'deferred', 'cancelled']);
    await user.selectOptions(select, 'in_progress');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'dispatched');
    await user.click(within(dialog).getByRole('button', { name: 'Change status' }));
    await waitFor(() =>
      expect(server.last(PATH, 'POST').body).toMatchObject({
        status: 'in_progress',
        note: 'dispatched',
        surface: 'web',
      }),
    );
  });

  it('blocks with a reason and a note', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: /Block…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Block this ticket' });
    await user.click(within(dialog).getByRole('radio', { name: 'Needs redesign' }));
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Wrong shape');
    await user.click(within(dialog).getByRole('button', { name: 'Block' }));

    await waitFor(() =>
      expect(server.last(PATH, 'POST').body).toMatchObject({
        blocked: true,
        block_reason: 'redesign',
        note: 'Wrong shape',
      }),
    );
  });

  it('blocks on a dependency, choosing what it waits on from the project’s queued items (rag-t0018)', async () => {
    const user = userEvent.setup();
    server.on(
      '/tracker/demo/items',
      {
        body: {
          project: 'demo',
          items: [
            item('demo-t0001', { title: 'Being built', status: 'in_progress' }),
            RECORD,
            item('demo-t0004', { title: 'Finished', status: 'done', queued: false }),
            item('demo-t0005', { title: 'The spec' }),
          ],
        },
      },
      'GET',
    );
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: /Block…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Block this ticket' });
    // No picker until the reason is a dependency.
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Waits on tickets' }));
    await waitFor(() => expect(server.matching('/tracker/demo/items', 'GET')).toHaveLength(1));

    // Nothing chosen: refused before any write.
    await user.click(within(dialog).getByRole('button', { name: 'Block' }));
    expect(
      await within(dialog).findByText('Choose at least one ticket it waits on.'),
    ).toBeInTheDocument();
    expect(server.matching(PATH, 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByRole('combobox'));
    // Itself and the done item are not offered.
    const offered = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    expect(offered.some((text) => text.includes('demo-t0001'))).toBe(true);
    expect(offered.some((text) => text.includes('demo-t0005'))).toBe(true);
    expect(offered.some((text) => text.includes(ID))).toBe(false);
    expect(offered.some((text) => text.includes('demo-t0004'))).toBe(false);
    await user.click(screen.getByRole('option', { name: /The spec/ }));
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /Being built/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Block' }));

    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      blocked: true,
      block_reason: 'dependency',
      depends_on: ['demo-t0005', 'demo-t0001'],
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('says what a dependency-blocked item waits on, each a link, and marks it parallel', async () => {
    const blocked = item(ID, {
      ...RECORD,
      blocked: true,
      block_reason: 'dependency',
      depends_on: ['demo-t0001', 'demo-t0005'],
      parallel: true,
      events: [
        ...EVENTS,
        {
          event_id: 3,
          ts: '2026-01-02T05:00:00Z',
          author_email: 'alice@example.com',
          agent: 'Unknown',
          surface: 'web',
          kind: 'unblock',
          body: 'Unblocked: demo-t0005 is done.',
          fields: { blocked: false, depends_on: [], unblocked_by: 'demo-t0005' },
        },
      ],
    });
    server.onceOn(PATH, { body: blocked }, 'GET');
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    expect(screen.getByText('Waits on tickets')).toBeInTheDocument();
    const waits = screen.getByText('waits on').parentElement!;
    expect(
      within(waits)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/projects/demo/ticket/demo-t0001', '/projects/demo/ticket/demo-t0005']);
    expect(screen.getByText('Parallel')).toBeInTheDocument();
    expect(screen.getByText('Unblocked: demo-t0005 is done.')).toBeInTheDocument();
  });

  it('sets parallel from Edit, and offers no box on a gate (rag-t0013)', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    const box = within(dialog).getByRole('checkbox', { name: /^Parallel/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      parallel: true,
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('changes the status with no note, sending none', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: /Status…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Change the status' });
    await user.selectOptions(within(dialog).getByLabelText('New status'), 'done');
    await user.click(within(dialog).getByRole('button', { name: 'Change status' }));

    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      status: 'done',
      author_email: 'alice@example.com',
      surface: 'web',
    });
    expect(within(dialog).queryByText('A note needs some text.')).toBeNull();
  });

  it('blocks and ratifies with no note', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: /Block…/ }));
    let dialog = screen.getByRole('dialog', { name: 'Block this ticket' });
    await user.click(within(dialog).getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      blocked: true,
      block_reason: 'review',
      author_email: 'alice@example.com',
      surface: 'web',
    });

    await user.click(await screen.findByRole('button', { name: 'Ratify' }));
    dialog = screen.getByRole('dialog', { name: 'Ratify the agent’s approval?' });
    await user.click(within(dialog).getByRole('button', { name: 'Ratify' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(2));
    expect(server.last(PATH, 'POST').body).toEqual({
      approval: 'ratified',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('adds a note, and never sends a blank one', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: 'Note' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a note' });
    // Required here: the label does not say optional.
    expect(within(dialog).queryByLabelText('Note (optional)')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }));
    expect(within(dialog).getByText('A note needs some text.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Note'), '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }));
    expect(server.matching(PATH, 'POST')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Note'), 'Checked the logs');
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      note: 'Checked the logs',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('edits only what changed', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Next up, renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Remove link demo-0042' }));
    await user.type(within(dialog).getByLabelText('Link target'), 'rag-t0003');
    await user.selectOptions(within(dialog).getByLabelText('Link kind'), 'item');
    await user.click(within(dialog).getByRole('button', { name: 'Add link' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      title: 'Next up, renamed',
      add_links: [{ kind: 'item', target: 'rag-t0003' }],
      remove_links: [{ kind: 'ledger', target: 'demo-0042' }],
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('opens the identity prompt instead of a write dialog when nobody is signed', async () => {
    const user = userEvent.setup();
    open({ identity: null });
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: 'Ratify' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
  });

  it('defers from its own button, keeping the note optional (rag-t0017)', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Defer' }));
    const dialog = screen.getByRole('dialog', { name: 'Defer this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Defer' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      status: 'deferred',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('shows a deferred item as deferred, blocked or not, and resumes it', async () => {
    const user = userEvent.setup();
    server.onceOn(
      PATH,
      {
        body: {
          ...RECORD,
          status: 'deferred',
          blocked: true,
          block_reason: 'review',
          block_note: 'Later',
        },
      },
      'GET',
    );
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    // The dot says Deferred (teal), not Blocked, and no underlying status is added.
    const dot = document.querySelector('[data-state]');
    expect(dot).toHaveAttribute('data-state', 'deferred');
    expect(dot).toHaveTextContent('Deferred');
    expect(screen.queryByText('(Deferred)')).toBeNull();
    // The block is still shown.
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    // Resume, not Defer.
    expect(screen.queryByRole('button', { name: 'Defer' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Status…/ }));
    const statusDialog = screen.getByRole('dialog', { name: 'Change the status' });
    const select = within(statusDialog).getByLabelText('New status');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['pending', 'in_progress', 'done', 'cancelled']);
    expect(within(select).getByRole('option', { name: 'Resume (pending, in place)' })).toBeTruthy();
    await user.click(within(statusDialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    const dialog = screen.getByRole('dialog', { name: 'Resume this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      status: 'pending',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('confirms or sends back an item in review from its own buttons (rag-t0024)', async () => {
    const user = userEvent.setup();
    // Every read in this test answers review: the write's re-read included.
    for (let read = 0; read < 6; read += 1) {
      server.onceOn(PATH, { body: { ...RECORD, status: 'review' } }, 'GET');
    }
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    // Red, in its own word and shape: not failed.
    const dot = document.querySelector('[data-state]');
    expect(dot).toHaveAttribute('data-state', 'review');
    expect(dot).toHaveTextContent('Review');
    expect(dot).not.toHaveTextContent('Failed');
    // A review item may be deferred from its page (owner, 2026-10-28).
    expect(screen.getByRole('button', { name: 'Defer' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Status…/ }));
    const statusDialog = screen.getByRole('dialog', { name: 'Change the status' });
    const select = within(statusDialog).getByLabelText('New status');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['done', 'in_progress', 'pending', 'deferred', 'cancelled']);
    await user.click(within(statusDialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    let dialog = screen.getByRole('dialog', { name: 'Confirm this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      status: 'done',
      author_email: 'alice@example.com',
      surface: 'web',
    });

    await user.click(await screen.findByRole('button', { name: 'Send back' }));
    dialog = screen.getByRole('dialog', { name: 'Send this ticket back?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Fix the copy');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(2));
    expect(server.last(PATH, 'POST').body).toEqual({
      status: 'in_progress',
      note: 'Fix the copy',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('puts Confirm and Send back on a row of their own, green and amber (rag-t0041)', async () => {
    server.onceOn(PATH, { body: { ...RECORD, status: 'review' } }, 'GET');
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    const row = screen.getByRole('group', { name: 'Review' });
    const confirm = within(row).getByRole('button', { name: 'Confirm' });
    const sendBack = within(row).getByRole('button', { name: 'Send back' });
    expect(within(row).getAllByRole('button')).toEqual([confirm, sendBack]);
    // Under the other writes, not among them.
    const first = screen.getByRole('button', { name: 'Note' }).parentElement!;
    expect(first).not.toContainElement(confirm);
    expect(first.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The done green and the blocked amber (the design system's tinted controls).
    expect(confirm).toHaveClass('good');
    expect(sendBack).toHaveClass('caution');
  });

  it('gives Send back a note box twice the height of the others (rag-t0045)', async () => {
    const user = userEvent.setup();
    for (let read = 0; read < 3; read += 1) {
      server.onceOn(PATH, { body: { ...RECORD, status: 'review' } }, 'GET');
    }
    open();
    await screen.findByRole('heading', { name: 'Next up' });

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const confirm = screen.getByRole('dialog', { name: 'Confirm this ticket?' });
    const normal = Number(within(confirm).getByLabelText('Note (optional)').getAttribute('rows'));
    expect(normal).toBe(NOTE_ROWS);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const sendBack = screen.getByRole('dialog', { name: 'Send this ticket back?' });
    const rows = Number(within(sendBack).getByLabelText('Note (optional)').getAttribute('rows'));
    expect(rows).toBe(normal * 2);
  });

  it('draws no review row for an item not in review', async () => {
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    expect(screen.queryByRole('group', { name: 'Review' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Note' })).toBeInTheDocument();
  });

  it('offers a pending item review, and no Confirm or Send back', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send back' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Status…/ }));
    const select = within(screen.getByRole('dialog', { name: 'Change the status' })).getByLabelText(
      'New status',
    );
    expect(
      within(select).getByRole('option', { name: 'Review (waits on the owner, keeps its place)' }),
    ).toBeTruthy();
  });

  it('offers no approval block reason: review replaced it (rag-t0024)', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Next up' });
    await user.click(screen.getByRole('button', { name: /Block…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Block this ticket' });
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label') ?? radio.textContent),
    ).not.toContain('Needs approval');
    expect(within(dialog).queryByText('Needs approval')).toBeNull();
    expect(within(dialog).getByRole('radio', { name: 'Needs review' })).toBeInTheDocument();
  });

  it('names an unknown item', async () => {
    server.onceOn(PATH, { status: 404, body: { error: 'no ticket demo-t0002' } }, 'GET');
    open();
    expect(await screen.findByText(`There is no ticket ${ID}.`)).toBeInTheDocument();
  });
});

describe('editBody', () => {
  it('sends a gate’s intensity and release only when they changed', () => {
    const gate = gateItem('demo-t0003');
    const same = {
      title: gate.title,
      body: gate.body,
      assignee: '',
      links: [],
      intensity: gate.intensity,
      release: gate.release,
    };
    expect(editBody(gate, same)).toEqual({});
    expect(editBody(gate, { ...same, intensity: 'full', release: true })).toEqual({
      intensity: 'full',
      release: true,
    });
  });

  it('sends parallel only when it changed, and never for a gate', () => {
    const work = item('demo-t0001');
    const same = {
      title: work.title,
      body: '',
      assignee: '',
      links: [],
      intensity: null,
      release: false,
    };
    expect(editBody(work, { ...same, parallel: false })).toEqual({});
    expect(editBody(work, { ...same, parallel: true })).toEqual({ parallel: true });
    expect(editBody(item('demo-t0001', { parallel: true }), { ...same, parallel: false })).toEqual({
      parallel: false,
    });
    const gate = gateItem('demo-t0003');
    expect(
      editBody(gate, {
        ...same,
        title: gate.title,
        intensity: gate.intensity,
        parallel: true,
      }),
    ).toEqual({});
  });

  it('offers only the other queued items as dependencies', () => {
    const self = item('demo-t0002');
    const offered = dependencyCandidates(self, [
      item('demo-t0001'),
      self,
      item('demo-t0003', { status: 'done', queued: false }),
      item('demo-t0004', { status: 'cancelled', queued: false }),
      item('demo-t0005', { status: 'deferred' }),
    ]);
    expect(offered.map((candidate) => candidate.id)).toEqual(['demo-t0001', 'demo-t0005']);
  });

  it('never sends gate fields for an item that is not a gate', () => {
    const work = item('demo-t0001');
    expect(
      editBody(work, {
        title: work.title,
        body: '',
        assignee: 'dev-1',
        links: [],
        intensity: 'quick',
        release: true,
      }),
    ).toEqual({ assignee: 'dev-1' });
  });
});
