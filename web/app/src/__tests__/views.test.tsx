/**
 * The five views, at the level that would catch a regression: does it render,
 * does it ask the server for the right thing, and does the empty state tell the
 * truth?
 *
 * The last of those is the one worth having. Two of these views are honest
 * about a limitation of the backend — live topics cannot be browsed without a
 * query, archived ones can — and the tempting "improvement" in both directions
 * is a lie: an empty results table for a search that was never run, or a search
 * box over a list that does not need one.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../App';
import { ARCHIVE_PAGE, ArchivedView } from '../views/ArchivedView';
import { NotFoundView } from '../views/NotFoundView';
import { SearchView } from '../views/SearchView';
import { TopicView } from '../views/TopicView';
import { ARCHIVED_HIT, RECORD, Server, archivedSearch, liveSearch } from './fixtures';
import { mount, mountAt } from './harness';

let server: Server;

beforeEach(() => {
  server = new Server();
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Search -----------------------------------------------------------------

describe('SearchView', () => {
  /**
   * **No zero-query browse, and the view must not pretend there is one.**
   * `POST /ledger/search` rejects a blank query for live topics because
   * retrieval is an embedding against a vector index, not a table scan. An
   * empty table or a permanent spinner would read as breakage.
   */
  it('opens on a prompt, asks the server nothing, and names the listing that does work', () => {
    mount(<SearchView />);
    expect(screen.getByText('Search the ledger')).toBeInTheDocument();
    expect(screen.getByText(/there is no browse-everything list/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Archived topics' })).toHaveAttribute(
      'href',
      '/archived',
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('searches on submit rather than on a keystroke', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, liveSearch());
    mount(<SearchView />);

    await user.type(screen.getByLabelText('Search the ledger'), 'same origin');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(server.count(/\/ledger\/search/)).toBe(1));
    expect(server.last().body).toMatchObject({ query: 'same origin' });
    // Live search: no archived flag, which is a different response shape.
    expect(server.last().body).not.toHaveProperty('archived');
  });

  it('puts the query and filters in the address so a result set can be sent to someone', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, liveSearch());
    mount(<SearchView />);

    await user.type(screen.getByLabelText('Search the ledger'), 'same origin');
    await user.selectOptions(screen.getByLabelText('Status'), 'accepted');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent('q=same+origin&status=accepted'),
    );
  });

  it('runs the search the address already carries', async () => {
    server.on(/\/ledger\/search/, liveSearch());
    mount(<SearchView />, { route: '/?q=origin&repo=rag&type=decision' });

    await waitFor(() => expect(server.count(/\/ledger\/search/)).toBe(1));
    expect(server.last().body).toEqual({ query: 'origin', repo: 'rag', type: 'decision' });
  });

  it('renders a hit as a row and opens the topic on a click', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, liveSearch());
    mount(<SearchView />, { route: '/?q=origin' });

    const row = await screen.findByText('Serve the viewer from the same origin');
    const table = within(screen.getByRole('table'));
    expect(table.getByText('rag-0009')).toBeInTheDocument();
    // The status vocabulary also fills the filter control, so this is asserted
    // inside the results table rather than anywhere on the page.
    expect(table.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('1 topic')).toBeInTheDocument();

    await user.click(row);
    expect(screen.getByTestId('address')).toHaveTextContent('/topic/rag-0009');
  });

  it('says nothing matched rather than showing an empty page', async () => {
    server.on(/\/ledger\/search/, liveSearch([]));
    mount(<SearchView />, { route: '/?q=nothing at all' });
    expect(await screen.findByText(/Nothing matched/)).toBeInTheDocument();
  });

  it('reports a failed search and offers to run it again', async () => {
    server.on(/\/ledger\/search/, { error: 'retrieval is not configured' }, 503);
    mount(<SearchView />, { route: '/?q=origin' });

    expect(await screen.findByText('The search did not run.')).toBeInTheDocument();
    expect(screen.getByText('retrieval is not configured')).toBeInTheDocument();
  });

  it('warns that the project filter is exact', () => {
    // A half-remembered project name returns nothing rather than narrowing,
    // which is indistinguishable from "there is nothing there".
    mount(<SearchView />);
    expect(screen.getByText(/Project is matched exactly/)).toBeInTheDocument();
  });
});

