/**
 * Requests (rag-t0044): the owner's idea, filed with **Add request**, listed in
 * its own section above Review and never in the queue, drawn with its own
 * Request badge; a ticket broken out of one names it (*From request*), and the
 * request's page lists what it became. `became` is the server's link: the Edit
 * dialog neither offers it nor removes it, and a request takes no `from`.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { addableLinkKinds } from '../tracker/ItemActions';
import { ItemView } from '../tracker/ItemView';
import { linkHref } from '../tracker/paths';
import { QueueView } from '../tracker/QueueView';
import type { QueueView as QueueViewRecord } from '../tracker/types';
import { itemTypeLabel, linkKindLabel } from '../tracker/vocab';
import { mountAt } from './harness';
import { TrackerServer, item, queueRoute, queueView } from './trackerFixtures';

const REQUEST = item('demo-t0020', {
  type: 'request',
  title: 'Weather',
  body: 'Rain, then snow. Before the audio work.',
  approval: 'owner',
  links: [
    { kind: 'became', target: 'demo-t0021' },
    { kind: 'became', target: 'demo-t0022' },
  ],
  events: [],
});

const TICKET = item('demo-t0021', {
  type: 'design',
  title: 'Rain art',
  approval: 'agent',
  links: [
    { kind: 'from', target: 'demo-t0020' },
    { kind: 'ledger', target: 'demo-0042' },
  ],
  events: [],
});

let server: TrackerServer;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the dashboard', () => {
  let view: QueueViewRecord;

  beforeEach(() => {
    view = queueView({
      requests: [REQUEST],
      review: [item('demo-t0008', { status: 'review', title: 'Check me' })],
    });
    server = new TrackerServer();
    server.on('/tracker/projects', { body: { projects: [] } });
    server.on(
      /^\/tracker\/demo$/,
      queueRoute(() => view),
      'GET',
    );
    server.install();
  });

  function open() {
    return mountAt('/projects/:project', <QueueView />, { route: '/projects/demo' });
  }

  it('lists requests in their own section, above Review, and never in the queue', async () => {
    open();
    await screen.findByRole('heading', { name: 'demo' });
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Done', 'Requests', 'Review', 'Queue', 'Blocked']);

    const requests = screen.getByRole('region', { name: 'Requests' });
    const rows = within(requests).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-id'))).toEqual(['demo-t0020']);
    expect(within(rows[0]!).getByRole('link', { name: 'Weather' })).toBeInTheDocument();
    // The Request badge: its own word, glyph slot and colour hook.
    const badge = rows[0]!.querySelector('[data-type="request"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent(itemTypeLabel('request'));

    const queue = within(screen.getByRole('list', { name: 'Queue' })).getAllByRole('listitem');
    expect(queue.map((row) => row.getAttribute('data-id'))).not.toContain('demo-t0020');
  });

  it('draws no Requests section when there are none', async () => {
    view = queueView();
    open();
    await screen.findByRole('heading', { name: 'demo' });
    expect(screen.queryByRole('region', { name: 'Requests' })).toBeNull();
  });

  // 2026-10-31 (owner): the whole form takes a dropped file, once.
  it.each([
    ['the request box', (dialog: HTMLElement) => within(dialog).getByLabelText('Request')],
    [
      'the hint under it',
      (dialog: HTMLElement) => within(dialog).getByText(/paste or drop a file/),
    ],
    ['the title', (dialog: HTMLElement) => within(dialog).getByLabelText('Title')],
  ])('takes a file dropped on %s, into the request', async (_where, spot) => {
    const user = userEvent.setup();
    const UPLOAD = '/tracker/demo/attachments';
    server.on(
      UPLOAD,
      {
        body: {
          id: 1,
          project: 'demo',
          sha256: 'a1b2c3d4e5f6',
          name: 'gate.log',
          media_type: 'text/plain',
          size: 3,
          ref: 'att:a1b2c3d4e5f6',
          author_email: 'a@example.com',
          agent: 'Owner',
          surface: 'web',
          uploaded_at: '2026-01-01T00:00:00Z',
        },
      },
      'POST',
    );
    open();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Add request' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a request' });
    const dataTransfer = {
      files: [new File(['log'], 'gate.log', { type: 'text/plain' })],
      types: ['Files'],
    };

    expect(fireEvent.dragOver(spot(dialog), { dataTransfer })).toBe(false);
    fireEvent.drop(spot(dialog), { dataTransfer });

    await waitFor(() =>
      expect(within(dialog).getByLabelText('Request')).toHaveValue('[gate.log](att:a1b2c3d4e5f6)'),
    );
    expect(server.matching(UPLOAD, 'POST')).toHaveLength(1);
  });

  it('files a request with its title and text, owner-approved by default', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: REQUEST }, 'POST');
    open();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add request' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a request' });
    // The request text is a bigger box than an item's body.
    const text = within(dialog).getByLabelText('Request');
    expect(Number(text.getAttribute('rows'))).toBeGreaterThan(8);
    expect(
      within(dialog).getByRole('checkbox', { name: 'Create it owner-approved' }),
    ).toBeChecked();
    // A title is needed: nothing is sent without one.
    await user.click(within(dialog).getByRole('button', { name: 'File the request' }));
    expect(within(dialog).getByText('A request needs a title.')).toBeInTheDocument();
    expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Title'), 'Weather');
    await user.type(text, 'Rain, then snow.');
    await user.click(within(dialog).getByRole('button', { name: 'File the request' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toEqual({
      type: 'request',
      title: 'Weather',
      body: 'Rain, then snow.',
      approval: 'owner',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });
});

describe('the item page', () => {
  function open(id: string) {
    return mountAt('/projects/:project/ticket/:id', <ItemView />, {
      route: `/projects/demo/ticket/${id}`,
    });
  }

  beforeEach(() => {
    server = new TrackerServer();
    server.on('/tracker/items/demo-t0020', { body: REQUEST }, 'GET');
    server.on('/tracker/items/demo-t0021', { body: TICKET }, 'GET');
    server.on('/tracker/items/demo-t0021?history=false', { body: TICKET }, 'GET');
    // The second ticket cannot be read: it stays its id, still a link.
    server.on('/tracker/items/demo-t0022?history=false', { status: 404, body: { error: 'no' } });
    server.install();
  });

  it('lists what a request became, each a link, with its title once read', async () => {
    open('demo-t0020');
    await screen.findByRole('heading', { name: 'Weather' });
    const became = screen.getByText('Became · 2 tickets').closest('section') ?? document.body;
    expect(await within(became).findByText('Rain art')).toBeInTheDocument();
    expect(within(became).getByRole('link', { name: 'demo-t0021' })).toHaveAttribute(
      'href',
      '/projects/demo/ticket/demo-t0021',
    );
    expect(within(became).getByRole('link', { name: 'demo-t0022' })).toBeInTheDocument();
    // Not repeated under Links: the request has no other link.
    expect(screen.queryByText('Links')).toBeNull();
  });

  it('says a request not yet broken down', async () => {
    server.onceOn('/tracker/items/demo-t0020', { body: { ...REQUEST, links: [] } }, 'GET');
    open('demo-t0020');
    await screen.findByRole('heading', { name: 'Weather' });
    expect(screen.getByText('Became · 0 tickets')).toBeInTheDocument();
    expect(screen.getByText('Not broken down yet.')).toBeInTheDocument();
  });

  it('names the request a ticket came from, and keeps other links under Links', async () => {
    open('demo-t0021');
    await screen.findByRole('heading', { name: 'Rain art' });
    const from = screen.getByText('From request').closest('div') ?? document.body;
    expect(within(from).getByRole('link', { name: 'demo-t0020' })).toHaveAttribute(
      'href',
      '/projects/demo/ticket/demo-t0020',
    );
    const links = screen.getByText('Links').closest('section') ?? document.body;
    expect(within(links).getByText('demo-0042')).toBeInTheDocument();
    expect(within(links).queryByText('demo-t0020')).toBeNull();
    expect(screen.queryByText(/^Became/)).toBeNull();
  });

  it('never offers became in Edit, nor a way to remove one, and no from on a request', async () => {
    const user = userEvent.setup();
    open('demo-t0020');
    await screen.findByRole('heading', { name: 'Weather' });
    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Edit demo-t0020' });
    const kinds = within(within(dialog).getByRole('combobox', { name: 'Link kind' }))
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(kinds).not.toContain('became');
    expect(kinds).not.toContain('from');
    expect(within(dialog).queryByRole('button', { name: /Remove link demo-t0021/ })).toBeNull();
    // A request is never dispatched, so it is never parallel.
    expect(within(dialog).queryByRole('checkbox', { name: /^Parallel/ })).toBeNull();
  });
});

describe('the vocabulary', () => {
  it('offers from on a ticket but never became, and neither on a request', () => {
    expect(addableLinkKinds('dev')).toContain('from');
    expect(addableLinkKinds('dev')).not.toContain('became');
    expect(addableLinkKinds('request')).not.toContain('from');
    expect(addableLinkKinds('request')).not.toContain('became');
  });

  it('links from and became to the item they name', () => {
    expect(linkHref('demo', { kind: 'from', target: 'demo-t0020' })).toBe(
      '/projects/demo/ticket/demo-t0020',
    );
    expect(linkHref('demo', { kind: 'became', target: 'demo-t0021' })).toBe(
      '/projects/demo/ticket/demo-t0021',
    );
    expect(linkKindLabel('from')).toBe('From request');
    expect(linkKindLabel('became')).toBe('Became');
  });
});
