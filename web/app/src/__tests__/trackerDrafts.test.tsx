/**
 * Drafts and Ctrl+S (2026-10-30).
 *
 * Drafts: the dashboard's Drafts section (above Requests, out of the queue),
 * **Publish** and **Make draft** from the dashboard, the ticket page and a
 * document's page, and **Save as draft** on Add ticket, Add request, Add gate
 * and New concept, each sending exactly the `draft` it means.
 *
 * Ctrl+S (Cmd+S): it saves the document editor from anywhere on the page, the
 * ticket's Edit and the add dialogs (as their main button, never as a draft),
 * does nothing while Save cannot be pressed or a modal covers the form, and
 * always keeps the browser's Save Page from opening.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';

import { DocView } from '../tracker/DocView';
import { draftKey, hasDraft } from '../tracker/drafts';
import { ItemView } from '../tracker/ItemView';
import { NewConceptView } from '../tracker/NewConceptView';
import { summary } from '../tracker/ProjectPicker';
import { QueueView } from '../tracker/QueueView';
import type { DocumentView, QueueView as QueueViewRecord } from '../tracker/types';
import { AUTHOR, mount, mountAt } from './harness';
import { STAMP, TrackerServer, item, queueRoute, queueView } from './trackerFixtures';

const QUEUE = /^\/tracker\/demo$/;
const ITEMS = '/tracker/demo/items';
const AS_OWNER = { author_email: AUTHOR, surface: 'web' };

let server: TrackerServer;
let view: QueueViewRecord;

beforeEach(() => {
  view = queueView({
    drafts: [item('demo-t0020', { title: 'Half-written idea' })],
    requests: [item('demo-t0021', { type: 'request', title: 'A request' })],
  });
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
  server.on(
    QUEUE,
    queueRoute(() => view),
    'GET',
  );
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openQueue() {
  return mountAt('/projects/:project', <QueueView />, { route: '/projects/demo' });
}

/** Press Ctrl+S (or Cmd+S) on `target`; whether the browser's default was kept off. */
function pressSave(target: Element | Window = document.body, mac = false): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: !mac,
    metaKey: mac,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

// ---- The dashboard ----------------------------------------------------------

describe('drafts on the dashboard', () => {
  it('draws Drafts above Requests, out of the queue, each with a Draft badge', async () => {
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Done', 'Drafts', 'Requests', 'Queue', 'Blocked']);
    const drafts = screen.getByRole('region', { name: 'Drafts' });
    const row = within(drafts).getByRole('listitem');
    expect(row).toHaveAttribute('data-id', 'demo-t0020');
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    const queue = within(screen.getByRole('list', { name: 'Queue' }))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-id'));
    expect(queue).not.toContain('demo-t0020');
  });

  it('publishes a draft, sending draft false', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0020', { body: item('demo-t0020') }, 'POST');
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Publish demo-t0020' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0020', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0020', 'POST').body).toEqual({
      draft: false,
      ...AS_OWNER,
    });
  });

  it('makes a queued ticket a draft from its row menu, sending draft true', async () => {
    const user = userEvent.setup();
    server.on('/tracker/items/demo-t0005', { body: item('demo-t0005') }, 'POST');
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Actions for demo-t0005' }));
    await user.click(screen.getByRole('menuitem', { name: 'Make draft' }));
    const dialog = screen.getByRole('dialog', { name: 'Make this ticket a draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Make draft' }));
    await waitFor(() =>
      expect(server.matching('/tracker/items/demo-t0005', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/items/demo-t0005', 'POST').body).toEqual({
      draft: true,
      ...AS_OWNER,
    });
  });

  it('Save as draft on Add ticket sends draft true; the main button sends none', async () => {
    const user = userEvent.setup();
    server.on(ITEMS, { body: item('demo-t0030') }, 'POST');
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    let dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Quiet idea');
    await user.click(within(dialog).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(server.matching(ITEMS, 'POST')).toHaveLength(1));
    expect(server.last(ITEMS, 'POST').body).toEqual({
      type: 'dev',
      title: 'Quiet idea',
      body: '',
      approval: 'owner',
      draft: true,
      ...AS_OWNER,
    });

    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'Loud idea');
    await user.click(within(dialog).getByRole('button', { name: 'Add to the bottom' }));
    await waitFor(() => expect(server.matching(ITEMS, 'POST')).toHaveLength(2));
    expect(server.last(ITEMS, 'POST').body).not.toHaveProperty('draft');
  });

  it('Save as draft on Add request and Add gate sends draft true', async () => {
    const user = userEvent.setup();
    server.on(ITEMS, { body: item('demo-t0030') }, 'POST');
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });

    await user.click(screen.getByRole('button', { name: 'Add request' }));
    let dialog = screen.getByRole('dialog', { name: 'Add a request' });
    await user.type(within(dialog).getByLabelText('Title'), 'Later, maybe');
    await user.click(within(dialog).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(server.matching(ITEMS, 'POST')).toHaveLength(1));
    expect(server.last(ITEMS, 'POST').body).toMatchObject({ type: 'request', draft: true });

    await user.click(screen.getByRole('button', { name: 'Add gate' }));
    dialog = screen.getByRole('dialog', { name: 'Add a gate' });
    await user.click(within(dialog).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(server.matching(ITEMS, 'POST')).toHaveLength(2));
    expect(server.last(ITEMS, 'POST').body).toMatchObject({ type: 'gate', draft: true });
  });

  it('counts drafts in a project’s summary', () => {
    const base = {
      name: 'demo',
      created_at: STAMP,
      queued: 5,
      blocked: 0,
      done_unacknowledged: 0,
    };
    expect(summary({ ...base, drafts: 2 })).toBe('5 queued · 2 drafts');
    expect(summary({ ...base, drafts: 1 })).toBe('5 queued · 1 draft');
    expect(summary(base)).toBe('5 queued');
  });
});

