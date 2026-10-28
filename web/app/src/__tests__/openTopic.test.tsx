/**
 * Opening a quoted id — the journey the viewer exists for.
 *
 * An agent writes `demo-0001` in a commit message or a chat log and somebody
 * wants to read it. Everything else here — search, the archive listing — is a
 * way of finding an id you were *not* given, so this path is the one that has
 * to be reachable without hunting and honest about all three of its answers:
 * the topic, a moved pointer followed to where the content went, and a
 * not-found that names the id.
 *
 * Two of these tests are about what must **not** happen. A malformed id must
 * not cost a round trip that could only have 404'd, and an id typed into the
 * *search* box must not take Enter away from the search — "what mentions
 * demo-0001" is a real question, and answering a different one is worse than
 * offering no shortcut at all.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../App';
import { NotFoundView } from '../views/NotFoundView';
import { RECORD, Server, archivedSearch, liveSearch } from './fixtures';
import { mount } from './harness';

/** The fixture record, under an id this file owns. */
const TOPIC = { ...RECORD, topic_id: 'demo-0001', repo: 'demo' };

let server: Server;

beforeEach(() => {
  server = new Server();
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The box in the top bar, which is on screen whatever the route. */
const bar = () => screen.getByLabelText('Open a topic by id');

describe('the id box in the shell', () => {
  /**
   * **The point of moving it here.** The only in-app way to open an id used to
   * be a box on the 404 page — an affordance you find by first getting lost.
   */
  it.each([
    ['the search page', '/'],
    ['the archive', '/archived'],
    ['a topic', '/topic/demo-0001'],
    ['an address that does not exist', '/nowhere'],
  ])('is on screen from %s', async (_where, route) => {
    server.on(/\/ledger\/search/, archivedSearch());
    server.on(/\/ledger\/demo-0001$/, TOPIC);
    mount(<App />, { route });
    expect(bar()).toBeInTheDocument();
  });

  it('opens a topic on Enter, with no mouse anywhere', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/demo-0001$/, TOPIC);
    mount(<App />);

    await user.type(bar(), 'demo-0001{Enter}');

    expect(screen.getByTestId('address')).toHaveTextContent('/topic/demo-0001');
    expect(await screen.findByRole('heading', { name: TOPIC.title })).toBeInTheDocument();
  });

  /**
   * Both id forms open (rag-t0051): the `l`-marked one minted now, in a
   * project whose name has a hyphen of its own, and the legacy one above.
   */
  it('opens an l-marked id, in a hyphenated project, on Enter', async () => {
    const user = userEvent.setup();
    const marked = { ...RECORD, topic_id: 'shq-suite-l0012', repo: 'shq-suite' };
    server.on(/\/ledger\/shq-suite-l0012$/, marked);
    mount(<App />);

    await user.type(bar(), 'shq-suite-l0012{Enter}');

    expect(screen.getByTestId('address')).toHaveTextContent('/topic/shq-suite-l0012');
    expect(await screen.findByRole('heading', { name: marked.title })).toBeInTheDocument();
  });

  it('refuses a tracker ticket id, which is not a topic', async () => {
    const user = userEvent.setup();
    mount(<App />);

    await user.type(bar(), 'ubu-t0042{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent(/not a topic id/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('trims what was pasted, since a copied id usually brings whitespace', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/demo-0001$/, TOPIC);
    mount(<App />);

    await user.type(bar(), '  demo-0001  {Enter}');
    expect(screen.getByTestId('address')).toHaveTextContent('/topic/demo-0001');
  });

  /**
   * A round trip that could only have returned a 404 tells the reader nothing
   * they can act on. The shape of an id does, so it is said here.
   */
  it('refuses a malformed id without asking the server', async () => {
    const user = userEvent.setup();
    mount(<App />);

    await user.type(bar(), 'demo-1{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent(/not a topic id/i);
    expect(screen.getByRole('alert')).toHaveTextContent('demo-0001');
    expect(screen.getByTestId('address')).toHaveTextContent('/');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('drops the complaint as soon as the reader starts fixing it', async () => {
    const user = userEvent.setup();
    mount(<App />);

    await user.type(bar(), 'nonsense{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.type(bar(), '-0001');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /** Nobody who has typed nothing has made a mistake. */
  it('says nothing at all about a blank box', async () => {
    const user = userEvent.setup();
    mount(<App />, { route: '/nowhere' });

    await user.click(screen.getByRole('button', { name: 'Open topic' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent('/nowhere');
  });

  /**
   * A well-formed id that does not exist is an *answer*, not a dead end: it
   * names the id, and the box is still in the bar to try the next one.
   */
  it('answers a well-formed id that does not exist by name', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/demo-0404$/, { error: 'no such topic' }, 404);
    mount(<App />);

    await user.type(bar(), 'demo-0404{Enter}');

    expect(await screen.findByText('There is no topic demo-0404.')).toBeInTheDocument();
    expect(bar()).toBeInTheDocument();
  });

  /**
   * A retired id answers **200** with a pointer rather than a 404, and
   * `TopicView` follows it. Arriving from the bar must be no different from
   * arriving from a pasted address — the logic is not duplicated here.
   */
  it('follows a moved id to where the content now lives', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/demo-0001$/, {
      moved: true,
      topic_id: 'demo-0001',
      moved_to: 'example-0042',
      moved_at: '2026-02-01T00:00:00Z',
      detail: 'Moved.',
    });
    server.on(/\/ledger\/example-0042$/, {
      ...RECORD,
      topic_id: 'example-0042',
      repo: 'example',
    });
    mount(<App />);

    await user.type(bar(), 'demo-0001{Enter}');

    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent('/topic/example-0042'),
    );
    expect(await screen.findByText(/was moved and retired/)).toHaveTextContent('demo-0001');
  });

  /**
   * Two of these boxes are on screen at once on the 404 page, and two controls
   * sharing an accessible name is a real defect for anyone navigating by name
   * rather than by eye.
   */
  it('does not collide with the rescue box on the 404 page', () => {
    mount(<App />, { route: '/nowhere' });
    expect(bar()).toBeInTheDocument();
    expect(screen.getByLabelText('Topic id')).toBeInTheDocument();
  });
});

describe('the search box recognises a pasted id', () => {
  const paste = async (user: ReturnType<typeof userEvent.setup>, text: string) =>
    user.type(screen.getByLabelText('Search the ledger'), text);

  it('offers a direct route, and does not take Enter to get there', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/search/, liveSearch());
    mount(<App />);

    await paste(user, 'demo-0001');
    // Offered on sight, before anything is submitted — a semantic search over
    // an id costs a second and matches on whatever quotes it.
    expect(screen.getByRole('button', { name: 'Open demo-0001' })).toBeInTheDocument();

    await paste(user, '{Enter}');
    // Enter still means search: "what mentions demo-0001" is a real question,
    // and navigating away from it would answer a different one.
    await waitFor(() => expect(server.count(/\/ledger\/search/)).toBe(1));
    expect(server.last().body).toMatchObject({ query: 'demo-0001' });
    expect(screen.getByTestId('address')).toHaveTextContent('q=demo-0001');
    expect(screen.getByTestId('address')).not.toHaveTextContent('/topic/');
    // And the direct route is still there, above the results it did not replace.
    expect(screen.getByRole('button', { name: 'Open demo-0001' })).toBeInTheDocument();
  });

  it('opens the topic when the direct route is the one chosen', async () => {
    const user = userEvent.setup();
    server.on(/\/ledger\/demo-0001$/, TOPIC);
    mount(<App />);

    await paste(user, 'demo-0001');
    await user.click(screen.getByRole('button', { name: 'Open demo-0001' }));

    expect(screen.getByTestId('address')).toHaveTextContent('/topic/demo-0001');
    expect(await screen.findByRole('heading', { name: TOPIC.title })).toBeInTheDocument();
    expect(server.count(/\/ledger\/search/)).toBe(0);
  });

  it('offers the direct route for an l-marked id too', async () => {
    const user = userEvent.setup();
    const marked = { ...RECORD, topic_id: 'ubu-l1652', repo: 'ubu' };
    server.on(/\/ledger\/ubu-l1652$/, marked);
    mount(<App />);

    await paste(user, 'ubu-l1652');
    await user.click(screen.getByRole('button', { name: 'Open ubu-l1652' }));

    expect(screen.getByTestId('address')).toHaveTextContent('/topic/ubu-l1652');
    expect(await screen.findByRole('heading', { name: marked.title })).toBeInTheDocument();
  });

  it('stays out of the way of an ordinary question', async () => {
    const user = userEvent.setup();
    mount(<App />);

    await paste(user, 'why we chose one origin');
    expect(screen.queryByRole('button', { name: /^Open .+-\d+$/ })).not.toBeInTheDocument();
  });
});

describe('the rescue box on the 404 page', () => {
  /**
   * It is the same component as the bar's, which is the point: this page used
   * to carry its own copy of the "trim it and navigate" logic, and a rule
   * written down at one call site and not the others is exactly the defect that
   * stranded a topic once already.
   */
  it('applies the same shape rule as the bar', async () => {
    const user = userEvent.setup();
    mount(<NotFoundView />, { route: '/nowhere' });

    await user.type(screen.getByLabelText('Topic id'), 'not-an-id{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent(/not a topic id/i);
    expect(screen.getByTestId('address')).toHaveTextContent('/nowhere');
  });

  it('opens a well-formed id', async () => {
    const user = userEvent.setup();
    mount(<NotFoundView />, { route: '/nowhere' });

    await user.type(screen.getByLabelText('Topic id'), 'example-0042{Enter}');
    expect(screen.getByTestId('address')).toHaveTextContent('/topic/example-0042');
  });
});
