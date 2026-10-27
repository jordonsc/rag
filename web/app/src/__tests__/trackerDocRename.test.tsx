/**
 * rag-t0003: renaming a document from its page, and editing a spec's or
 * milestone's title and a milestone's place from the Specs tab. Every write
 * is `surface: 'web'`; the server is a stateful fake, so a rename's redirect
 * and a reload are read back as the real one would answer them.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocsView } from '../tracker/DocsView';
import { DocView } from '../tracker/DocView';
import type { Concept, DocumentView, Milestone, Spec, TrackerEvent } from '../tracker/types';
import { AUTHOR, mountAt } from './harness';
import { STAMP, TrackerServer, type TrackerSent } from './trackerFixtures';

const DOC_ID = 'demo-d0002';
const RENAME = `/tracker/docs/${DOC_ID}/rename`;
const CONCEPT_URL = '/tracker/demo/concepts/power';

function event(id: number, kind: TrackerEvent['kind'], body: string): TrackerEvent {
  return {
    event_id: id,
    ts: STAMP,
    author_email: AUTHOR,
    agent: 'Unknown',
    surface: 'web',
    kind,
    body,
    fields: {},
  };
}

/** A document and its concept as the server holds them, with its redirects. */
class DocStore {
  path = 'concepts/power.md';
  title = 'Power';
  conceptTitle = 'Power';
  redirects: string[] = [];
  docEvents: TrackerEvent[] = [event(1, 'create', 'Wrote it down.')];
  conceptEvents: TrackerEvent[] = [];

  view(asked: string): DocumentView {
    return {
      id: DOC_ID,
      project: 'demo',
      path: this.path,
      kind: 'concept',
      title: this.title,
      revision: 1,
      spec: null,
      milestone: null,
      concept: 'power',
      created_at: STAMP,
      updated_at: STAMP,
      body: 'Notes on power.',
      body_revision: 1,
      redirected_from: asked === this.path ? null : asked,
      events: this.docEvents,
    };
  }

  concept(): Concept {
    return {
      project: 'demo',
      slug: 'power',
      title: this.conceptTitle,
      state: 'open',
      approval: 'unapproved',
      links: [],
      doc_id: DOC_ID,
      path: this.path,
      created_at: STAMP,
      updated_at: STAMP,
      events: this.conceptEvents,
    };
  }

  install(server: TrackerServer, refuseConcept = false) {
    server.on(
      /^\/tracker\/demo\/doc\?path=/,
      (sent: TrackerSent) => {
        const asked = new URLSearchParams(sent.path.split('?')[1]).get('path') ?? '';
        if (asked !== this.path && !this.redirects.includes(asked)) {
          return { status: 404, body: { error: `no document at ${asked}` } };
        }
        return { body: this.view(asked) };
      },
      'GET',
    );
    server.on(CONCEPT_URL, () => ({ body: this.concept() }), 'GET');
    server.on(`/tracker/docs/${DOC_ID}/revisions`, { body: { doc_id: DOC_ID, revisions: [] } });
    server.on(
      RENAME,
      (sent: TrackerSent) => {
        const body = sent.body ?? {};
        if (body.path === 'concepts/taken.md') {
          return { status: 400, body: { error: 'path concepts/taken.md is taken' } };
        }
        if (typeof body.path === 'string') {
          this.redirects.push(this.path);
          this.path = body.path;
        }
        if (typeof body.title === 'string') {
          this.title = body.title;
        }
        this.docEvents = [
          ...this.docEvents,
          event(this.docEvents.length + 10, 'rename', String(body.note ?? 'Renamed.')),
        ];
        return { body: this.view(this.path) };
      },
      'POST',
    );
    server.on(
      CONCEPT_URL,
      (sent: TrackerSent) => {
        if (refuseConcept) {
          return { status: 400, body: { error: 'the concept store said no' } };
        }
        this.conceptTitle = String(sent.body?.title);
        this.conceptEvents = [...this.conceptEvents, event(50, 'edit', 'Set title.')];
        return { body: this.concept() };
      },
      'POST',
    );
  }
}

/**
 * Replace a field's text in one input event: typing key by key is slow enough
 * to time out under a loaded machine, and the keystrokes are not what is tested.
 */
async function fill(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, value: string) {
  await user.clear(field);
  if (value !== '') {
    await user.click(field);
    await user.paste(value);
  }
}

let server: TrackerServer;

