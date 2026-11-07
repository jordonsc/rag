/**
 * The velocity report page (spec:velocity m03, VL-13 and VL-14), against a
 * `fetch` double, with the time zone pinned (Melbourne) so local days are
 * the same on every machine.
 *
 * What it defends: the page reads `report?window=7d` by default and `24h`
 * from the parameter, which wins over the window this browser keeps;
 * switching the pill re-reads, updates the URL and keeps the choice; the
 * figures (tiles, rag-t0062: each named "Velocity: 8/day" and reading so),
 * the three blocks and their hidden tables carry the fixture's numbers (the
 * burn-down as local days over the last 7 days, whatever the window); what is
 * still open as chips; MTTC,
 * MTTR and confirmed against sent back as tiles; an empty report says so
 * under its chart; a failed read shows the error with Retry; and the back
 * link returns to the queue.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@rag/ui';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { IdentityProvider } from '../identity';
import { ReportView } from '../tracker/ReportView';
import type { Report, ReportBucket, StateTime, Velocity } from '../tracker/types';
import { TrackerServer } from './trackerFixtures';

const WINDOW_KEY = 'rag.tracker.velocityWindow';
const REPORT = /^\/tracker\/demo\/report\?window=(7d|24h)$/;
const VELOCITY = '/tracker/demo/velocity';

beforeAll(() => {
  vi.stubEnv('TZ', 'Australia/Melbourne');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const H = 3_600;

function state(overrides: Partial<StateTime> = {}): StateTime {
  return {
    count: 0,
    mean_seconds: null,
    median_seconds: null,
    p90_seconds: null,
    open: 0,
    oldest_open_seconds: null,
    ...overrides,
  };
}

/**
 * Hourly buckets from `start`: day `d` (24 hours from the start) has
 * remaining `60 - d` at its end, 2 added in its first hour and 3 done in its
 * thirteenth.
 */
function hours(start: string, n: number): ReportBucket[] {
  const t0 = Date.parse(start);
  return Array.from({ length: n }, (_, k) => ({
    start: new Date(t0 + k * H * 1_000).toISOString().replace('.000Z', 'Z'),
    remaining: 60 - Math.floor(k / 24),
    added: k % 24 === 0 ? 2 : 0,
    done: k % 24 === 12 ? 3 : 0,
  }));
}

/**
 * The week: from Melbourne's midnight on Monday 2 November (13:00 UTC the
 * day before), seven whole local days.
 */
function weekReport(overrides: Partial<Report> = {}): Report {
  return {
    project: 'demo',
    window: '7d',
    start: '2026-11-01T13:00:00Z',
    end: '2026-11-08T13:00:00Z',
    velocity: {
      done: 20,
      active_seconds: 216_000,
      velocity_per_day: 8,
      eta_days: 7,
      added: 0,
      adj_velocity_per_day: 8,
      adj_eta_days: 7,
    },
    buckets: hours('2026-11-01T13:00:00Z', 168),
    states: {
      pending: state({
        count: 4,
        mean_seconds: 3 * H,
        median_seconds: 2.5 * H,
        p90_seconds: 6 * H,
        open: 2,
        oldest_open_seconds: 5.2 * 86_400,
      }),
      in_progress: state({
        count: 12,
        mean_seconds: 2 * H,
        median_seconds: 1.5 * H,
        p90_seconds: 4 * H,
        open: 3,
        oldest_open_seconds: 40 * 60,
      }),
      review: state({ count: 9, mean_seconds: 1_200, median_seconds: 900, p90_seconds: 2_400 }),
      deferred: state(),
      blocked: state({
        count: 1,
        mean_seconds: 5 * H,
        median_seconds: 5 * H,
        p90_seconds: 5 * H,
        open: 1,
        oldest_open_seconds: 3 * 86_400,
      }),
    },
    mttc: { count: 12, mean_seconds: 6 * H, median_seconds: 5 * H, never_in_progress: 2 },
    mttr: { count: 9, mean_seconds: 1_200, median_seconds: 900, confirmed: 7, sent_back: 2 },
    ...overrides,
  };
}

/** The day: its own figures, the same week of buckets (D16). */
function dayReport(): Report {
  return weekReport({
    window: '24h',
    start: '2026-11-07T13:00:00Z',
    velocity: {
      done: 0,
      active_seconds: 7_200,
      velocity_per_day: 0,
      eta_days: null,
      added: 0,
      adj_velocity_per_day: 0,
      adj_eta_days: null,
    },
  });
}

