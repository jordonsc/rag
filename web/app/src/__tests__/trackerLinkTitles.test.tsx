/**
 * The item page names what it links to (rag-t0046): each link's target is
 * read from its own record and its title shown beside the id, the id at once
 * and the title as it arrives, with a muted line for a target that cannot be
 * read. The *From request* line does the same.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ItemView } from '../tracker/ItemView';
import { mountAt } from './harness';
import { TrackerServer, item } from './trackerFixtures';

const ID = 'demo-t0020';
const PATH = `/tracker/items/${ID}`;

let server: TrackerServer;

function topic(id: string, title: string) {
  return {
    id,
    repo: 'demo',
    type: 'decision',
    title,
    summary: '',
    state: '',
    status: 'open',
    tags: [],
    events: [],
    links: [],
  };
}

function withRecord(links: { kind: string; target: string }[]) {
  server.on(PATH, { body: item(ID, { title: 'Linker', links } as never) }, 'GET');
}

beforeEach(() => {
  server = new TrackerServer();
  server.on(/^\/tracker\/items\/demo-t0009(\?|$)/, {
    body: item('demo-t0009', { title: 'The neighbouring ticket' }),
  });
  server.on('/ledger/demo-0042', { body: topic('demo-0042', 'Why the queue is a list') });
  server.on('/tracker/demo/specs/audio', { body: { slug: 'audio', title: 'Audio engine' } });
  server.on('/tracker/demo/concepts/echo', { body: { slug: 'echo', title: 'Echo rooms' } });
  server.on('/tracker/demo/specs/audio/milestones/m03', {
    body: { code: 'm03', title: 'Music', path: 'specs/audio/m03-music.md' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open() {
  return mountAt('/projects/:project/ticket/:id', <ItemView />, {
    route: `/projects/demo/ticket/${ID}`,
  });
}

/** The Links panel's row for one target. */
function row(target: string): HTMLElement {
  const links = screen.getByText('Links').closest('section') ?? document.body;
  const found = within(links as HTMLElement)
    .getAllByRole('listitem')
    .find((li) => li.textContent?.includes(target));
  if (found === undefined) {
    throw new Error(`no link row for ${target}`);
  }
  return found;
}