// ---- Archive ----------------------------------------------------------------

describe('ArchivedView', () => {
  /** The one listing that works with no query, because it is a SQL scan. */
  it('lists without a query on arrival', async () => {
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<ArchivedView />);

    await waitFor(() => expect(server.count(/\/ledger\/search/)).toBe(1));
    expect(server.last().body).toMatchObject({ archived: true, query: '' });
    expect(await screen.findByText('Whether to add a browse endpoint')).toBeInTheDocument();
    expect(screen.getByText('rag-0002')).toBeInTheDocument();
  });

  it('offers a narrowing box, not a search box', () => {
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<ArchivedView />);
    expect(screen.getByLabelText('Narrow the archive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
    expect(screen.getByText(/plain substring match/)).toBeInTheDocument();
  });

  it('says nothing has been archived when the list is empty', async () => {
    server.on(/\/ledger\/search/, archivedSearch([]));
    mount(<ArchivedView />);
    expect(await screen.findByText('Nothing has been archived.')).toBeInTheDocument();
  });

  it('opens a row without triggering its restore control', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<ArchivedView />);

    await user.click(await screen.findByText('Whether to add a browse endpoint'));
    expect(screen.getByTestId('address')).toHaveTextContent('/topic/rag-0002');
  });

  it('restores from a row and re-reads the list rather than splicing it', async () => {
    const user = userEvent.setup();
    server.onceOn(/\/ledger\/search/, archivedSearch());
    server.on(/\/ledger\/search/, archivedSearch([]));
    server.on(/\/archive$/, { ...ARCHIVED_HIT, archived: false });
    mount(<ArchivedView />);

    await user.click(await screen.findByRole('button', { name: 'Restore…' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(server.count(/\/ledger\/search/)).toBe(2));
    expect(server.last(/\/archive$/).body).toMatchObject({ archived: false });
    expect(await screen.findByText('Nothing has been archived.')).toBeInTheDocument();
  });

  it('prompts for an identity instead of restoring when nobody is named', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<ArchivedView />, { identity: null });

    await user.click(await screen.findByRole('button', { name: 'Restore…' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(server.count(/\/archive$/)).toBe(0);
  });

  /**
   * **The listing must not be silently capped.** With no `top_k` the server
   * applies its own `LIMIT 50` and reports `count` as the length of that page,
   * so a caller that omits it is handed a truncated list that describes itself
   * as complete — in the one view that exists to be a browse-everything
   * affordance.
   */
  it('asks for a stated number of rows rather than taking the server default', async () => {
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<ArchivedView />);

    await waitFor(() => expect(server.count(/\/ledger\/search/)).toBe(1));
    const body = server.last().body!;
    expect(body.top_k).toBeTypeOf('number');
    expect(body.top_k as number).toBeGreaterThan(50);
  });

  /**
   * And when the page comes back full, the reader is told — including that the
   * narrowing box is not limited to what is on screen, because the `LIKE` runs
   * server-side ahead of the `LIMIT`.
   */
  it('says nothing about truncation when the whole archive fits on the page', async () => {
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<ArchivedView />);

    await screen.findByText('Whether to add a browse endpoint');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Archived topics · 1')).toBeInTheDocument();
  });

  it('says so on screen when the list it shows is only a window', async () => {
    const full = Array.from({ length: ARCHIVE_PAGE }, (_, index) => ({
      ...ARCHIVED_HIT,
      topic_id: `rag-${String(index).padStart(4, '0')}`,
    }));
    server.on(/\/ledger\/search/, archivedSearch(full));
    mount(<ArchivedView />);

    await screen.findByText('rag-0000');
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/most recently archived topics/);
    expect(notice).toHaveTextContent(/There are more than that/);
    expect(notice).toHaveTextContent(/Narrowing searches the whole archive/);
    // And the heading says the count is a floor rather than a total.
    expect(screen.getByText(`Archived topics · ${ARCHIVE_PAGE}+`)).toBeInTheDocument();
  });
});