const VELOCITY_NOW: Velocity = {
  project: 'demo',
  now: '2026-11-08T13:00:00Z',
  in_progress: 3,
  in_review: 1,
  pending: 48,
  blocked: 2,
  deferred: 4,
  remaining: 51,
  windows: {
    '24h': {
      done: 2,
      active_seconds: 7_200,
      velocity_per_day: 24,
      eta_days: 3,
      added: 0,
      adj_velocity_per_day: 24,
      adj_eta_days: 3,
    },
    '7d': {
      done: 20,
      active_seconds: 216_000,
      velocity_per_day: 8,
      eta_days: 7,
      added: 0,
      adj_velocity_per_day: 8,
      adj_eta_days: 7,
    },
  },
};

let server: TrackerServer;
let week: Report;

beforeEach(() => {
  week = weekReport();
  server = new TrackerServer();
  server.on(REPORT, (sent) => ({ body: sent.path.endsWith('24h') ? dayReport() : week }), 'GET');
  server.on(VELOCITY, { body: VELOCITY_NOW }, 'GET');
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reports the current URL into the DOM, so a navigation can be asserted. */
function Address() {
  const location = useLocation();
  return <p data-testid="address">{`${location.pathname}${location.search}`}</p>;
}

/** The report page at `route`, with `stored` as the window this browser keeps. */
function open(route = '/projects/demo/report', stored?: string) {
  window.localStorage.clear();
  if (stored !== undefined) {
    window.localStorage.setItem(WINDOW_KEY, stored);
  }
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[route]}>
        <IdentityProvider>
          <Address />
          <Routes>
            <Route path="/projects/:project/report" element={<ReportView />} />
            <Route path="/projects/:project" element={<p>the queue</p>} />
          </Routes>
        </IdentityProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function reads(choice: '7d' | '24h'): number {
  return server.matching(`/tracker/demo/report?window=${choice}`, 'GET').length;
}

function windowChoice(name: '7 d' | '24 h'): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Report window' })).getByRole('radio', {
    name,
  });
}

async function figures(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: 'Figures' });
}

/** The cells of a hidden table's row for `name`. */
function row(table: HTMLElement, name: string): string[] {
  const header = within(table).getByRole('rowheader', { name });
  return [...header.closest('tr')!.querySelectorAll('td')].map((td) => td.textContent ?? '');
}

function address(): string {
  return screen.getByTestId('address').textContent ?? '';
}