describe('the item page’s link titles', () => {
  it('names every kind of target beside its id', async () => {
    withRecord([
      { kind: 'item', target: 'demo-t0009' },
      { kind: 'ledger', target: 'demo-0042' },
      { kind: 'spec', target: 'audio' },
      { kind: 'milestone', target: 'audio/m03' },
      { kind: 'concept', target: 'echo' },
    ]);
    server.install();
    open();
    await screen.findByRole('heading', { name: 'Linker' });

    await waitFor(() => expect(row('demo-t0009')).toHaveTextContent('The neighbouring ticket'));
    await waitFor(() => expect(row('demo-0042')).toHaveTextContent('Why the queue is a list'));
    await waitFor(() => expect(row('audio/m03')).toHaveTextContent('Music'));
    await waitFor(() => expect(row('echo')).toHaveTextContent('Echo rooms'));
    expect(within(row('Audio engine')).getByRole('link', { name: 'audio' })).toBeInTheDocument();

    // The title sits beside the link, not in it: the id stays the link's name,
    // and a milestone still opens its document by the path its record gave.
    expect(screen.getByRole('link', { name: 'demo-0042' })).toHaveAttribute(
      'href',
      '/topic/demo-0042',
    );
    expect(screen.getByRole('link', { name: 'audio/m03' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/m03-music.md',
    );
    // A long title is one line; the whole of it is its tooltip.
    expect(screen.getByText('Why the queue is a list')).toHaveAttribute(
      'title',
      'Why the queue is a list',
    );
    // One read per target, the milestone's included (it is not read twice).
    expect(server.matching('/tracker/demo/specs/audio/milestones/m03')).toHaveLength(1);
    expect(server.matching('/ledger/demo-0042')).toHaveLength(1);
  });

  it('shows each id at once, its title slot already laid out, and reads in parallel', async () => {
    withRecord([
      { kind: 'ledger', target: 'demo-0042' },
      { kind: 'item', target: 'demo-t0009' },
    ]);
    server.install();
    // Hold the ledger's answer back: the item's title must not wait for it.
    const installed = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('/ledger/')
        ? held.then(() => installed(input, init))
        : installed(input, init),
    );
    open();
    await screen.findByRole('heading', { name: 'Linker' });

    await waitFor(() => expect(row('demo-t0009')).toHaveTextContent('The neighbouring ticket'));
    // The ledger row: its id a link already, its title slot there and busy.
    expect(screen.getByRole('link', { name: 'demo-0042' })).toBeInTheDocument();
    const slot = row('demo-0042').querySelector('[aria-busy="true"]');
    expect(slot).not.toBeNull();
    expect(slot).toHaveClass('linkTitle');

    release();
    await waitFor(() => expect(row('demo-0042')).toHaveTextContent('Why the queue is a list'));
    // The same slot, filled: nothing was inserted around it.
    expect(row('demo-0042').querySelector('.linkTitle')).not.toHaveAttribute('aria-busy');
  });

  it('follows a moved ledger id to the topic it moved to', async () => {
    withRecord([{ kind: 'ledger', target: 'demo-0007' }]);
    server.on('/ledger/demo-0007', {
      body: { moved: true, moved_to: 'demo-0042', moved_at: '2026-01-01T00:00:00Z' },
    });
    server.install();
    open();
    await screen.findByRole('heading', { name: 'Linker' });

    await waitFor(() => expect(row('demo-0007')).toHaveTextContent('Why the queue is a list'));
    expect(row('demo-0007')).toHaveTextContent('moved to demo-0042');
  });

  /**
   * Both topic id forms (rag-t0051): the `l`-marked ids minted now, in a
   * project with a hyphen of its own, and a legacy id that was moved and now
   * lives under a marked one. Each is a link to its topic and gets its title.
   */
  it('titles ledger links of both id forms, and a legacy id moved to a marked one', async () => {
    withRecord([
      { kind: 'ledger', target: 'shq-suite-l0012' },
      { kind: 'ledger', target: 'demo-0042' },
      { kind: 'ledger', target: 'demo-0005' },
    ]);
    server.on('/ledger/shq-suite-l0012', {
      body: { ...topic('shq-suite-l0012', 'Blinds close at dusk'), repo: 'shq-suite' },
    });
    server.on('/ledger/demo-0005', {
      body: { moved: true, moved_to: 'demo-l0043', moved_at: '2026-10-28T00:00:00Z' },
    });
    server.on('/ledger/demo-l0043', { body: topic('demo-l0043', 'Refiled under the new form') });
    server.install();
    open();
    await screen.findByRole('heading', { name: 'Linker' });

    await waitFor(() => expect(row('shq-suite-l0012')).toHaveTextContent('Blinds close at dusk'));
    await waitFor(() => expect(row('demo-0042')).toHaveTextContent('Why the queue is a list'));
    await waitFor(() => expect(row('demo-0005')).toHaveTextContent('Refiled under the new form'));
    expect(row('demo-0005')).toHaveTextContent('moved to demo-l0043');
    expect(screen.getByRole('link', { name: 'shq-suite-l0012' })).toHaveAttribute(
      'href',
      '/topic/shq-suite-l0012',
    );
    expect(screen.getByRole('link', { name: 'demo-0042' })).toHaveAttribute(
      'href',
      '/topic/demo-0042',
    );
  });

  it('says, muted, when a target is unknown, moved away or unreadable', async () => {
    withRecord([
      { kind: 'item', target: 'demo-t0404' },
      { kind: 'ledger', target: 'demo-0008' },
      { kind: 'concept', target: 'broken' },
    ]);
    server.on(/^\/tracker\/items\/demo-t0404/, { status: 404, body: { error: 'no such item' } });
    server.on('/ledger/demo-0008', {
      body: { moved: true, moved_to: 'demo-0999', moved_at: '2026-01-01T00:00:00Z' },
    });
    server.on('/ledger/demo-0999', { status: 404, body: { error: 'no such topic' } });
    server.on('/tracker/demo/concepts/broken', { status: 500, body: { error: 'boom' } });
    server.install();
    open();
    await screen.findByRole('heading', { name: 'Linker' });

    await waitFor(() => expect(row('demo-t0404')).toHaveTextContent('Not found'));
    await waitFor(() =>
      expect(row('demo-0008')).toHaveTextContent('Moved to demo-0999, not found'),
    );
    await waitFor(() => expect(row('broken')).toHaveTextContent('Title unavailable'));
    for (const text of ['Not found', 'Moved to demo-0999, not found', 'Title unavailable']) {
      expect(screen.getByText(text)).toHaveClass('linkTitleMissing');
    }
    // The id is still there, and still a link where it can be one.
    expect(screen.getByRole('link', { name: 'demo-t0404' })).toBeInTheDocument();
  });

  it('names the request a ticket came from', async () => {
    withRecord([{ kind: 'from', target: 'demo-t0009' }]);
    server.install();
    open();
    await screen.findByRole('heading', { name: 'Linker' });

    const from = screen.getByText('From request').closest('div')!;
    expect(within(from).getByRole('link', { name: 'demo-t0009' })).toBeInTheDocument();
    await waitFor(() => expect(from).toHaveTextContent('The neighbouring ticket'));
  });

  it('keeps the titles across a re-read after a write that leaves the links alone', async () => {
    const user = userEvent.setup();
    withRecord([{ kind: 'ledger', target: 'demo-0042' }]);
    server.on(PATH, { body: item(ID, { title: 'Linker' }) }, 'POST');
    server.install();
    open();
    await screen.findByRole('heading', { name: 'Linker' });
    await waitFor(() => expect(row('demo-0042')).toHaveTextContent('Why the queue is a list'));

    await user.click(screen.getByRole('button', { name: 'Note' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a note' });
    await user.type(within(dialog).getByLabelText('Note'), 'Looked');
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(server.matching(PATH, 'GET')).toHaveLength(2));

    // The page re-read the item; the link's title was neither blanked nor re-read.
    expect(row('demo-0042')).toHaveTextContent('Why the queue is a list');
    expect(server.matching('/ledger/demo-0042')).toHaveLength(1);
  });
});
