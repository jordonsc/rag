/**
 * The list pages' scroll memory (rag-t0040): queue → item → back lands where
 * the reader left the queue.
 *
 * jsdom lays nothing out, so the page's scroll is a stub: `window.scrollY` is
 * a variable, `scrollTo` sets it and fires `scroll`, as a browser does. What
 * is defended is the logic and its timing: what counts as a return (a back, a
 * link that says so, a reload) and what is a fresh visit (top, the old
 * position dropped); the restore waiting for the rows, and happening once, so
 * the 10 s refresh never moves the reader; nothing saved while the page is
 * still short; storage that throws; and the links that carry the return.
 */

import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@rag/ui';
import {
  Link,
  MemoryRouter,
  NavigationType,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { onTestFinished } from 'vitest';

import { IdentityProvider } from '../identity';
import { ProjectTabs } from '../tracker/docParts';
import { DocsView } from '../tracker/DocsView';
import { HistoryView } from '../tracker/HistoryView';
import { ItemView } from '../tracker/ItemView';
import { QueueView } from '../tracker/QueueView';
import {
  RETURN_STATE,
  clearScroll,
  isReturnState,
  isReturnVisit,
  readScroll,
  resetHistoryWatch,
  storeScroll,
  useScrollMemory,
} from '../tracker/scrollMemory';
import type { QueueView as QueueViewRecord } from '../tracker/types';
import { TrackerServer, item, queueRoute, queueView } from './trackerFixtures';

const KEY = 'rag.tracker.scroll.queue:demo';

// ---- The page's scroll, stubbed --------------------------------------------

let scrollY = 0;
let scrollTo: ReturnType<typeof vi.fn>;
/** For each `scrollTo`, whether the queue's rows were in the page when it ran. */
let rowsAtScroll: boolean[];
/** For each `scrollTo`, whether a page was still saying it was loading. */
let loadingAtScroll: boolean[];

/** The reader (or the browser) scrolls the page. */
function scrollPage(y: number) {
  act(() => {
    scrollY = y;
    window.dispatchEvent(new Event('scroll'));
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetHistoryWatch();
  scrollY = 0;
  rowsAtScroll = [];
  loadingAtScroll = [];
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  scrollTo = vi.fn((x: number | ScrollToOptions, y?: number) => {
    rowsAtScroll.push(document.querySelector('[aria-label="Queue"] [data-id]') !== null);
    loadingAtScroll.push(document.body.textContent?.includes('Loading') ?? false);
    scrollY = typeof x === 'number' ? (y ?? 0) : (x.top ?? 0);
    window.dispatchEvent(new Event('scroll'));
  });
  vi.stubGlobal('scrollTo', scrollTo);
});

afterEach(() => {
  delete (window as { scrollY?: unknown }).scrollY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A browser back: the `popstate` the browser fires, then the router's move. */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
        void navigate(-1);
      }}
    >
      Browser back
    </button>
  );
}

function Address() {
  const location = useLocation();
  return (
    <p data-testid="address">
      {location.pathname} {isReturnState(location.state) ? 'return' : 'plain'}
    </p>
  );
}

function shell(routes: ReactNode, initial: string | { pathname: string; state: unknown }) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initial]}>
        <IdentityProvider>
          <Address />
          <BackButton />
          {routes}
        </IdentityProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

// ---- The rules --------------------------------------------------------------

describe('what is a return', () => {
  it('is a link that says so, a back or forward, or a reload', () => {
    expect(isReturnVisit(NavigationType.Push, RETURN_STATE, false, 'navigate')).toBe(true);
    expect(isReturnVisit(NavigationType.Pop, null, true, 'navigate')).toBe(true);
    expect(isReturnVisit(NavigationType.Pop, null, false, 'reload')).toBe(true);
    expect(isReturnVisit(NavigationType.Pop, null, false, 'back_forward')).toBe(true);
  });

  it('is not a plain link, a replace, or the first page of a fresh load', () => {
    expect(isReturnVisit(NavigationType.Push, null, true, 'reload')).toBe(false);
    expect(isReturnVisit(NavigationType.Push, { other: true }, true, 'reload')).toBe(false);
    expect(isReturnVisit(NavigationType.Replace, undefined, true, 'reload')).toBe(false);
    expect(isReturnVisit(NavigationType.Pop, null, false, 'navigate')).toBe(false);
    expect(isReturnVisit(NavigationType.Pop, null, false, null)).toBe(false);
    expect(isReturnState({ scrollReturn: 'yes' })).toBe(false);
  });
});