// ---- Ctrl+S in the add dialogs ----------------------------------------------

describe('Ctrl+S in the add dialogs', () => {
  it('is the main button, never a draft', async () => {
    const user = userEvent.setup();
    server.on(ITEMS, { body: item('demo-t0030') }, 'POST');
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });
    await user.click(screen.getByRole('button', { name: 'Add ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a ticket' });
    await user.type(within(dialog).getByLabelText('Title'), 'By keyboard');
    expect(pressSave(within(dialog).getByLabelText('Title'), true)).toBe(true);
    await waitFor(() => expect(server.matching(ITEMS, 'POST')).toHaveLength(1));
    expect(server.last(ITEMS, 'POST').body).toMatchObject({ title: 'By keyboard' });
    expect(server.last(ITEMS, 'POST').body).not.toHaveProperty('draft');
  });

  it('leaves the browser alone when no form is open', async () => {
    openQueue();
    await screen.findByRole('heading', { name: 'demo' });
    expect(pressSave()).toBe(false);
  });
});

// ---- The ticket page --------------------------------------------------------

describe('drafts and Ctrl+S on the ticket page', () => {
  const ID = 'demo-t0020';
  const PATH = `/tracker/items/${ID}`;

  function openTicket(draft: boolean, identity?: string | null) {
    const record = item(ID, {
      title: 'Half-written idea',
      draft,
      events: [
        {
          event_id: 1,
          ts: STAMP,
          author_email: AUTHOR,
          agent: 'Owner',
          surface: 'web',
          kind: 'create',
          body: 'Created dev ticket.',
          fields: { type: 'dev', draft },
          draft,
        },
      ],
    });
    server.on(PATH, { body: record }, 'GET');
    server.on(PATH, { body: record }, 'POST');
    return mountAt('/projects/:project/ticket/:id', <ItemView />, {
      route: `/projects/demo/ticket/${ID}`,
      ...(identity === undefined ? {} : { identity }),
    });
  }

  it('shows a draft’s badge and Publish, which sends draft false', async () => {
    const user = userEvent.setup();
    openTicket(true);
    await screen.findByRole('heading', { name: 'Half-written idea' });
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Make draft' })).not.toBeInTheDocument();
    // The history marks what was written while a draft.
    expect(screen.getByTitle('Written while a draft: left out of the feed')).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('group', { name: 'Draft' })).getByRole('button', {
        name: 'Publish',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Publish this ticket?' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({ draft: false, ...AS_OWNER });
  });

  it('offers Make draft on a published queued ticket, which sends draft true', async () => {
    const user = userEvent.setup();
    openTicket(false);
    await screen.findByRole('heading', { name: 'Half-written idea' });
    expect(screen.queryByRole('group', { name: 'Draft' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make draft' }));
    const dialog = screen.getByRole('dialog', { name: 'Make this ticket a draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Make draft' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({ draft: true, ...AS_OWNER });
  });

  it('Ctrl+S saves the Edit dialog, and does nothing while nothing changed', async () => {
    const user = userEvent.setup();
    openTicket(false);
    await screen.findByRole('heading', { name: 'Half-written idea' });
    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });

    expect(pressSave(title)).toBe(true);
    expect(server.matching(PATH, 'POST')).toHaveLength(0);

    await user.clear(title);
    await user.type(title, 'A better title');
    // From anywhere in the dialog, not only a text box.
    expect(pressSave(dialog)).toBe(true);
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toEqual({ title: 'A better title', ...AS_OWNER });
  });

  it('Ctrl+S leaves the Edit dialog open, and the next save sends only what changed since', async () => {
    const user = userEvent.setup();
    openTicket(false);
    await screen.findByRole('heading', { name: 'Half-written idea' });
    server.onceOn(PATH, { body: item(ID, { title: 'A better title' }) }, 'POST');
    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'A better title');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Why');

    pressSave(dialog);
    await within(dialog).findByText('Saved.');
    expect(screen.getByRole('dialog', { name: `Edit ${ID}` })).toBe(dialog);
    expect(title).toHaveValue('A better title');
    // The note is said once; the cursor stays in it.
    const noteBox = within(dialog).getByRole('textbox', { name: 'Note' });
    expect(noteBox).toHaveValue('');
    expect(noteBox).toHaveFocus();
    // Saved and untouched: nothing more to send.
    pressSave(dialog);
    expect(server.matching(PATH, 'POST')).toHaveLength(1);

    await user.type(within(dialog).getByRole('textbox', { name: 'Assignee' }), 'dev-3');
    expect(within(dialog).queryByText('Saved.')).not.toBeInTheDocument();
    pressSave(dialog);
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(2));
    expect(server.last(PATH, 'POST').body).toEqual({ assignee: 'dev-3', ...AS_OWNER });
  });

  it('the Edit dialog’s Save button still closes it', async () => {
    const user = userEvent.setup();
    openTicket(false);
    await screen.findByRole('heading', { name: 'Half-written idea' });
    await user.click(screen.getByRole('button', { name: /Edit…/ }));
    const dialog = screen.getByRole('dialog', { name: `Edit ${ID}` });
    await user.type(within(dialog).getByRole('textbox', { name: 'Assignee' }), 'dev-3');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: `Edit ${ID}` })).not.toBeInTheDocument(),
    );
  });
});

