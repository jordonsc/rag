/**
 * The velocity widget (spec:velocity m02, VL-08 and VL-09), on the queue page
 * against a `fetch` double.
 *
 * What it defends: the row reads the concept's example exactly and sits under
 * the header, above the first section; Report opens the report page in the
 * window shown (m03); the pill moves Velocity and ETA and
 * never the counts, and the choice is kept (rubbish kept falls back to 7 d);
 * the rate's and the ETA's wording (fractional days worded from hours up,
 * rag-t0062); each figure a `Stat`, named "Velocity: 8/day" and reading so,
 * its value set apart; the tooltips; a failed refresh keeping the
 * last figures and a failed first read drawing nothing; no row for a project
 * with no counted ticket; and the refresh: every 60 s while visible, paused
 * while hidden, and again when the queue's view changes.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { onTestFinished } from 'vitest';
import { I18nProvider } from '@rag/ui';
import { MemoryRouter, Route, Routes } from 'react-router';

import { IdentityProvider } from '../identity';
import { QueueView } from '../tracker/QueueView';
import type { QueueView as QueueViewRecord, Velocity } from '../tracker/types';
import { formatRate, formatVelocity } from '../tracker/velocity';
import { mountAt } from './harness';
import { TrackerServer, item, queueRoute, queueView } from './trackerFixtures';

const QUEUE = /^\/tracker\/demo$/;
const VELOCITY = '/tracker/demo/velocity';
const WINDOW_KEY = 'rag.tracker.velocityWindow';

/** The concept's example (R1), with a 24-hour window that differs from it. */
function velocity(overrides: Partial<Velocity> = {}): Velocity {
  return {
    project: 'demo',
    now: '2026-11-02T12:00:00Z',
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
        added: 4,
        adj_velocity_per_day: -24,
        adj_eta_days: 'infinite',
      },
      '7d': {
        done: 20,
        active_seconds: 216_000,
        velocity_per_day: 8,
        eta_days: 7,
        added: 5,
        adj_velocity_per_day: 6,
        adj_eta_days: 3.2,
      },
    },
    ...overrides,
  };
}

/** The 7-day window changed, the rest as `velocity()`. */
function week(figures: Partial<Velocity['windows']['7d']>): Velocity {
  const base = velocity();
  return velocity({ windows: { ...base.windows, '7d': { ...base.windows['7d'], ...figures } } });
}

let server: TrackerServer;
let view: QueueViewRecord;
let current: Velocity;

beforeEach(() => {
  view = queueView();
  current = velocity();
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
  server.on(
    QUEUE,
    queueRoute(() => view),
    'GET',
  );
  server.on(VELOCITY, () => ({ body: current }), 'GET');
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The queue page, with a fresh browser storage (the harness clears it). */
function open() {
  return mountAt('/projects/:project', <QueueView />, { route: '/projects/demo' });
}

/** The queue page again, keeping what the browser stored: a reload. */
function reopen() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/projects/demo']}>
        <IdentityProvider>
          <Routes>
            <Route path="/projects/:project" element={<QueueView />} />
          </Routes>
        </IdentityProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function bar(): HTMLElement {
  return screen.getByRole('group', { name: 'Velocity' });
}

async function findBar(): Promise<HTMLElement> {
  return screen.findByRole('group', { name: 'Velocity' });
}

function windowChoice(name: '7 d' | '24 h'): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Velocity window' })).getByRole('radio', {
    name,
  });
}

function velocityReads(): number {
  return server.matching(VELOCITY, 'GET').length;
}