describe('the storage', () => {
  it('keeps one position per key', () => {
    storeScroll('queue:a', 812.6);
    storeScroll('queue:b', 40);
    expect(readScroll('queue:a')).toBe(813);
    expect(readScroll('queue:b')).toBe(40);
    clearScroll('queue:a');
    expect(readScroll('queue:a')).toBeNull();
    expect(readScroll('queue:b')).toBe(40);
  });

  it('ignores a value it did not write', () => {
    window.sessionStorage.setItem('rag.tracker.scroll.queue:a', 'lots');
    expect(readScroll('queue:a')).toBeNull();
    window.sessionStorage.setItem('rag.tracker.scroll.queue:a', '-5');
    expect(readScroll('queue:a')).toBeNull();
  });

  it('survives a browser that refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => storeScroll('queue:a', 10)).not.toThrow();
    expect(() => clearScroll('queue:a')).not.toThrow();
    expect(readScroll('queue:a')).toBeNull();
  });
});

// ---- The hook, on a page whose rows arrive when told -------------------------

/** A list page: rows drawn when **Load** is pressed; **Refresh** re-renders it. */
function ListPage() {
  const [ready, setReady] = useState(false);
  const [, setTick] = useState(0);
  useScrollMemory('queue:demo', ready);
  return (
    <div>
      <button type="button" onClick={() => setReady(true)}>
        Load
      </button>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        Refresh
      </button>
      <Link to="/item">Open item</Link>
    </div>
  );
}

function ItemPage() {
  return (
    <div>
      <Link to="/list" state={RETURN_STATE}>
        Back to the list
      </Link>
      <Link to="/list">Plain link to the list</Link>
    </div>
  );
}

function openList(initial = '/list') {
  return shell(
    <Routes>
      <Route path="/list" element={<ListPage />} />
      <Route path="/item" element={<ItemPage />} />
    </Routes>,
    initial,
  );
}

/** Load the list, scroll it to `y`, open the item; the shorter page clamps. */
async function leaveAt(y: number) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Load' }));
  scrollPage(y);
  expect(readScroll('queue:demo')).toBe(y);
  await user.click(screen.getByRole('link', { name: 'Open item' }));
  // The item page is shorter: the browser clamps, after the list has gone.
  scrollPage(0);
  scrollTo.mockClear();
  return user;
}