// ---- Documents --------------------------------------------------------------

describe('drafts and Ctrl+S on a document', () => {
  const DOC_ID = 'demo-d0002';
  const DOC_URL = `/tracker/demo/doc?path=${encodeURIComponent('concepts/power.md')}`;
  const WRITE = `/tracker/docs/${DOC_ID}/write`;
  const DRAFT = `/tracker/docs/${DOC_ID}/draft`;

  function doc(overrides: Partial<DocumentView> = {}): DocumentView {
    return {
      id: DOC_ID,
      project: 'demo',
      path: 'concepts/power.md',
      kind: 'doc',
      title: 'Power',
      revision: 2,
      spec: null,
      milestone: null,
      concept: null,
      created_at: STAMP,
      updated_at: STAMP,
      body: 'Notes on power.',
      body_revision: 2,
      redirected_from: null,
      events: [],
      ...overrides,
    };
  }

  function openDoc(draft: boolean, search = '', identity?: string | null) {
    server.on(DOC_URL, { body: doc({ draft }) }, 'GET');
    server.on(DRAFT, { body: doc({ draft: !draft }) }, 'POST');
    server.on(WRITE, { body: doc({ revision: 3 }) }, 'POST');
    server.on(`/tracker/docs/${DOC_ID}/revisions`, { body: { doc_id: DOC_ID, revisions: [] } });
    return mountAt('/projects/:project/doc/*', <DocView />, {
      route: `/projects/demo/doc/concepts/power.md${search}`,
      ...(identity === undefined ? {} : { identity }),
    });
  }

  async function editor(): Promise<HTMLTextAreaElement> {
    return (await screen.findByRole('textbox', { name: 'Markdown' })) as HTMLTextAreaElement;
  }

  it('publishes a draft document through its draft route', async () => {
    const user = userEvent.setup();
    openDoc(true);
    await screen.findByRole('heading', { name: 'Power' });
    expect(screen.getByText('Draft')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish this document?' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Ready now');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(server.matching(DRAFT, 'POST')).toHaveLength(1));
    expect(server.last(DRAFT, 'POST').body).toEqual({
      draft: false,
      note: 'Ready now',
      ...AS_OWNER,
    });
  });

  it('makes a published document a draft', async () => {
    const user = userEvent.setup();
    openDoc(false);
    await screen.findByRole('heading', { name: 'Power' });
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make draft' }));
    const dialog = screen.getByRole('dialog', { name: 'Make this document a draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Make draft' }));
    await waitFor(() => expect(server.matching(DRAFT, 'POST')).toHaveLength(1));
    expect(server.last(DRAFT, 'POST').body).toEqual({ draft: true, ...AS_OWNER });
  });

  it('offers no Publish or Make draft on a spec’s or a milestone’s document', async () => {
    for (const kind of ['spec', 'milestone'] as const) {
      server.on(DOC_URL, { body: doc({ kind, draft: false }) }, 'GET');
      server.on(`/tracker/docs/${DOC_ID}/revisions`, { body: { doc_id: DOC_ID, revisions: [] } });
      const { unmount } = mountAt('/projects/:project/doc/*', <DocView />, {
        route: '/projects/demo/doc/concepts/power.md',
      });
      await screen.findByRole('heading', { name: 'Power' });
      expect(screen.queryByRole('button', { name: 'Make draft' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('Ctrl+S saves the editor from outside the text box', async () => {
    const user = userEvent.setup();
    openDoc(false, '?tab=edit');
    const area = await editor();
    // Nothing changed: the key is taken from the browser, and nothing is sent.
    expect(pressSave()).toBe(true);
    expect(server.matching(WRITE, 'POST')).toHaveLength(0);

    await user.type(area, ' More.');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Added');
    // Focus in the message box, the key pressed on the page itself.
    expect(pressSave(window, true)).toBe(true);
    await waitFor(() => expect(server.matching(WRITE, 'POST')).toHaveLength(1));
    expect(server.last(WRITE, 'POST').body).toEqual({
      base_revision: 2,
      body: 'Notes on power. More.',
      message: 'Added',
      ...AS_OWNER,
    });
  });

  it('Ctrl+S stays in the editor, cursor and all, and the next save builds on the new revision', async () => {
    const user = userEvent.setup();
    openDoc(false, '?tab=edit');
    const area = await editor();
    await user.type(area, ' More.');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Added');
    await user.click(area);

    server.onceOn(WRITE, { body: doc({ revision: 3 }) }, 'POST');
    pressSave(area);
    await screen.findByText('Saved as revision 3.');
    expect(await editor()).toBe(area);
    expect(area).toHaveFocus();
    expect(area).toHaveValue('Notes on power. More.');
    expect(screen.getByTestId('address')).toHaveTextContent('tab=edit');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    // Saved and untouched: nothing more to send.
    pressSave(area);
    expect(server.matching(WRITE, 'POST')).toHaveLength(1);

    await user.type(area, ' Again.');
    expect(screen.queryByText('Saved as revision 3.')).not.toBeInTheDocument();
    server.onceOn(WRITE, { body: doc({ revision: 4 }) }, 'POST');
    pressSave(area);
    await waitFor(() => expect(server.matching(WRITE, 'POST')).toHaveLength(2));
    expect(server.last(WRITE, 'POST').body).toEqual({
      base_revision: 3,
      body: 'Notes on power. More. Again.',
      ...AS_OWNER,
    });
    await screen.findByText('Saved as revision 4.');
  });

  it('text typed while Ctrl+S is in flight stays unsaved', async () => {
    const user = userEvent.setup();
    openDoc(false, '?tab=edit');
    const area = await editor();
    await user.type(area, ' More.');
    // Hold the write open until the typing is done.
    const answer = globalThis.fetch;
    let finish: () => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === WRITE
          ? new Promise<Response>((resolve, reject) => {
              finish = () => void answer(input, init).then(resolve, reject);
            })
          : answer(input, init),
      ),
    );
    pressSave(area);
    await user.type(area, ' Later.');
    finish();

    await screen.findByRole('button', { name: /Close \(keeps your unsaved changes\)/ });
    await waitFor(() => expect(server.matching(WRITE, 'POST')).toHaveLength(1));
    expect(server.last(WRITE, 'POST').body).toMatchObject({
      base_revision: 2,
      body: 'Notes on power. More.',
    });
    expect(area).toHaveValue('Notes on power. More. Later.');
    // Saved, but what came after it is not, so it says nothing of having saved.
    expect(screen.queryByText(/Saved as revision/)).not.toBeInTheDocument();
    await waitFor(() => expect(hasDraft(draftKey('demo', DOC_ID))).toBe(true));
    // The next save builds on the revision the first one made.
    vi.stubGlobal('fetch', answer);
    pressSave(area);
    await waitFor(() => expect(server.matching(WRITE, 'POST')).toHaveLength(2));
    expect(server.last(WRITE, 'POST').body).toMatchObject({
      base_revision: 3,
      body: 'Notes on power. More. Later.',
    });
  });

  it('the editor’s Save button still closes it', async () => {
    const user = userEvent.setup();
    openDoc(false, '?tab=edit');
    const area = await editor();
    await user.type(area, ' More.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Markdown' })).not.toBeInTheDocument(),
    );
  });

  it('Ctrl+S does nothing without an identity, but still keeps Save Page shut', async () => {
    openDoc(false, '?tab=edit', null);
    const area = await editor();
    fireEvent.change(area, { target: { value: 'Changed.' } });
    expect(pressSave(area)).toBe(true);
    expect(server.matching(WRITE, 'POST')).toHaveLength(0);
  });

  it('Ctrl+S does not save the editor behind an open dialog', async () => {
    const user = userEvent.setup();
    openDoc(false, '?tab=edit');
    const area = await editor();
    await user.type(area, ' More.');
    await user.click(screen.getByRole('button', { name: 'Rename…' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(pressSave()).toBe(true);
    expect(server.matching(WRITE, 'POST')).toHaveLength(0);
  });

  it('New concept: Ctrl+S creates it and goes on in its editor', async () => {
    const user = userEvent.setup();
    server.on(
      '/tracker/demo/concepts',
      {
        body: {
          project: 'demo',
          slug: 'quiet',
          title: 'Quiet',
          state: 'open',
          approval: 'unapproved',
          links: [],
          doc_id: DOC_ID,
          path: 'concepts/quiet.md',
          created_at: STAMP,
          updated_at: STAMP,
        },
      },
      'POST',
    );
    server.on(/^\/tracker\/demo\/doc\?path=/, { body: doc({ path: 'concepts/quiet.md' }) }, 'GET');
    server.on(/^\/tracker\/demo\/concepts\/quiet$/, { status: 404, body: {} }, 'GET');
    server.on(`/tracker/docs/${DOC_ID}/revisions`, { body: { doc_id: DOC_ID, revisions: [] } });
    mountAt('/projects/:project/docs/new', <NewConceptView />, {
      route: '/projects/demo/docs/new',
    });
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Quiet');
    await user.type(await editor(), 'Hush.');
    pressSave();
    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent(
        '/projects/demo/doc/concepts/quiet.md?tab=edit',
      ),
    );
  });

  it('New concept: Save as draft creates it a draft', async () => {
    const user = userEvent.setup();
    const CONCEPTS = '/tracker/demo/concepts';
    server.on(
      CONCEPTS,
      {
        body: {
          project: 'demo',
          slug: 'quiet',
          title: 'Quiet',
          state: 'open',
          approval: 'unapproved',
          links: [],
          doc_id: DOC_ID,
          path: 'concepts/quiet.md',
          created_at: STAMP,
          updated_at: STAMP,
        },
      },
      'POST',
    );
    server.on(/^\/tracker\/demo\/doc\?path=/, { body: doc({ path: 'concepts/quiet.md' }) }, 'GET');
    server.on(/^\/tracker\/demo\/concepts\/quiet$/, { status: 404, body: {} }, 'GET');
    const page = () =>
      mount(
        <Routes>
          <Route path="/projects/:project/docs/new" element={<NewConceptView />} />
          <Route path="/projects/:project/doc/*" element={<p>opened</p>} />
        </Routes>,
        { route: '/projects/demo/docs/new' },
      );

    page();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Quiet');
    await user.type(await editor(), 'Shh.');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(server.matching(CONCEPTS, 'POST')).toHaveLength(1));
    expect(server.last(CONCEPTS, 'POST').body).toEqual({
      slug: 'quiet',
      title: 'Quiet',
      body: 'Shh.',
      draft: true,
      ...AS_OWNER,
    });
    await screen.findByText('opened');
  });
});