describe('the row', () => {
  it('reads the concept’s example, under the header and above the first section', async () => {
    open();
    const row = await findBar();
    expect(within(row).getByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'In progress: 3' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'Pending: 48' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'ETA: 7 days' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'Adj. Velocity: 6/day' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'Adj. ETA: 3.2 days' })).toBeInTheDocument();
    expect(windowChoice('7 d')).toHaveAttribute('aria-checked', 'true');

    const header = screen.getByRole('heading', { name: 'demo', level: 1 }).closest('header')!;
    expect(header.nextElementSibling).toBe(row);
    const done = screen.getByRole('region', { name: 'Done' });
    expect(row.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the report in the window the row shows (m03)', async () => {
    const user = userEvent.setup();
    const first = open();
    await findBar();
    await user.click(within(bar()).getByRole('button', { name: 'Report' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/report?window=7d');
    first.unmount();

    open();
    await findBar();
    await user.click(windowChoice('24 h'));
    await user.click(within(bar()).getByRole('button', { name: 'Report' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/report?window=24h');
  });

  it('switches Velocity and ETA to 24 h and back, the counts staying put', async () => {
    const user = userEvent.setup();
    open();
    await findBar();

    await user.click(windowChoice('24 h'));
    expect(windowChoice('24 h')).toHaveAttribute('aria-checked', 'true');
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 24/day' })).toBeInTheDocument();
    expect(within(bar()).getByRole('listitem', { name: 'ETA: 3 days' })).toBeInTheDocument();
    // The adjusted figures follow the pill: a growing queue, negative and never done.
    expect(
      within(bar()).getByRole('listitem', { name: 'Adj. Velocity: -24/day' }),
    ).toBeInTheDocument();
    const adjEta = within(bar()).getByRole('listitem', { name: 'Adj. ETA: infinite' });
    expect(within(adjEta).getByText('∞')).toBeInTheDocument();
    expect(within(bar()).getByRole('listitem', { name: 'In progress: 3' })).toBeInTheDocument();
    expect(within(bar()).getByRole('listitem', { name: 'Pending: 48' })).toBeInTheDocument();

    await user.click(windowChoice('7 d'));
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();
    expect(within(bar()).getByRole('listitem', { name: 'ETA: 7 days' })).toBeInTheDocument();
  });

  it('keeps the window chosen across a remount', async () => {
    const user = userEvent.setup();
    const first = open();
    await findBar();
    await user.click(windowChoice('24 h'));
    expect(window.localStorage.getItem(WINDOW_KEY)).toBe('24h');
    first.unmount();

    reopen();
    await findBar();
    expect(windowChoice('24 h')).toHaveAttribute('aria-checked', 'true');
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 24/day' })).toBeInTheDocument();
  });

  it('falls back to 7 d when what is stored is rubbish', async () => {
    window.localStorage.setItem(WINDOW_KEY, 'fortnight');
    reopen();
    await findBar();
    expect(windowChoice('7 d')).toHaveAttribute('aria-checked', 'true');
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();
  });

  it('falls back to 7 d when storage refuses, and still switches', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    reopen();
    await findBar();
    expect(windowChoice('7 d')).toHaveAttribute('aria-checked', 'true');
    await user.click(windowChoice('24 h'));
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 24/day' })).toBeInTheDocument();
  });
});

describe('the wording', () => {
  it('gives one decimal under 10 unless it rounds whole, and a whole number from 10', async () => {
    current = week({ velocity_per_day: 2.4 });
    const first = open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'Velocity: 2.4/day' }),
    ).toBeInTheDocument();
    first.unmount();

    current = week({ velocity_per_day: 12.3 });
    open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'Velocity: 12/day' }),
    ).toBeInTheDocument();
    // Whole from 10, or when one decimal would be a whole number (D12);
    // half away from zero, as the MCP line rounds (D32).
    expect(formatRate(0)).toBe('0');
    expect(formatRate(0.04)).toBe('0');
    expect(formatRate(8)).toBe('8');
    expect(formatRate(8.04)).toBe('8');
    expect(formatRate(2.4)).toBe('2.4');
    expect(formatRate(2.45)).toBe('2.5');
    expect(formatRate(9.94)).toBe('9.9');
    expect(formatRate(9.96)).toBe('10');
    expect(formatRate(10.5)).toBe('11');
    expect(formatRate(42.9)).toBe('43');
    expect(formatRate(118.9)).toBe('119');
    expect(formatVelocity(0)).toBe('0/day');
  });

  it('says “ETA: done” with nothing remaining', async () => {
    current = velocity({
      in_progress: 0,
      in_review: 0,
      pending: 0,
      blocked: 0,
      remaining: 0,
      windows: {
        '24h': {
          done: 2,
          active_seconds: 7_200,
          velocity_per_day: 24,
          eta_days: 0,
          added: 0,
          adj_velocity_per_day: 24,
          adj_eta_days: 0,
        },
        '7d': {
          done: 20,
          active_seconds: 216_000,
          velocity_per_day: 8,
          eta_days: 0,
          added: 0,
          adj_velocity_per_day: 8,
          adj_eta_days: 0,
        },
      },
    });
    open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'ETA: done' }),
    ).toBeInTheDocument();
  });

  it('shows “—” for an unknown ETA, read as “unknown”', async () => {
    current = week({
      done: 0,
      velocity_per_day: 0,
      eta_days: null,
      added: 0,
      adj_velocity_per_day: 0,
      adj_eta_days: null,
    });
    open();
    const eta = within(await findBar()).getByRole('listitem', { name: 'ETA: unknown' });
    expect(within(eta).getByText('—')).toBeInTheDocument();
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 0/day' })).toBeInTheDocument();
  });

  it('words a fractional ETA from hours up (rag-t0062)', async () => {
    current = week({ eta_days: 1.6 });
    const first = open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'ETA: 1.6 days' }),
    ).toBeInTheDocument();
    first.unmount();

    current = week({ eta_days: 32 / 24 });
    const second = open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'ETA: 32 hours' }),
    ).toBeInTheDocument();
    second.unmount();

    current = week({ eta_days: 1 / 24 });
    open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'ETA: 1 hour' }),
    ).toBeInTheDocument();
  });

  it('sets each value apart from its label and unit, the content reading as the name', async () => {
    open();
    const row = await findBar();
    const figures = within(row).getByRole('list', { name: 'Figures' });
    const items = within(figures).getAllByRole('listitem');
    // Names first: what a screen reader that takes the name hears.
    expect(items.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Velocity: 8/day',
      'Adj. Velocity: 6/day',
      'In progress: 3',
      'Pending: 48',
      'ETA: 7 days',
      'Adj. ETA: 3.2 days',
    ]);
    // The content reads the same (a hidden colon), for one that reads it.
    expect(items.map((li) => li.textContent)).toEqual([
      'Velocity: 8/day',
      'Adj. Velocity: 6/day',
      'In progress: 3',
      'Pending: 48',
      'ETA: 7 days',
      'Adj. ETA: 3.2 days',
    ]);
    // The value is its own element, the unit apart inside it.
    const velocity = items[0]!;
    expect(within(velocity).getByText('Velocity')).toBeInTheDocument();
    expect(within(velocity).getByText('/day').parentElement).toHaveTextContent(/^8\/day$/);
  });

  it('explains each figure on hover, naming the in-review, blocked and deferred counts', async () => {
    open();
    const row = await findBar();
    expect(within(row).getByRole('listitem', { name: 'Velocity: 8/day' })).toHaveAttribute(
      'title',
      '20 done in the last 7 days over 60 h of active time (24 h: 2 over 2 h). ' +
        'Active time leaves out gaps of over 2 hours between writes.',
    );
    expect(within(row).getByRole('listitem', { name: 'ETA: 7 days' })).toHaveAttribute(
      'title',
      'Remaining ÷ velocity, in days of active work at this pace. ' +
        'An idle project takes longer in calendar days.',
    );
    expect(within(row).getByRole('listitem', { name: 'Adj. Velocity: 6/day' })).toHaveAttribute(
      'title',
      'Velocity less the tickets added: 20 done and 5 added in the last 7 days ' +
        '(24 h: 2 done and 4 added), over the same active time. Negative while the queue grows.',
    );
    expect(within(row).getByRole('listitem', { name: 'Adj. ETA: 3.2 days' })).toHaveAttribute(
      'title',
      'Remaining ÷ adjusted velocity, in days of active work at this pace. ' +
        'Infinite while tickets are added as fast as they are done, or faster.',
    );
    expect(within(row).getByRole('listitem', { name: 'In progress: 3' })).toHaveAttribute(
      'title',
      'Includes 1 in review.',
    );
    expect(within(row).getByRole('listitem', { name: 'Pending: 48' })).toHaveAttribute(
      'title',
      'Includes 2 blocked. Deferred tickets (4) are left out.',
    );
  });
});