beforeEach(() => {
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openDoc(path: string, identity?: string | null) {
  return mountAt('/projects/:project/doc/*', <DocView />, {
    route: `/projects/demo/doc/${path}`,
    ...(identity === undefined ? {} : { identity }),
  });
}

async function renameDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Rename…' }));
  return screen.getByRole('dialog', { name: 'Rename the document' });
}

// ---- A document's page: Rename… --------------------------------------------

describe('renaming a document', () => {
  it('renames path and title with a note, retitles its concept, and the old path still opens it', async () => {
    const user = userEvent.setup();
    const store = new DocStore();
    store.install(server);
    server.install();
    const { unmount } = openDoc('concepts/power.md');
    await screen.findByRole('heading', { name: 'Power', level: 1 });
    // The record has arrived, so the dialog can offer to retitle it.
    await screen.findByRole('button', { name: 'State…' });

    const dialog = await renameDialog(user);
    const box = within(dialog).getByRole('checkbox', { name: 'Retitle the concept power too' });
    expect(box).toBeChecked();
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, title, 'Power generation');
    const path = within(dialog).getByRole('textbox', { name: 'Path' });
    await fill(user, path, 'concepts/power-generation.md');
    expect(
      within(dialog).getByText('concepts/power.md will keep opening this document.'),
    ).toBeInTheDocument();
    await fill(user, within(dialog).getByLabelText('Note (optional)'), 'Clearer name');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(server.matching(CONCEPT_URL, 'POST')).toHaveLength(1));
    expect(server.last(RENAME, 'POST').body).toEqual({
      path: 'concepts/power-generation.md',
      title: 'Power generation',
      note: 'Clearer name',
      author_email: AUTHOR,
      surface: 'web',
    });
    expect(server.last(CONCEPT_URL, 'POST').body).toEqual({
      title: 'Power generation',
      note: 'Clearer name',
      author_email: AUTHOR,
      surface: 'web',
    });

    // The page moves to the new path and says where it came from.
    expect(
      await screen.findByRole('heading', { name: 'Power generation', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent(
      /^\/projects\/demo\/doc\/concepts\/power-generation\.md$/,
    );
    expect(screen.getByText(/was renamed: this is its current path/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    // A reload at the old path: the server redirects, and the History tab
    // carries both writes (the document's rename, the concept's title).
    openDoc('concepts/power.md?tab=history');
    expect(
      await screen.findByRole('heading', { name: 'Power generation', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent(
      '/projects/demo/doc/concepts/power-generation.md?tab=history',
    );
    expect(await screen.findByText('Clearer name')).toBeInTheDocument();
    expect(await screen.findByText('Set title.')).toBeInTheDocument();
  });

  it('retitles only the document when the record box is unticked, and stays on its path', async () => {
    const user = userEvent.setup();
    const store = new DocStore();
    store.install(server);
    server.install();
    openDoc('concepts/power.md');
    await screen.findByRole('button', { name: 'State…' });

    const dialog = await renameDialog(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /Retitle the concept/ }));
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, title, 'Power, again');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    expect(
      await screen.findByRole('heading', { name: 'Power, again', level: 1 }),
    ).toBeInTheDocument();
    expect(server.last(RENAME, 'POST').body).toEqual({
      title: 'Power, again',
      author_email: AUTHOR,
      surface: 'web',
    });
    expect(server.matching(CONCEPT_URL, 'POST')).toHaveLength(0);
    expect(screen.getByTestId('address')).toHaveTextContent(
      /^\/projects\/demo\/doc\/concepts\/power\.md$/,
    );
  });

  it('refuses a path the server would refuse, and an unchanged rename, without sending', async () => {
    const user = userEvent.setup();
    new DocStore().install(server);
    server.install();
    openDoc('concepts/power.md');
    await screen.findByRole('button', { name: 'State…' });

    const dialog = await renameDialog(user);
    const button = within(dialog).getByRole('button', { name: 'Rename' });
    expect(button).toBeDisabled();

    const path = within(dialog).getByRole('textbox', { name: 'Path' });
    await fill(user, path, 'concepts/power plan.txt');
    await user.click(button);
    expect(within(dialog).getByText(/ending in \.md/)).toBeInTheDocument();

    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, path, 'concepts/power.md');
    await user.clear(title);
    await user.click(button);
    expect(within(dialog).getByText('A title needs some text.')).toBeInTheDocument();
    expect(server.matching(RENAME, 'POST')).toHaveLength(0);
  });

  it('keeps the dialog open with the server’s sentence when the path is taken', async () => {
    const user = userEvent.setup();
    new DocStore().install(server);
    server.install();
    openDoc('concepts/power.md');
    await screen.findByRole('button', { name: 'State…' });

    const dialog = await renameDialog(user);
    const path = within(dialog).getByRole('textbox', { name: 'Path' });
    await fill(user, path, 'concepts/taken.md');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'path concepts/taken.md is taken',
    );
    expect(server.matching(CONCEPT_URL, 'POST')).toHaveLength(0);
    expect(screen.getByTestId('address')).toHaveTextContent(
      /^\/projects\/demo\/doc\/concepts\/power\.md$/,
    );
  });

  it('says what was not done when the record’s retitle is refused after the rename', async () => {
    const user = userEvent.setup();
    new DocStore().install(server, true);
    server.install();
    openDoc('concepts/power.md');
    await screen.findByRole('button', { name: 'State…' });

    const dialog = await renameDialog(user);
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, title, 'Watts');
    const path = within(dialog).getByRole('textbox', { name: 'Path' });
    await fill(user, path, 'concepts/watts.md');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('heading', { name: 'Watts', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The document was renamed, but the concept’s title was not changed: the concept store said no',
    );
  });

  it('opens the identity prompt instead of the dialog when nobody is signed', async () => {
    const user = userEvent.setup();
    new DocStore().install(server);
    server.install();
    openDoc('concepts/power.md', null);
    await user.click(await screen.findByRole('button', { name: 'Rename…' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Rename the document' })).not.toBeInTheDocument();
    expect(server.matching(RENAME, 'POST')).toHaveLength(0);
  });
});

// ---- The Specs tab ----------------------------------------------------------

function milestone(code: string, order: number, title: string): Milestone {
  return {
    project: 'demo',
    spec: 'audio',
    code,
    title,
    order,
    state: 'not_started',
    approval: 'unapproved',
    doc_id: `demo-d01${code.slice(1)}`,
    path: `specs/audio/${code}-${title.toLowerCase().replace(/ /g, '-')}.md`,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

/** One spec and its milestones as the server holds them. */
class SpecStore {
  title = 'Audio';
  milestones: Milestone[] = [
    milestone('m01', 1, 'Sound effects'),
    milestone('m02', 2, 'Voices'),
    milestone('m03', 3, 'Music'),
  ];
  docTitle = 'Audio';
  refuseMilestone: string | null = null;

  spec(): Spec {
    return {
      project: 'demo',
      slug: 'audio',
      title: this.title,
      state: 'draft',
      approval: 'unapproved',
      doc_id: 'demo-d0005',
      path: 'specs/audio/master.md',
      milestones: [...this.milestones].sort((a, b) =>
        a.order !== b.order ? a.order - b.order : a.code.localeCompare(b.code),
      ),
      created_at: STAMP,
      updated_at: STAMP,
    };
  }

  install(server: TrackerServer) {
    server.on('/tracker/demo/concepts', { body: { project: 'demo', concepts: [] } });
    server.on('/tracker/demo/docs?kind=doc', { body: { project: 'demo', documents: [] } });
    server.on('/tracker/demo/specs', () => ({ body: { project: 'demo', specs: [this.spec()] } }));
    server.on(
      '/tracker/demo/specs/audio',
      (sent: TrackerSent) => {
        this.title = String(sent.body?.title);
        return { body: this.spec() };
      },
      'POST',
    );
    server.on(
      /^\/tracker\/demo\/specs\/audio\/milestones\/m0\d$/,
      (sent: TrackerSent) => {
        const code = sent.path.split('/').at(-1)!;
        if (code === this.refuseMilestone) {
          return { status: 400, body: { error: `milestone ${code} is locked` } };
        }
        const found = this.milestones.find((candidate) => candidate.code === code)!;
        const body = sent.body ?? {};
        Object.assign(found, {
          ...(typeof body.order === 'number' ? { order: body.order } : {}),
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
        });
        return { body: found };
      },
      'POST',
    );
    server.on(/^\/tracker\/docs\/demo-d0\d+\?history=false$/, (sent: TrackerSent) => ({
      body: { id: sent.path.split('/').at(-1)!.split('?')[0], title: this.docTitle },
    }));
    server.on(
      /^\/tracker\/docs\/demo-d0\d+\/rename$/,
      (sent: TrackerSent) => {
        this.docTitle = String(sent.body?.title);
        return { body: {} };
      },
      'POST',
    );
  }
}

function openSpecs(identity?: string | null) {
  return mountAt('/projects/:project/docs', <DocsView />, {
    route: '/projects/demo/docs?tab=specs',
    ...(identity === undefined ? {} : { identity }),
  });
}

function milestoneCodes(): string[] {
  const list = screen.getByRole('list', { name: /milestones$/ });
  return within(list)
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('data-code') ?? '');
}

const MILESTONE = (code: string) => `/tracker/demo/specs/audio/milestones/${code}`;

describe('the Specs tab', () => {
  it('edits a spec’s title, and its document’s with it', async () => {
    const user = userEvent.setup();
    const store = new SpecStore();
    store.install(server);
    server.install();
    openSpecs();
    await user.click(await screen.findByRole('button', { name: 'Edit the title of audio' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit the spec’s title' });
    expect(within(dialog).getByRole('button', { name: 'Save title' })).toBeDisabled();
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, title, 'Sound');
    await fill(user, within(dialog).getByLabelText('Note (optional)'), 'Broader');
    await user.click(within(dialog).getByRole('button', { name: 'Save title' }));

    expect(await screen.findByRole('link', { name: 'Sound' })).toBeInTheDocument();
    expect(server.last('/tracker/demo/specs/audio', 'POST').body).toEqual({
      title: 'Sound',
      note: 'Broader',
      author_email: AUTHOR,
      surface: 'web',
    });
    expect(server.last('/tracker/docs/demo-d0005/rename', 'POST').body).toEqual({
      title: 'Sound',
      note: 'Broader',
      author_email: AUTHOR,
      surface: 'web',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits a milestone’s title alone when the document box is unticked', async () => {
    const user = userEvent.setup();
    new SpecStore().install(server);
    server.install();
    openSpecs();
    await user.click(await screen.findByRole('button', { name: 'Edit the title of audio/m02' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit the milestone’s title' });
    await user.click(within(dialog).getByRole('checkbox', { name: /Retitle its document/ }));
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, title, 'Dialogue');
    await user.click(within(dialog).getByRole('button', { name: 'Save title' }));

    expect(await screen.findByRole('link', { name: 'Dialogue' })).toBeInTheDocument();
    expect(server.last(MILESTONE('m02'), 'POST').body).toEqual({
      title: 'Dialogue',
      author_email: AUTHOR,
      surface: 'web',
    });
    expect(server.matching(/\/rename$/, 'POST')).toHaveLength(0);
  });

  it('does not rename a document that already has the title', async () => {
    const user = userEvent.setup();
    const store = new SpecStore();
    store.docTitle = 'Sound';
    store.install(server);
    server.install();
    openSpecs();
    await user.click(await screen.findByRole('button', { name: 'Edit the title of audio' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit the spec’s title' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await fill(user, title, 'Sound');
    await user.click(within(dialog).getByRole('button', { name: 'Save title' }));
    expect(await screen.findByRole('link', { name: 'Sound' })).toBeInTheDocument();
    expect(server.matching(/\?history=false$/)).toHaveLength(1);
    expect(server.matching(/\/rename$/, 'POST')).toHaveLength(0);
  });

  it('moves a milestone up: two order writes, each with its note, and the focus stays', async () => {
    const user = userEvent.setup();
    new SpecStore().install(server);
    server.install();
    openSpecs();
    await screen.findByRole('list', { name: 'Audio milestones' });
    expect(screen.getByRole('button', { name: 'Move audio/m01 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move audio/m03 down' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move audio/m02 up' }));
    await waitFor(() => expect(milestoneCodes()).toEqual(['m02', 'm01', 'm03']));
    expect(server.matching(/\/milestones\//, 'POST').map((sent) => sent.body)).toEqual([
      { order: 1, note: 'Moved up, before m01.', author_email: AUTHOR, surface: 'web' },
      { order: 2, note: 'Moved down, after m02.', author_email: AUTHOR, surface: 'web' },
    ]);
    // At the top, its Up is disabled: the focus goes to its Down.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move audio/m02 down' })).toHaveFocus(),
    );

    await user.click(screen.getByRole('button', { name: 'Move audio/m02 down' }));
    await waitFor(() => expect(milestoneCodes()).toEqual(['m01', 'm02', 'm03']));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move audio/m02 down' })).toHaveFocus(),
    );
  });

  it('says so when a move is refused, and shows the server’s order', async () => {
    const user = userEvent.setup();
    const store = new SpecStore();
    store.refuseMilestone = 'm02';
    store.install(server);
    server.install();
    openSpecs();
    await screen.findByRole('list', { name: 'Audio milestones' });
    await user.click(screen.getByRole('button', { name: 'Move audio/m03 up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not move audio/m03 up (part of it landed: the list shows the server’s order): milestone m02 is locked',
    );
    // m03's write landed (order 2, tied with m02; m02 sorts first by code).
    expect(milestoneCodes()).toEqual(['m01', 'm02', 'm03']);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move audio/m03 up' })).toBeEnabled(),
    );
  });

  it('opens the identity prompt instead of writing when nobody is signed', async () => {
    const user = userEvent.setup();
    new SpecStore().install(server);
    server.install();
    openSpecs(null);
    await user.click(await screen.findByRole('button', { name: 'Move audio/m02 up' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(server.matching(/\/milestones\//, 'POST')).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: /title/ })).not.toBeInTheDocument();
  });
});