describe('the window', () => {
  it('reads the 7-day report by default', async () => {
    open();
    await figures();
    expect(screen.getByRole('heading', { level: 1, name: 'demo report' })).toBeInTheDocument();
    expect(reads('7d')).toBe(1);
    expect(reads('24h')).toBe(0);
    expect(server.matching(VELOCITY, 'GET')).toHaveLength(1);
    expect(windowChoice('7 d')).toHaveAttribute('aria-checked', 'true');
  });

  it('reads the 24-hour report from the parameter, which wins over the kept choice', async () => {
    open('/projects/demo/report?window=24h', '7d');
    await figures();
    expect(reads('24h')).toBe(1);
    expect(reads('7d')).toBe(0);
    expect(windowChoice('24 h')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('listitem', { name: 'Velocity: 0/day' })).toBeInTheDocument();
  });

  it('reads the kept choice without a parameter, and 7 days for rubbish', async () => {
    const first = open('/projects/demo/report', '24h');
    await figures();
    expect(reads('24h')).toBe(1);
    first.unmount();

    open('/projects/demo/report?window=fortnight', 'fortnight');
    await figures();
    expect(reads('7d')).toBe(1);
  });

  it('re-reads on switching the pill, updates the URL and keeps the choice', async () => {
    const user = userEvent.setup();
    open();
    await figures();
    expect(screen.getByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();

    await user.click(windowChoice('24 h'));
    await waitFor(() => expect(reads('24h')).toBe(1));
    expect(address()).toBe('/projects/demo/report?window=24h');
    expect(window.localStorage.getItem(WINDOW_KEY)).toBe('24h');
    expect(await screen.findByRole('listitem', { name: 'Velocity: 0/day' })).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Burn-down over the last 7 days' }),
    ).toBeInTheDocument();

    await user.click(windowChoice('7 d'));
    await waitFor(() => expect(reads('7d')).toBe(2));
    expect(address()).toBe('/projects/demo/report?window=7d');
    expect(await screen.findByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();
  });
});

describe('the blocks', () => {
  it('shows the widget’s figures across the top as tiles, each read as label and value', async () => {
    open();
    const list = await figures();
    const tiles = within(list).getAllByRole('listitem');
    expect(tiles.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Velocity: 8/day',
      'Adj. Velocity: 8/day',
      'In progress: 3',
      'Pending: 48',
      'ETA: 7 days',
      'Adj. ETA: 7 days',
      'Done: 20 tickets',
    ]);
    expect(tiles.map((li) => li.textContent)).toEqual([
      'Velocity: 8/day',
      'Adj. Velocity: 8/day',
      'In progress: 3',
      'Pending: 48',
      'ETA: 7 days',
      'Adj. ETA: 7 days',
      'Done: 20 tickets',
    ]);
    // The unit is set apart from the value it follows.
    expect(within(tiles[6]!).getByText('tickets').parentElement).toHaveTextContent('20 tickets');
  });

  it('words a fractional ETA tile from hours up (rag-t0062)', async () => {
    week = weekReport({
      velocity: {
        done: 20,
        active_seconds: 216_000,
        velocity_per_day: 8,
        eta_days: 140,
        added: 0,
        adj_velocity_per_day: 8,
        adj_eta_days: 140,
      },
    });
    open();
    const list = await figures();
    expect(within(list).getByRole('listitem', { name: 'ETA: 4.6 months' })).toBeInTheDocument();
  });

  it('shows the adjusted tiles negative and infinite while the queue grows (rag-t0071)', async () => {
    week = weekReport({
      velocity: {
        done: 2,
        active_seconds: 216_000,
        velocity_per_day: 0.8,
        eta_days: 63.75,
        added: 7,
        adj_velocity_per_day: -2,
        adj_eta_days: 'infinite',
      },
    });
    open();
    const list = await figures();
    expect(
      within(list).getByRole('listitem', { name: 'Adj. Velocity: -2/day' }),
    ).toBeInTheDocument();
    const eta = within(list).getByRole('listitem', { name: 'Adj. ETA: infinite' });
    expect(within(eta).getByText('∞')).toBeInTheDocument();
  });

  it('gives each figure its tooltip', async () => {
    open();
    const list = await figures();
    expect(within(list).getByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'In progress: 3' })).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'Pending: 48' })).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'ETA: 7 days' })).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'Done: 20 tickets' })).toHaveAttribute(
      'title',
      'Over 2.5 days of active time in the last 7 days.',
    );
    expect(within(list).getByRole('listitem', { name: 'Pending: 48' })).toHaveAttribute(
      'title',
      'Includes 2 blocked. Deferred tickets (4) are left out.',
    );
  });

  it('draws the week’s burn-down in local days, its numbers in a hidden table', async () => {
    open();
    await figures();
    expect(screen.getByRole('heading', { level: 2, name: 'Burn-down' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Burn-down over the last 7 days' });
    // Seven Melbourne days, Monday 2 to Sunday 8 November.
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Mon 2 Nov',
      'Tue 3 Nov',
      'Wed 4 Nov',
      'Thu 5 Nov',
      'Fri 6 Nov',
      'Sat 7 Nov',
      'Sun 8 Nov',
    ]);
    expect(row(table, 'Mon 2 Nov')).toEqual(['60', '2', '3']);
    expect(row(table, 'Sun 8 Nov')).toEqual(['54', '2', '3']);
    expect(screen.queryByText('No tickets were done in the last 7 days.')).toBeNull();
  });

  it('keeps the burn-down in the last 7 days on the 24-hour window', async () => {
    open('/projects/demo/report?window=24h');
    await figures();
    const table = screen.getByRole('table', { name: 'Burn-down over the last 7 days' });
    expect(within(table).getAllByRole('rowheader')).toHaveLength(7);
    expect(row(table, 'Mon 2 Nov')).toEqual(['60', '2', '3']);
    // The window's own done is nothing; the week's bars are what the note reads.
    expect(screen.getByRole('listitem', { name: 'Done: 0 tickets' })).toBeInTheDocument();
    expect(screen.queryByText('No tickets were done in the last 7 days.')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Burn-down over the last 24 hours' })).toBeNull();
    // The rest follows the window.
    expect(
      screen.getByRole('table', { name: 'Time in each state over the last 24 hours' }),
    ).toBeInTheDocument();
  });

  it('shows time in each state, with what is still open under it', async () => {
    open();
    await figures();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Time in each state' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Time in each state over the last 7 days' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Pending', 'In progress', 'Review', 'Deferred', 'Blocked']);
    expect(row(table, 'Pending')).toEqual(['4', '3 hours', '2.5 hours', '6 hours']);
    expect(row(table, 'Review')).toEqual(['9', '20 minutes', '15 minutes', '40 minutes']);
    expect(row(table, 'Deferred')).toEqual(['0', '—', '—', '—']);
    // A chip a state, each named in full; 5.2 days reads whole from 5 (rag-t0062).
    const chips = within(screen.getByRole('list', { name: 'Still open' })).getAllByRole('listitem');
    expect(chips.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Pending: 2 still open, the oldest 5 days',
      'In progress: 3 still open, the oldest 40 minutes',
      'Review: none still open',
      'Deferred: none still open',
      'Blocked: 1 still open, the oldest 3 days',
    ]);
    expect(chips[0]).toHaveTextContent('Pending2oldest 5 days');
    expect(chips[2]).toHaveTextContent('Reviewnone');
  });

  it('gives completion and resolution as tiles, each read as one sentence', async () => {
    open();
    await figures();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Completion and resolution' }),
    ).toBeInTheDocument();
    const tiles = within(screen.getByRole('list', { name: 'Completion and resolution' }))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('aria-label'));
    expect(tiles).toEqual([
      'Mean time to completion: 6 hours, median 5 hours, over 12 tickets',
      'Done without being in progress: 2 tickets, left out of the mean',
      'Mean time to resolution: 20 minutes, median 15 minutes, over 9 reviews',
      'Reviews ended: 7 confirmed, 2 sent back',
    ]);
    const mttc = screen.getByRole('listitem', { name: /^Mean time to completion/ });
    // The content reads as the name does: the hidden colon and comma.
    expect(mttc.textContent).toBe(
      'Mean time to completion: 6 hours, median 5 hours, over 12 tickets',
    );
    expect(mttc).toHaveAttribute(
      'title',
      'Time in progress, since each was last reopened, of the tickets done in the last 7 days.',
    );
    const split = screen.getByRole('listitem', { name: /^Reviews ended/ });
    expect(split.textContent).toBe('Reviews ended: 7 confirmed, 2 sent back');
  });

  it('says so under its chart when nothing was done in the window', async () => {
    week = weekReport({
      velocity: {
        done: 0,
        active_seconds: 0,
        velocity_per_day: 0,
        eta_days: null,
        added: 0,
        adj_velocity_per_day: 0,
        adj_eta_days: null,
      },
      buckets: hours('2026-11-01T13:00:00Z', 168).map((b) => ({ ...b, added: 0, done: 0 })),
      mttc: { count: 0, mean_seconds: null, median_seconds: null, never_in_progress: 0 },
      mttr: { count: 0, mean_seconds: null, median_seconds: null, confirmed: 0, sent_back: 0 },
    });
    open();
    const list = await figures();
    expect(within(list).getByRole('listitem', { name: 'Velocity: 0/day' })).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'ETA: unknown' })).toBeInTheDocument();
    const empty = screen.getByText('No tickets were done in the last 7 days.');
    const chart = screen.getByRole('table', { name: 'Burn-down over the last 7 days' });
    expect(chart.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByRole('listitem', {
        name: 'Mean time to completion: none, no ticket done in this window was in progress',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('listitem', {
        name: 'Mean time to resolution: none, no review ended in this window',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('listitem', { name: 'Reviews ended: 0 confirmed, 0 sent back' }),
    ).toBeInTheDocument();
  });
});

describe('a failed read, and the way back', () => {
  it('shows the error with Retry, and reads again on it', async () => {
    const user = userEvent.setup();
    server.onceOn(REPORT, { status: 500, body: { error: 'the store is locked' } });
    open();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load demo’s report.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Figures' })).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await figures()).toBeInTheDocument();
    expect(reads('7d')).toBe(2);
  });

  it('returns to the queue by its back link', async () => {
    const user = userEvent.setup();
    open();
    await figures();
    await user.click(screen.getByRole('link', { name: 'Back to the queue' }));
    expect(await screen.findByText('the queue')).toBeInTheDocument();
    expect(address()).toBe('/projects/demo');
  });
});
