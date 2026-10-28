/**
 * The History page (rag-t0008), against a `fetch` double.
 *
 * What it defends: the three status reads (done, cancelled, failed, never the
 * rest); newest first by `done_at` for done and `updated_at` for the others,
 * which say they are a last change; acknowledged and unacknowledged done both
 * listed; the status, type and text filters, kept in the URL; a row and its
 * link opening the item page; a failed read with its retry; a refused project
 * name never becoming a request; and the History tab beside Queue and
 * Documents.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../App';
import { byFinishedDesc, finishedAt, HistoryView, matchesText } from '../tracker/HistoryView';
import type { Item } from '../tracker/types';
import { mount, mountAt } from './harness';
import { TrackerServer, item, queueRoute, queueView } from './trackerFixtures';

const ITEMS = /^\/tracker\/demo\/items(\?.*)?$/;

/** Done, acknowledged; done last of all, not yet acknowledged; older done. */
const DONE: Item[] = [
  item('demo-t0003', {
    status: 'done',
    queued: false,
    title: 'Shipped the parser',
    done_at: '2026-01-05T10:00:00Z',
    updated_at: '2026-01-06T09:00:00Z',
    acknowledged_at: '2026-01-06T09:00:00Z',
  }),
  item('demo-t0007', {
    status: 'done',
    queued: false,
    type: 'design',
    title: 'Drew the icons',
    done_at: '2026-01-09T10:00:00Z',
    updated_at: '2026-01-09T10:00:00Z',
  }),
  item('demo-t0001', {
    status: 'done',
    queued: false,
    title: 'First of all',
    done_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
    acknowledged_at: '2026-01-02T10:00:00Z',
  }),
];

const CANCELLED: Item[] = [
  item('demo-t0005', {
    status: 'cancelled',
    queued: false,
    type: 'recon',
    title: 'Survey the old store',
    body: 'Superseded by the **migration** plan.',
    updated_at: '2026-01-07T10:00:00Z',
  }),
];

const FAILED: Item[] = [
  item('demo-t0006', {
    status: 'failed',
    title: 'Port the importer',
    updated_at: '2026-01-03T10:00:00Z',
  }),
];

let server: TrackerServer;