describe('when the read fails, or there is nothing to count', () => {
  it('keeps the last figures when a refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await findBar();
    server.onceOn(VELOCITY, { status: 500, body: { error: 'the store is locked' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(velocityReads()).toBe(2);
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 8/day' })).toBeInTheDocument();
    expect(screen.queryByText(/the store is locked/)).toBeNull();
  });

  it('draws no row and no error when the first read fails', async () => {
    server.onceOn(VELOCITY, { status: 500, body: { error: 'the store is locked' } });
    open();
    await screen.findByRole('region', { name: 'Done' });
    await waitFor(() => expect(velocityReads()).toBe(1));
    expect(screen.queryByRole('group', { name: 'Velocity' })).toBeNull();
    expect(screen.queryByText(/the store is locked/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws no row for a project with no counted ticket', async () => {
    current = velocity({
      in_progress: 0,
      in_review: 0,
      pending: 0,
      blocked: 0,
      deferred: 0,
      remaining: 0,
      windows: {
        '24h': {
          done: 0,
          active_seconds: 0,
          velocity_per_day: 0,
          eta_days: 0,
          added: 0,
          adj_velocity_per_day: 0,
          adj_eta_days: 0,
        },
        '7d': {
          done: 0,
          active_seconds: 0,
          velocity_per_day: 0,
          eta_days: 0,
          added: 0,
          adj_velocity_per_day: 0,
          adj_eta_days: 0,
        },
      },
    });
    open();
    await screen.findByRole('region', { name: 'Done' });
    await waitFor(() => expect(velocityReads()).toBe(1));
    expect(screen.queryByRole('group', { name: 'Velocity' })).toBeNull();
  });

  it('draws the row for a project with only deferred tickets', async () => {
    current = velocity({
      in_progress: 0,
      in_review: 0,
      pending: 0,
      blocked: 0,
      deferred: 1,
      remaining: 0,
      windows: {
        '24h': {
          done: 0,
          active_seconds: 0,
          velocity_per_day: 0,
          eta_days: 0,
          added: 0,
          adj_velocity_per_day: 0,
          adj_eta_days: 0,
        },
        '7d': {
          done: 0,
          active_seconds: 0,
          velocity_per_day: 0,
          eta_days: 0,
          added: 0,
          adj_velocity_per_day: 0,
          adj_eta_days: 0,
        },
      },
    });
    open();
    expect(
      within(await findBar()).getByRole('listitem', { name: 'ETA: done' }),
    ).toBeInTheDocument();
  });
});

describe('the refresh', () => {
  it('reads again every 60 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await findBar();
    expect(velocityReads()).toBe(1);

    current = week({ velocity_per_day: 9 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(velocityReads()).toBe(2);
    expect(within(bar()).getByRole('listitem', { name: 'Velocity: 9/day' })).toBeInTheDocument();
  });

  it('stops while the tab is hidden and reads at once when it is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    onTestFinished(() => {
      delete (document as { visibilityState?: unknown }).visibilityState;
    });
    open();
    await findBar();
    expect(velocityReads()).toBe(1);

    state = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(velocityReads()).toBe(1);

    state = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(velocityReads()).toBe(2));
  });

  it('reads again when the queue’s view changes, and not for a view unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await findBar();
    expect(velocityReads()).toBe(1);

    // An unchanged view (a 304) is no reason to read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(velocityReads()).toBe(1);

    view = { ...view, done: [item('demo-t0077', { status: 'done', queued: false }), ...view.done] };
    current = velocity({ in_progress: 2, remaining: 50 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(velocityReads()).toBe(2));
    await waitFor(() =>
      expect(within(bar()).getByRole('listitem', { name: 'In progress: 2' })).toBeInTheDocument(),
    );
  });
});