// ---- One topic --------------------------------------------------------------

describe('TopicView', () => {
  const open = (route = '/topic/rag-0009', options = {}) =>
    mountAt('/topic/:id', <TopicView />, { route, ...options });

  it('keeps the framing, the current state and the history visibly apart', async () => {
    server.on(/\/ledger\/rag-0009$/, RECORD);
    const { container } = open();

    expect(await screen.findByRole('heading', { name: RECORD.title })).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText(/never revised/)).toBeInTheDocument();
    expect(screen.getByText('Current state')).toBeInTheDocument();
    expect(screen.getByText('History · 2 entries')).toBeInTheDocument();
    // Oldest first, and never reordered: the point of an append-only log is
    // that it reads as an argument developing, and newest-first would make
    // every correction arrive before the thing it corrects.
    const timeline = container.querySelector('ol')!;
    const entries = within(timeline).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Opened while sizing the work.');
    expect(entries[1]).toHaveTextContent('Agreed after the proxy question was settled.');
  });

  /**
   * Two sibling elements sharing a React key is not a style point: React
   * reconciles siblings by key, so a duplicate lets one of them be dropped or
   * hand its state to the other on a re-render. It shows up only as a console
   * warning, which is exactly why it needs a test.
   */
  it('renders without a duplicate-key warning', async () => {
    const warnings: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    server.on(/\/ledger\/rag-0009$/, RECORD);
    open();
    await screen.findByRole('heading', { name: RECORD.title });
    spy.mockRestore();

    expect(warnings.filter((args) => String(args[0]).includes('same key'))).toEqual([]);
  });

  it('renders event bodies as sanitised markdown, not as raw text', async () => {
    server.on(/\/ledger\/rag-0009$/, {
      ...RECORD,
      current_state: 'Settled. See `web.rs`.\n\n- one\n- two',
    });
    open();
    await screen.findByRole('heading', { name: RECORD.title });
    expect(screen.getByText('web.rs').tagName).toBe('CODE');
  });

  it('distinguishes an agent author from a person', async () => {
    server.on(/\/ledger\/rag-0009$/, RECORD);
    open();
    await screen.findByRole('heading', { name: RECORD.title });
    // A null agent is the most informative value the field has, so it is
    // reported rather than left blank.
    expect(screen.getByText(/Some Model 1/)).toBeInTheDocument();
    expect(screen.getAllByText(/· you/).length).toBeGreaterThan(0);
  });

  it('shows what an event changed beside the prose explaining it', async () => {
    server.on(/\/ledger\/rag-0009$/, RECORD);
    open();
    await screen.findByRole('heading', { name: RECORD.title });
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('State set to')).toBeInTheDocument();
  });

  it('lists typed links to other topics', async () => {
    server.on(/\/ledger\/rag-0009$/, RECORD);
    open();
    expect(await screen.findByRole('link', { name: 'rag-0003' })).toHaveAttribute(
      'href',
      '/topic/rag-0003',
    );
  });

  /**
   * A retired id answers **200** with a pointer, not a 404. Rendering it as a
   * topic would show a blank page for an id that is perfectly good; the view
   * follows it and says what happened.
   */
  it('follows a moved id and explains the redirect at the destination', async () => {
    server.on(/\/ledger\/rag-0009$/, {
      moved: true,
      topic_id: 'rag-0009',
      moved_to: 'example-0004',
      moved_at: '2026-02-01T00:00:00Z',
      detail: 'Moved.',
    });
    server.on(/\/ledger\/example-0004$/, { ...RECORD, topic_id: 'example-0004', repo: 'example' });
    open();

    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent('/topic/example-0004'),
    );
    expect(await screen.findByText(/was moved and retired/)).toHaveTextContent('rag-0009');
  });

  it('says a topic is absent rather than showing an empty one', async () => {
    server.on(/\/ledger\/rag-0009$/, { error: 'no such topic' }, 404);
    open();
    expect(await screen.findByText('There is no topic rag-0009.')).toBeInTheDocument();
  });

  it('marks an archived topic and says what that cost', async () => {
    server.on(/\/ledger\/rag-0009$/, {
      ...RECORD,
      archived: true,
      archived_at: '2026-02-01T00:00:00Z',
    });
    open();
    expect(await screen.findByText(/dropped from the search index/)).toBeInTheDocument();
  });

  it('re-reads by id after an append, never by re-running a search', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/rag-0009$/, RECORD);
    server.on(/\/append$/, {
      event_id: 3,
      ts: '2026-02-01T00:00:00Z',
      author_email: 'alice@example.com',
      author_agent: null,
      kind: 'note',
      body: 'Another note.',
      new_state: null,
      new_status: null,
      new_title: null,
      new_tags: null,
    });
    open();
    await screen.findByRole('heading', { name: RECORD.title });

    await user.type(screen.getByLabelText('Note'), 'Another note.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/ledger\/rag-0009$/)).toBe(2));
    expect(server.count(/\/ledger\/search/)).toBe(0);
  });
});