beforeEach(() => {
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
  server.on(
    ITEMS,
    (sent) => {
      const status = new URL(sent.path, 'http://x').searchParams.get('status');
      const items =
        status === 'done'
          ? DONE
          : status === 'cancelled'
            ? CANCELLED
            : status === 'failed'
              ? FAILED
              : [item('demo-t0009', { title: 'Still pending' })];
      return { body: { project: 'demo', items } };
    },
    'GET',
  );
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(route = '/projects/demo/history') {
  return mountAt('/projects/:project/history', <HistoryView />, { route });
}

/** The item ids in the order the table draws them. */
function rowIds(): string[] {
  return within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('code')?.textContent ?? '');
}

async function loaded() {
  await screen.findByRole('table');
}

describe('the history page', () => {
  it('reads done, cancelled and failed, and nothing else', async () => {
    open();
    await loaded();
    const statuses = server
      .matching(ITEMS, 'GET')
      .map((sent) => new URL(sent.path, 'http://x').searchParams.get('status'))
      .sort();
    expect(statuses).toEqual(['cancelled', 'done', 'failed']);
    expect(screen.queryByText('Still pending')).toBeNull();
  });

  it('lists every finished item newest first, acknowledged or not', async () => {
    open();
    await loaded();
    // t0007 done 01-09, t0005 cancelled (last change 01-07), t0003 done 01-05
    // (its acknowledgement on 01-06 does not move it), t0006 failed 01-03,
    // t0001 done 01-01.
    expect(rowIds()).toEqual([
      'demo-t0007',
      'demo-t0005',
      'demo-t0003',
      'demo-t0006',
      'demo-t0001',
    ]);
    expect(screen.getByText('Finished tickets · 5')).toBeInTheDocument();

    const unacked = screen.getByRole('link', { name: 'Drew the icons' }).closest('tr')!;
    expect(within(unacked).getByText('Not yet')).toBeInTheDocument();
    expect(within(unacked).getByText('Done')).toBeInTheDocument();
  });

  it('marks a cancel or fail time as a last change, and a done time as its own', async () => {
    open();
    await loaded();
    const cancelled = screen.getByRole('link', { name: 'Survey the old store' }).closest('tr')!;
    expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument();
    expect(within(cancelled).getByText(/\(last change\)/)).toBeInTheDocument();
    expect(cancelled.querySelector('[data-field]')).toHaveAttribute('data-field', 'updated_at');

    const done = screen.getByRole('link', { name: 'Shipped the parser' }).closest('tr')!;
    expect(within(done).queryByText(/\(last change\)/)).toBeNull();
    expect(done.querySelector('[data-field]')).toHaveAttribute('data-field', 'done_at');
  });

  it('filters by status, with counts, and keeps the filter in the URL', async () => {
    const user = userEvent.setup();
    open();
    await loaded();
    const group = screen.getByRole('radiogroup', { name: 'Status' });
    expect(within(group).getByRole('radio', { name: 'Done · 3' })).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: 'Cancelled · 1' }));
    expect(rowIds()).toEqual(['demo-t0005']);
    expect(screen.getByTestId('address')).toHaveTextContent(
      '/projects/demo/history?status=cancelled',
    );

    await user.click(within(group).getByRole('radio', { name: 'All · 5' }));
    expect(rowIds()).toHaveLength(5);
    expect(screen.getByTestId('address')).toHaveTextContent(/\/history$/);
  });

  it('filters by type', async () => {
    const user = userEvent.setup();
    open();
    await loaded();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'design');
    expect(rowIds()).toEqual(['demo-t0007']);
    expect(screen.getByTestId('address')).toHaveTextContent('?type=design');
    // The status counts follow the type filter.
    expect(screen.getByRole('radio', { name: 'Cancelled · 0' })).toBeInTheDocument();
  });

  it('narrows by text over the id, title and body, ignoring case', async () => {
    const user = userEvent.setup();
    open();
    await loaded();
    const box = screen.getByLabelText('Narrow the history');

    await user.type(box, 'MIGRATION');
    expect(rowIds()).toEqual(['demo-t0005']);
    expect(screen.getByTestId('address')).toHaveTextContent('?q=MIGRATION');

    await user.clear(box);
    await user.type(box, 't0006');
    expect(rowIds()).toEqual(['demo-t0006']);

    await user.clear(box);
    await user.type(box, 'nothing like this');
    expect(screen.getByText('No finished ticket matches these filters.')).toBeInTheDocument();
  });

  it('starts from the filters in the URL', async () => {
    open('/projects/demo/history?status=done&type=dev&q=parser');
    await loaded();
    expect(rowIds()).toEqual(['demo-t0003']);
    expect(screen.getByLabelText('Narrow the history')).toHaveValue('parser');
    expect(screen.getByRole('radio', { name: 'Done · 1' })).toHaveAttribute('aria-checked', 'true');
  });

  it('ignores a status or type in the URL that it does not list', async () => {
    open('/projects/demo/history?status=pending&type=nonsense');
    await loaded();
    expect(rowIds()).toHaveLength(5);
  });

  it('opens the item page from a row and from its link', async () => {
    const user = userEvent.setup();
    open();
    await loaded();
    const link = screen.getByRole('link', { name: 'Survey the old store' });
    expect(link).toHaveAttribute('href', '/projects/demo/ticket/demo-t0005');

    await user.click(screen.getByText('Port the importer').closest('tr')!.querySelector('code')!);
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/ticket/demo-t0006');
  });

  it('says so when nothing has finished', async () => {
    server.onceOn(/status=done/, { body: { project: 'demo', items: [] } }, 'GET');
    server.onceOn(/status=cancelled/, { body: { project: 'demo', items: [] } }, 'GET');
    server.onceOn(/status=failed/, { body: { project: 'demo', items: [] } }, 'GET');
    open();
    expect(
      await screen.findByText('Nothing has been done, cancelled or failed yet.'),
    ).toBeInTheDocument();
  });

  it('shows a failed read and retries it', async () => {
    const user = userEvent.setup();
    server.onceOn(/status=cancelled/, { status: 500, body: { error: 'store unavailable' } }, 'GET');
    open();
    expect(await screen.findByText('Could not load demo’s history.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    await loaded();
    expect(rowIds()).toHaveLength(5);
  });

  it('refuses a project name the server would refuse, without asking it', async () => {
    open('/projects/items/history');
    expect(await screen.findByText('“items” is not a project name.')).toBeInTheDocument();
    expect(server.matching(/\/items/)).toHaveLength(0);
  });
});

describe('the History tab', () => {
  beforeEach(() => {
    server.on(
      /^\/tracker\/demo$/,
      queueRoute(() => queueView()),
      'GET',
    );
  });

  it('sits beside Queue and Documents and opens the history', async () => {
    const user = userEvent.setup();
    mount(<App />, { route: '/projects/demo' });
    await screen.findByRole('heading', { name: 'demo' });
    const tabs = screen.getByRole('navigation', { name: 'demo pages' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Queue', 'Documents', 'History']);

    await user.click(within(tabs).getByRole('link', { name: 'History' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/history');
    expect(await screen.findByRole('heading', { name: 'demo history' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'demo pages' })).getByRole('link', {
          name: 'History',
        }),
      ).toHaveAttribute('aria-current', 'page'),
    );
  });
});

describe('the history order', () => {
  it('places a done item by done_at and any other by updated_at', () => {
    const done = item('a', { status: 'done', done_at: '2026-01-02T00:00:00Z' });
    expect(finishedAt(done)).toEqual({ at: '2026-01-02T00:00:00Z', field: 'done_at' });
    const cancelled = item('b', { status: 'cancelled', updated_at: '2026-01-03T00:00:00Z' });
    expect(finishedAt(cancelled)).toEqual({ at: '2026-01-03T00:00:00Z', field: 'updated_at' });
  });

  it('breaks a tie by the later id first', () => {
    const at = { status: 'cancelled' as const, updated_at: '2026-01-03T00:00:00Z' };
    const sorted = [item('demo-t0002', at), item('demo-t0010', at)].sort(byFinishedDesc);
    expect(sorted.map((i) => i.id)).toEqual(['demo-t0010', 'demo-t0002']);
  });

  it('matches text in the assignee too, and everything on a blank filter', () => {
    const one = item('demo-t0001', { assignee: 'dev-3' });
    expect(matchesText(one, 'DEV-3')).toBe(true);
    expect(matchesText(one, '   ')).toBe(true);
    expect(matchesText(one, 'absent')).toBe(false);
  });
});