describe('useScrollMemory', () => {
  it('restores on the way back by link, after the rows, and only once', async () => {
    openList();
    const user = await leaveAt(1200);
    expect(readScroll('queue:demo')).toBe(1200);

    await user.click(screen.getByRole('link', { name: 'Back to the list' }));
    // Not yet: the page is still too short to scroll.
    expect(scrollTo).not.toHaveBeenCalled();
    // Nor does the short page's scroll overwrite the position it returns to.
    scrollPage(0);
    expect(readScroll('queue:demo')).toBe(1200);

    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 1200);
    expect(scrollY).toBe(1200);

    // The reader moves on; a refresh re-renders and leaves him there.
    scrollPage(900);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollY).toBe(900);
    expect(readScroll('queue:demo')).toBe(900);
  });

  it('restores on the browser’s back', async () => {
    openList('/list');
    const user = await leaveAt(640);
    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/list');
    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(scrollTo).toHaveBeenCalledWith(0, 640);
  });

  it('starts a plain visit at the top and forgets the old position', async () => {
    openList();
    const user = await leaveAt(700);
    scrollPage(300); // the item page, read half-way down
    await user.click(screen.getByRole('link', { name: 'Plain link to the list' }));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(readScroll('queue:demo')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollY).toBe(0);
  });

  it('treats the first page of a fresh load as a fresh visit', async () => {
    storeScroll('queue:demo', 500);
    openList();
    expect(readScroll('queue:demo')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load' }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('restores on the first page of a reload', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' } as unknown as PerformanceEntry,
    ]);
    storeScroll('queue:demo', 500);
    openList();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load' }));
    expect(scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it('works, remembering nothing, when storage is refused', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    openList();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load' }));
    scrollPage(600);
    await user.click(screen.getByRole('link', { name: 'Open item' }));
    scrollPage(0);
    scrollTo.mockClear();
    await user.click(screen.getByRole('link', { name: 'Back to the list' }));
    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// ---- The real pages ----------------------------------------------------------

describe('the dashboard and the item page', () => {
  let server: TrackerServer;
  let view: QueueViewRecord;

  beforeEach(() => {
    view = queueView();
    server = new TrackerServer();
    server.on('/tracker/projects', { body: { projects: [] } });
    server.on(
      /^\/tracker\/demo$/,
      queueRoute(() => view),
      'GET',
    );
    server.on(
      '/tracker/items/demo-t0002',
      { body: item('demo-t0002', { title: 'Next up', events: [] }) },
      'GET',
    );
    server.on('/tracker/demo/labels', { body: { project: 'demo', labels: [] } }, 'GET');
    server.install();
  });

  function openDashboard() {
    return shell(
      <Routes>
        <Route path="/projects/:project" element={<QueueView />} />
        <Route path="/projects/:project/ticket/:id" element={<ItemView />} />
      </Routes>,
      '/projects/demo',
    );
  }

  it('queue → item → the item’s link back restores the queue once its rows are drawn', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    openDashboard();
    await screen.findByRole('link', { name: 'Next up' });
    scrollPage(840);
    expect(window.sessionStorage.getItem(KEY)).toBe('840');

    await user.click(screen.getByRole('link', { name: 'Next up' }));
    await screen.findByRole('heading', { name: 'Next up' });
    scrollPage(0);
    expect(window.sessionStorage.getItem(KEY)).toBe('840');

    // The crumb at the head of the item page.
    await user.click(screen.getAllByRole('link', { name: 'demo' })[0]!);
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo return');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 840));
    expect(rowsAtScroll).toEqual([true]);

    // The 10 s refresh brings a changed queue: the reader stays put.
    scrollPage(800);
    view = queueView({ queue: [...view.queue, item('demo-t0011', { title: 'Newly added' })] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    await screen.findByRole('link', { name: 'Newly added' });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollY).toBe(800);
  });

  it('queue → item → the browser’s back restores it too', async () => {
    const user = userEvent.setup();
    openDashboard();
    await screen.findByRole('link', { name: 'Next up' });
    scrollPage(420);
    await user.click(screen.getByRole('link', { name: 'Next up' }));
    await screen.findByRole('heading', { name: 'Next up' });
    scrollPage(0);
    scrollTo.mockClear();
    rowsAtScroll = [];

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 420));
    expect(rowsAtScroll).toEqual([true]);
  });

  it('opens at the top on a fresh visit', async () => {
    window.sessionStorage.setItem(KEY, '840');
    openDashboard();
    await screen.findByRole('link', { name: 'Next up' });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('the links back', () => {
  it('the Queue, Documents and History tabs each carry the return', async () => {
    const user = userEvent.setup();
    shell(
      <Routes>
        <Route path="*" element={<ProjectTabs project="demo" active="queue" />} />
      </Routes>,
      '/start',
    );
    for (const [name, path] of [
      ['Documents', '/projects/demo/docs'],
      ['History', '/projects/demo/history'],
      ['Queue', '/projects/demo'],
    ] as const) {
      await user.click(screen.getByRole('link', { name }));
      expect(screen.getByTestId('address')).toHaveTextContent(`${path} return`);
    }
  });
});

describe('History and Documents', () => {
  let server: TrackerServer;

  beforeEach(() => {
    server = new TrackerServer();
    server.on('/tracker/projects', { body: { projects: [] } });
    server.on(
      /^\/tracker\/demo\/items\?status=done$/,
      {
        body: {
          project: 'demo',
          items: [
            item('demo-t0009', {
              status: 'done',
              queued: false,
              title: 'Shipped earlier',
              done_at: '2026-01-02T00:00:00Z',
            }),
          ],
        },
      },
      'GET',
    );
    server.on(/^\/tracker\/demo\/items\?status=/, { body: { project: 'demo', items: [] } }, 'GET');
    server.on('/tracker/demo/concepts', { body: { project: 'demo', concepts: [] } }, 'GET');
    server.on('/tracker/demo/specs', { body: { project: 'demo', specs: [] } }, 'GET');
    server.on('/tracker/demo/docs?kind=doc', { body: { project: 'demo', documents: [] } }, 'GET');
    server.install();
  });

  it('History restores on a return, once its list is drawn', async () => {
    storeScroll('history:demo', 360);
    shell(
      <Routes>
        <Route path="/projects/:project/history" element={<HistoryView />} />
      </Routes>,
      { pathname: '/projects/demo/history', state: RETURN_STATE },
    );
    await screen.findByText('Shipped earlier');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 360));
    expect(loadingAtScroll).toEqual([false]);
  });

  it('Documents remembers each tab apart', async () => {
    storeScroll('docs:demo:concepts', 120);
    storeScroll('docs:demo:specs', 980);
    shell(
      <Routes>
        <Route path="/projects/:project/docs" element={<DocsView />} />
      </Routes>,
      { pathname: '/projects/demo/docs', state: RETURN_STATE },
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 120));
    expect(loadingAtScroll).toEqual([false]);
    expect(readScroll('docs:demo:specs')).toBe(980);
  });
});