// ---- Nothing here -----------------------------------------------------------

describe('NotFoundView', () => {
  it('offers the field that fixes the usual cause', async () => {
    const user = userEvent.setup();
    mount(<NotFoundView />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Topic id'), '  rag-0009  ');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/topic/rag-0009');
  });

  it('does nothing with a blank id', async () => {
    const user = userEvent.setup();
    mount(<NotFoundView />, { route: '/nowhere' });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/nowhere');
  });
});

// ---- The shell --------------------------------------------------------------

describe('App', () => {
  it('routes the four addresses and falls through to the rescue page', async () => {
    server.on(/\/ledger\/search/, archivedSearch());
    server.on(/\/ledger\/rag-0009$/, RECORD);

    const { unmount } = mount(<App />);
    expect(screen.getByText('Search the ledger')).toBeInTheDocument();
    unmount();

    mount(<App />, { route: '/archived' });
    expect(await screen.findByText('Archived topics')).toBeInTheDocument();
  });

  it('opens a topic by a pasted address — the point of the whole viewer', async () => {
    server.on(/\/ledger\/rag-0009$/, RECORD);
    mount(<App />, { route: '/topic/rag-0009' });
    expect(await screen.findByRole('heading', { name: RECORD.title })).toBeInTheDocument();
  });

  it('answers an unknown address with the rescue page', () => {
    mount(<App />, { route: '/somewhere-else' });
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows the identity, always, and always editable', async () => {
    const user = userEvent.setup();
    mount(<App />, { identity: null });

    const control = screen.getByRole('button', { name: 'Set your email' });
    await user.click(control);
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
  });

  it('names the signed-in address in the bar', () => {
    mount(<App />, { identity: 'alice@example.com' });
    expect(
      screen.getByRole('button', { name: /Signed as alice@example\.com/ }),
    ).toBeInTheDocument();
  });

  it('navigates between the two listings and to the create form', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, archivedSearch());
    mount(<App />);

    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Archived' }),
    );
    expect(screen.getByTestId('address')).toHaveTextContent('/archived');

    await user.click(screen.getByRole('button', { name: 'New topic' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/new');
    // The panel's own heading, not the nav action that opened it — the action
    // is named by its aria-label rather than by its text.
    expect(screen.getByText('New topic')).toBeInTheDocument();
  });
});
