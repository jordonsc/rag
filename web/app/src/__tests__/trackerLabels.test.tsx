/**
 * Item labels (rag-t0027), against a `fetch` double.
 *
 * What it defends: the label rules the client applies before a write (the
 * server's: trimmed, at most 32 characters, no comma or control character, at
 * most ten, merged case-insensitively in the project's casing); the chips on a
 * row's second line, at its right end where the link chips were (rag-t0031),
 * each a link to the dashboard
 * filtered to it; the dashboard's label filter, kept in the URL, which keeps
 * the gates and turns reordering off; the editor on Add item and the item
 * page's Edit, suggesting the project's labels and sending the set
 * wholesale; and the History page's label filter.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createItem, listLabels, trackerAuthor, updateItem } from '../tracker/api';
import { HistoryView } from '../tracker/HistoryView';
import { ItemView } from '../tracker/ItemView';
import { editBody } from '../tracker/ItemActions';
import { addTyped, offeredLabels } from '../tracker/LabelEditor';
import {
  cleanLabels,
  hasLabel,
  LABEL_MAX,
  labelProblem,
  labelsIn,
  normaliseLabel,
  sameLabels,
} from '../tracker/labels';
import { QueueView } from '../tracker/QueueView';
import type { LabelCount, QueueView as QueueViewRecord } from '../tracker/types';
import { mountAt } from './harness';
import { TrackerServer, gateItem, item, queueRoute, queueView } from './trackerFixtures';

const QUEUE = /^\/tracker\/demo$/;
const LABELS = '/tracker/demo/labels';
const VOCABULARY: LabelCount[] = [
  { label: 'Biomes', count: 1, queued: 1 },
  { label: 'Physics', count: 4, queued: 2 },
  { label: 'Creatures', count: 2, queued: 2 },
];

let server: TrackerServer;
let view: QueueViewRecord;

beforeEach(() => {
  view = queueView({
    queue: [
      item('demo-t0001', {
        status: 'in_progress',
        assignee: 'dev-3',
        labels: ['Biomes', 'Physics'],
        links: [{ kind: 'ledger', target: 'demo-0042' }],
      }),
      item('demo-t0002', { labels: ['Creatures'] }),
      gateItem('demo-t0003'),
      item('demo-t0004', { labels: ['physics'] }),
      item('demo-t0005'),
    ],
  });
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
  server.on(
    QUEUE,
    queueRoute(() => view),
    'GET',
  );
  server.on(LABELS, { body: { project: 'demo', labels: VOCABULARY } }, 'GET');
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openDashboard(route = '/projects/demo') {
  return mountAt('/projects/:project', <QueueView />, { route });
}

function queueIds(): string[] {
  return within(screen.getByRole('list', { name: 'Queue' }))
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('data-id') ?? '');
}

function row(id: string): HTMLElement {
  return screen.getAllByRole('listitem').find((node) => node.dataset.id === id)!;
}

describe('the label rules', () => {
  it('normalises and refuses as the server does', () => {
    expect(normaliseLabel('  Deep   water ')).toBe('Deep water');
    expect(labelProblem('Physics')).toBeNull();
    expect(labelProblem('x'.repeat(32))).toBeNull();
    expect(labelProblem('   ')).toBe('A label needs some text.');
    expect(labelProblem('x'.repeat(33))).toBe('A label is at most 32 characters.');
    expect(labelProblem('Physics, Biomes')).toMatch(/comma/);
    expect(labelProblem('a\u0007b')).toMatch(/control character/);
  });

  it('cleans a set into the project’s casing, merged and sorted', () => {
    expect(cleanLabels(['physics', ' biomes', 'PHYSICS', 'Sky', ''], VOCABULARY)).toEqual([
      'Biomes',
      'Physics',
      'Sky',
    ]);
    expect(sameLabels(['b', 'A'], ['A', 'b'])).toBe(true);
    expect(sameLabels(['A'], ['a'])).toBe(false);
  });

  it('matches an item’s labels ignoring case, and lists them for a filter', () => {
    const labelled = item('demo-t0001', { labels: ['Physics'] });
    expect(hasLabel(labelled, 'physics')).toBe(true);
    expect(hasLabel(labelled, 'Biomes')).toBe(false);
    expect(hasLabel(item('demo-t0002'), '')).toBe(true);
    // A label in the URL that nothing in view carries is still offered.
    expect(labelsIn([labelled, item('demo-t0002', { labels: ['biomes'] })], 'Ghosts')).toEqual([
      'biomes',
      'Ghosts',
      'Physics',
    ]);
  });

  it('splits typed text on commas and says what is wrong with it', () => {
    expect(addTyped(['Sky'], ['physics, Creatures'], VOCABULARY)).toEqual({
      labels: ['Creatures', 'Physics', 'Sky'],
    });
    expect(addTyped([], ['x'.repeat(40)], VOCABULARY)).toEqual({
      problem: `“${'x'.repeat(40)}”: A label is at most 32 characters.`,
    });
    const ten = Array.from({ length: LABEL_MAX }, (_, n) => `l${n}`);
    expect(addTyped(ten, ['one more'], [])).toEqual({
      problem: 'A ticket carries at most 10 labels.',
    });
    // The most used first, none already chosen.
    expect(offeredLabels(VOCABULARY, ['physics'])).toEqual(['Creatures', 'Biomes']);
  });

  it('refuses a bad label before any request, and reads the vocabulary', async () => {
    const author = trackerAuthor('alice@example.com');
    await expect(
      createItem('demo', { type: 'dev', title: 'x', labels: ['a, b'] }, author),
    ).rejects.toThrow(/comma/);
    const eleven = Array.from({ length: LABEL_MAX + 1 }, (_, n) => `l${n}`);
    await expect(updateItem('demo-t0001', { labels: eleven }, author)).rejects.toThrow(
      'A ticket carries at most 10 labels.',
    );
    expect(server.matching(/\/tracker\/(demo\/items|items\/)/, 'POST')).toHaveLength(0);
    const read = await listLabels('demo');
    expect(read.labels).toEqual(VOCABULARY);
  });

  it('sends the labels in an edit only when the set changed', () => {
    const work = item('demo-t0001', { labels: ['Biomes', 'Physics'] });
    const same = {
      title: work.title,
      body: work.body,
      assignee: '',
      links: [],
      intensity: null,
      release: false,
    };
    expect(editBody(work, { ...same, labels: ['Physics', 'Biomes'] })).toEqual({});
    expect(editBody(work, same)).toEqual({});
    expect(editBody(work, { ...same, labels: [] })).toEqual({ labels: [] });
    const plain = item('demo-t0002');
    expect(editBody(plain, { ...same, title: plain.title, labels: ['Sky'] })).toEqual({
      labels: ['Sky'],
    });
  });
});

describe('labels on the dashboard', () => {
  it('draws a row’s labels at its second line’s right end, each a filter link (rag-t0031)', async () => {
    openDashboard();
    await screen.findByRole('heading', { name: 'demo' });
    const first = row('demo-t0001');
    const labels = within(first).getByLabelText('Labels');
    expect(
      within(labels)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Biomes', 'Physics']);
    expect(within(labels).getByRole('link', { name: 'Physics' })).toHaveAttribute(
      'href',
      '/projects/demo?label=Physics',
    );
    // On the second line, after the assignee, in the right-end slot the link
    // chips held: not beside the assignee, and the row draws no link chip.
    const assignee = within(first).getByTitle('Assignee');
    expect(assignee.parentElement).not.toBe(labels.parentElement);
    expect(assignee.closest('[class*="line2Start"]')).not.toBeNull();
    expect(labels.closest('[class*="line2End"]')).not.toBeNull();
    expect(labels.closest('[class*="cellLine2"]')).toBe(assignee.closest('[class*="cellLine2"]'));
    expect(
      assignee.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(first).queryByRole('link', { name: 'demo-0042' })).toBeNull();
    // A row without labels draws none.
    expect(within(row('demo-t0005')).queryByLabelText('Labels')).toBeNull();
  });

  it('filters by a label from the URL, ignoring case, keeping the gates, with reordering off', async () => {
    openDashboard('/projects/demo?label=physics');
    await screen.findByRole('heading', { name: 'demo' });
    expect(queueIds()).toEqual(['demo-t0001', 'demo-t0003', 'demo-t0004']);
    expect(screen.getByRole('button', { name: 'Drag demo-t0001 to reorder' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Label' })).toHaveValue('Physics');
    // The blocked item carries no label, so Blocked is empty and not drawn.
    expect(screen.queryByRole('region', { name: 'Blocked' })).toBeNull();
  });

  it('sets and clears the filter from its select, in the URL', async () => {
    const user = userEvent.setup();
    openDashboard();
    await screen.findByRole('heading', { name: 'demo' });
    const select = screen.getByRole('combobox', { name: 'Label' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All labels', 'Biomes', 'Creatures', 'Physics']);
    await user.selectOptions(select, 'Creatures');
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo?label=Creatures');
    expect(queueIds()).toEqual(['demo-t0002', 'demo-t0003']);
    await user.selectOptions(select, '');
    expect(screen.getByTestId('address')).toHaveTextContent(/^\/projects\/demo$/);
    expect(queueIds()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Drag demo-t0001 to reorder' })).toBeEnabled();
  });

  it('says so when no queued item carries the label, and offers no filter without labels', async () => {
    openDashboard('/projects/demo?label=Ghosts');
    await screen.findByRole('heading', { name: 'demo' });
    expect(screen.getByText('No ticket labelled Ghosts in the queue')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Queue' })).toBeNull();
  });

  it('draws no label filter when nothing carries a label', async () => {
    view = queueView();
    openDashboard();
    await screen.findByRole('heading', { name: 'demo' });
    expect(screen.queryByRole('combobox', { name: 'Label' })).toBeNull();
  });

  it('adds an item with labels in the project’s casing, from typing and from a suggestion', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    openDashboard();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Gas buoyancy');
    // The most used of the project's labels are one click away.
    await within(dialog).findByRole('button', { name: 'Add label Physics' });
    await user.click(within(dialog).getByRole('button', { name: 'Add label Physics' }));
    expect(within(dialog).queryByRole('button', { name: 'Add label Physics' })).toBeNull();
    // Typed in another casing, it takes the project's; a comma separates two.
    await user.type(within(dialog).getByLabelText('Labels'), 'biomes, Gases{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));

    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toMatchObject({
      title: 'Gas buoyancy',
      labels: ['Biomes', 'Gases', 'Physics'],
    });
    expect(server.matching(LABELS, 'GET').length).toBeGreaterThan(0);
  });

  it('sends a label still in the entry box, and refuses a bad one without writing', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    openDashboard();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Too long');
    await user.type(within(dialog).getByLabelText('Labels'), `${'x'.repeat(33)}{Enter}`);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('at most 32 characters');
    // Typed and not added: leaving the box for the button adds it.
    await user.type(within(dialog).getByLabelText('Labels'), 'Sky');
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));
    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).toMatchObject({ labels: ['Sky'] });
  });

  it('sends no labels for an item added without any', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/items', { body: item('demo-t0011') }, 'POST');
    openDashboard();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Plain');
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));
    await waitFor(() => expect(server.matching('/tracker/demo/items', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/items', 'POST').body).not.toHaveProperty('labels');
  });
});

describe('labels on the item page', () => {
  const ID = 'demo-t0002';
  const PATH = `/tracker/items/${ID}`;
  const RECORD = item(ID, {
    title: 'Next up',
    labels: ['Creatures', 'Physics'],
    events: [
      {
        event_id: 1,
        ts: '2026-01-02T03:04:05Z',
        author_email: 'alice@example.com',
        agent: 'Unknown',
        surface: 'web',
        kind: 'edit',
        body: 'Labels: Creatures, Physics.',
        fields: { labels: ['Creatures', 'Physics'] },
      },
    ],
  });

  beforeEach(() => {
    server.on(PATH, { body: RECORD }, 'GET');
    server.on(PATH, { body: RECORD }, 'POST');
  });

  function openItem() {
    return mountAt('/projects/:project/ticket/:id', <ItemView />, {
      route: `/projects/demo/ticket/${ID}`,
    });
  }

  it('shows the labels and the history’s change', async () => {
    openItem();
    await screen.findByRole('heading', { name: 'Next up' });
    const labels = screen.getAllByLabelText('Labels')[0]!;
    expect(
      within(labels)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Creatures', 'Physics']);
    expect(screen.getByText('Creatures, Physics')).toBeInTheDocument();
  });

  it('edits the labels wholesale from Edit', async () => {
    const user = userEvent.setup();
    openItem();
    await screen.findByRole('heading', { name: 'Next up' });
    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    await user.click(within(dialog).getByRole('button', { name: 'Remove Creatures' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Add label Biomes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({
      labels: ['Biomes', 'Physics'],
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });
});

describe('labels on the History page', () => {
  beforeEach(() => {
    server.on(
      /^\/tracker\/demo\/items(\?.*)?$/,
      (sent) => {
        const status = new URL(sent.path, 'http://x').searchParams.get('status');
        const items =
          status === 'done'
            ? [
                item('demo-t0003', {
                  status: 'done',
                  queued: false,
                  labels: ['Physics'],
                  done_at: '2026-01-05T10:00:00Z',
                }),
                item('demo-t0004', {
                  status: 'done',
                  queued: false,
                  labels: ['Biomes'],
                  done_at: '2026-01-04T10:00:00Z',
                }),
              ]
            : [];
        return { body: { project: 'demo', items } };
      },
      'GET',
    );
  });

  it('narrows to a label from the URL and its select, each row showing its labels', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project/history', <HistoryView />, {
      route: '/projects/demo/history?label=PHYSICS',
    });
    await screen.findByRole('table');
    const ids = () =>
      within(screen.getByRole('table'))
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.querySelector('code')?.textContent ?? '');
    expect(ids()).toEqual(['demo-t0003']);
    const select = screen.getByRole('combobox', { name: 'Label' });
    expect(select).toHaveValue('Physics');
    await user.selectOptions(select, 'Biomes');
    expect(screen.getByTestId('address')).toHaveTextContent('?label=Biomes');
    expect(ids()).toEqual(['demo-t0004']);
    // A chip filters this page, and does not open the item under it.
    await user.selectOptions(select, '');
    await user.click(screen.getByRole('link', { name: 'Physics' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/history?label=Physics');
    expect(ids()).toEqual(['demo-t0003']);
  });
});
