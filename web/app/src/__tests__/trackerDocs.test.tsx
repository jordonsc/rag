/**
 * The documents pages (specs/tracker m04): the documents page, a document
 * (rendered, its record, a rename's redirect), the editor (pasted images, a
 * stale save, drafts), the history (diffs, restore), New concept, and the
 * search view's tracker corpus (TC-07).
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@rag/ui';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { IdentityProvider } from '../identity';
import { DocsView } from '../tracker/DocsView';
import { DocView } from '../tracker/DocView';
import { draftKey, readDraft } from '../tracker/drafts';
import { NewConceptView } from '../tracker/NewConceptView';
import type {
  Attachment,
  Concept,
  DocumentView,
  Revision,
  Spec,
  TrackerEvent,
} from '../tracker/types';
import { SearchView } from '../views/SearchView';
import { AUTHOR, mount, mountAt } from './harness';
import { STAMP, TrackerServer } from './trackerFixtures';

// ---- Fixtures (neutral values: a public repository) -------------------------

const DOC_ID = 'demo-d0002';
const BODY = [
  'Notes on power.',
  '',
  'See [the music](../specs/audio/m03-music.md) and [the spec](specs/audio/master.md).',
  '',
  '![terrain](att:3fa9c2e1b07d)',
].join('\n');

const CREATED: TrackerEvent = {
  event_id: 1,
  ts: STAMP,
  author_email: 'agent@example.com',
  agent: 'Some Model 1',
  surface: 'mcp',
  kind: 'create',
  body: 'Wrote it down.',
  fields: {},
};

function docView(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    id: DOC_ID,
    project: 'demo',
    path: 'concepts/power.md',
    kind: 'concept',
    title: 'Power',
    revision: 2,
    spec: null,
    milestone: null,
    concept: 'power',
    created_at: STAMP,
    updated_at: STAMP,
    body: BODY,
    body_revision: 2,
    redirected_from: null,
    events: [CREATED],
    ...overrides,
  };
}

function concept(slug: string, overrides: Partial<Concept> = {}): Concept {
  return {
    project: 'demo',
    slug,
    title: `Concept ${slug}`,
    state: 'open',
    approval: 'unapproved',
    links: [],
    doc_id: 'demo-d0099',
    path: `concepts/${slug}.md`,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

const CONCEPT = concept('power', {
  title: 'Power',
  approval: 'agent',
  doc_id: DOC_ID,
  links: [{ kind: 'spec', target: 'audio' }],
  events: [],
});

const SPEC: Spec = {
  project: 'demo',
  slug: 'audio',
  title: 'Audio',
  state: 'in_development',
  approval: 'owner',
  doc_id: 'demo-d0005',
  path: 'specs/audio/master.md',
  milestones: [
    {
      project: 'demo',
      spec: 'audio',
      code: 'm01',
      title: 'Sound effects',
      order: 1,
      state: 'done',
      approval: 'owner',
      doc_id: 'demo-d0006',
      path: 'specs/audio/m01-sfx.md',
      created_at: STAMP,
      updated_at: STAMP,
    },
    {
      project: 'demo',
      spec: 'audio',
      code: 'm03',
      title: 'Music',
      order: 3,
      state: 'not_started',
      approval: 'agent',
      doc_id: 'demo-d0007',
      path: 'specs/audio/m03-music.md',
      created_at: STAMP,
      updated_at: STAMP,
    },
  ],
  created_at: STAMP,
  updated_at: STAMP,
};

const REVISIONS: Revision[] = [
  {
    revision: 1,
    author_email: AUTHOR,
    agent: 'Unknown',
    surface: 'web',
    ts: STAMP,
    message: 'First words',
    size: 40,
  },
  {
    revision: 2,
    author_email: 'agent@example.com',
    agent: 'Some Model 1',
    surface: 'mcp',
    ts: '2026-01-02T05:00:00Z',
    message: 'Tightened it',
    size: 120,
  },
];

const ATTACHMENT: Attachment = {
  id: 7,
  project: 'demo',
  sha256: `3fa9c2e1b07d${'0'.repeat(52)}`,
  ref: 'att:3fa9c2e1b07d',
  name: 'image.png',
  media_type: 'image/png',
  size: 48213,
  author_email: AUTHOR,
  agent: 'Unknown',
  surface: 'web',
  uploaded_at: STAMP,
};

const docUrl = (path: string) => `/tracker/demo/doc?path=${encodeURIComponent(path)}`;
const WRITE = `/tracker/docs/${DOC_ID}/write`;
const RESTORE = `/tracker/docs/${DOC_ID}/restore`;
const UPLOAD = '/tracker/demo/attachments';

let server: TrackerServer;

beforeEach(() => {
  server = new TrackerServer();
  server.on('/tracker/projects', { body: { projects: [] } });
  server.on(docUrl('concepts/power.md'), { body: docView() }, 'GET');
  server.on('/tracker/demo/concepts/power', { body: CONCEPT }, 'GET');
  server.on(`/tracker/docs/${DOC_ID}/revisions`, {
    body: { doc_id: DOC_ID, revisions: REVISIONS },
  });
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Address() {
  const location = useLocation();
  return (
    <p data-testid="address">
      {location.pathname}
      {location.search}
    </p>
  );
}

/**
 * The harness's `mount`, without its storage reset: a remount must find the
 * draft the first mount left.
 */
function remount(route: string, pattern: string, element: ReactElement) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[route]}>
        <IdentityProvider>
          <Address />
          <Routes>
            <Route path={pattern} element={element} />
          </Routes>
        </IdentityProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function openDoc(path = 'concepts/power.md', search = '', identity?: string | null) {
  return mountAt('/projects/:project/doc/*', <DocView />, {
    route: `/projects/demo/doc/${path}${search}`,
    ...(identity === undefined ? {} : { identity }),
  });
}

async function editor(): Promise<HTMLTextAreaElement> {
  return (await screen.findByRole('textbox', { name: 'Markdown' })) as HTMLTextAreaElement;
}

// ---- The documents page -----------------------------------------------------

describe('the documents page', () => {
  beforeEach(() => {
    server.on('/tracker/demo/concepts', {
      body: {
        project: 'demo',
        concepts: [
          concept('power', { title: 'Power', approval: 'agent' }),
          concept('storage', { title: 'Storage', state: 'refining' }),
          concept('old-idea', { title: 'Old idea', state: 'archived' }),
        ],
      },
    });
    server.on('/tracker/demo/specs', { body: { project: 'demo', specs: [SPEC] } });
    server.on('/tracker/demo/docs?kind=doc', { body: { project: 'demo', documents: [] } });
  });

  it('lists concepts by state, the archived folded away', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project/docs', <DocsView />, { route: '/projects/demo/docs' });

    const open = await screen.findByRole('region', { name: 'Open' });
    expect(within(open).getByRole('link', { name: 'Power' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/concepts/power.md',
    );
    expect(within(open).getByText('Agent-approved')).toBeInTheDocument();
    const refining = screen.getByRole('region', { name: 'Refining' });
    expect(within(refining).getByRole('link', { name: 'Storage' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Refined' })).getByText('None.'),
    ).toBeVisible();

    // Archived: folded, with its count, until opened.
    expect(screen.queryByRole('link', { name: 'Old idea' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archived · 1' }));
    expect(screen.getByRole('link', { name: 'Old idea' })).toBeInTheDocument();
  });

  it('lists the specs with their milestones, each opening its document', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project/docs', <DocsView />, { route: '/projects/demo/docs' });
    await screen.findByRole('region', { name: 'Open' });

    await user.click(screen.getByRole('tab', { name: 'Specs · 1' }));
    const spec = screen.getByRole('region', { name: 'Audio' });
    expect(within(spec).getByRole('link', { name: 'Audio' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/master.md',
    );
    expect(within(spec).getByText('In development')).toBeInTheDocument();
    const milestones = within(spec).getByRole('list', { name: 'Audio milestones' });
    const rows = within(milestones).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-code'))).toEqual(['m01', 'm03']);
    expect(within(rows[1]!).getByRole('link', { name: 'Music' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/m03-music.md',
    );
    expect(within(rows[1]!).getByText('Not started')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Agent-approved')).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/docs?tab=specs');
  });

  it('New concept opens its page', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project/docs', <DocsView />, { route: '/projects/demo/docs' });
    await user.click(await screen.findByRole('button', { name: 'New concept' }));
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/docs/new');
  });
});

// ---- A document -------------------------------------------------------------

describe('a document', () => {
  it('renders its body with attachments resolved and its record with state and approval', async () => {
    openDoc();
    expect(await screen.findByRole('heading', { name: 'Power', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'terrain' })).toHaveAttribute(
      'src',
      '/tracker/attachments/3fa9c2e1b07d',
    );
    expect(await screen.findByText('Agent-approved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ratify' })).toBeInTheDocument();
  });

  it('opens another document from a relative link and from a root path', async () => {
    const user = userEvent.setup();
    server.on(docUrl('specs/audio/m03-music.md'), {
      body: docView({
        id: 'demo-d0007',
        path: 'specs/audio/m03-music.md',
        kind: 'milestone',
        title: 'Music',
        spec: 'audio',
        milestone: 'm03',
        concept: null,
        body: 'Back to [the spec](master.md).',
      }),
    });
    server.on('/tracker/demo/specs/audio/milestones/m03', { body: SPEC.milestones[1] });
    openDoc();
    await screen.findByRole('heading', { name: 'Power', level: 1 });

    const music = screen.getByRole('link', { name: 'the music' });
    expect(music).toHaveAttribute('href', '/projects/demo/doc/specs/audio/m03-music.md');
    expect(music).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: 'the spec' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/master.md',
    );

    // The record arrives after the body; the link must survive that render.
    await screen.findByText('Agent-approved');
    expect(music).toBeInTheDocument();
    await user.click(music);
    expect(await screen.findByRole('heading', { name: 'Music', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent(
      '/projects/demo/doc/specs/audio/m03-music.md',
    );
    expect(screen.getByRole('link', { name: 'the spec' })).toHaveAttribute(
      'href',
      '/projects/demo/doc/specs/audio/master.md',
    );
  });

  it('follows a rename’s redirect and says so', async () => {
    server.on(docUrl('concepts/old-power.md'), {
      body: docView({ redirected_from: 'concepts/old-power.md' }),
    });
    openDoc('concepts/old-power.md');
    expect(await screen.findByRole('heading', { name: 'Power', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/doc/concepts/power.md');
    expect(screen.getByText('concepts/old-power.md')).toBeInTheDocument();
    expect(screen.getByText(/was renamed: this is its current path/)).toBeInTheDocument();
  });

  it('says plainly when no document has the path', async () => {
    server.on(docUrl('docs/architecture.md'), {
      status: 404,
      body: { error: 'no document at docs/architecture.md' },
    });
    openDoc('docs/architecture.md');
    expect(
      await screen.findByText('There is no document at docs/architecture.md in demo.'),
    ).toBeInTheDocument();
  });

  it('changes a concept’s state with a note, or without one', async () => {
    const user = userEvent.setup();
    server.on('/tracker/demo/concepts/power', { body: CONCEPT }, 'POST');
    openDoc();
    await user.click(await screen.findByRole('button', { name: 'State…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the concept’s state' });
    await user.selectOptions(within(dialog).getByRole('combobox'), 'refining');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Working on it');
    await user.click(within(dialog).getByRole('button', { name: 'Change state' }));
    await waitFor(() =>
      expect(server.matching('/tracker/demo/concepts/power', 'POST')).toHaveLength(1),
    );
    expect(server.last('/tracker/demo/concepts/power', 'POST').body).toEqual({
      state: 'refining',
      note: 'Working on it',
      author_email: AUTHOR,
      surface: 'web',
    });

    // No note: sent without one (D7, amended 2026-10-27).
    await user.click(await screen.findByRole('button', { name: 'State…' }));
    const again = screen.getByRole('dialog', { name: 'Change the concept’s state' });
    await user.selectOptions(within(again).getByRole('combobox'), 'archived');
    await user.click(within(again).getByRole('button', { name: 'Change state' }));
    await waitFor(() =>
      expect(server.matching('/tracker/demo/concepts/power', 'POST')).toHaveLength(2),
    );
    expect(server.last('/tracker/demo/concepts/power', 'POST').body).toEqual({
      state: 'archived',
      author_email: AUTHOR,
      surface: 'web',
    });
  });
});

// ---- The editor -------------------------------------------------------------

describe('the editor', () => {
  it('uploads a pasted image and writes its att: reference at the cursor', async () => {
    server.on(UPLOAD, { body: ATTACHMENT }, 'POST');
    openDoc('concepts/power.md', '?tab=edit');
    const area = await editor();
    expect(area.value).toBe(BODY);

    area.focus();
    area.setSelectionRange(8, 8);
    const file = new File(['png bytes'], 'image.png', { type: 'image/png' });
    fireEvent.paste(area, { clipboardData: { files: [file], types: ['Files'] } });

    await waitFor(() =>
      expect(area.value).toBe(`${BODY.slice(0, 8)}![image](att:3fa9c2e1b07d)${BODY.slice(8)}`),
    );
    expect(server.matching(UPLOAD, 'POST')).toHaveLength(1);
  });

  it('uploads a file chosen with Attach and writes its reference at the cursor', async () => {
    server.on(UPLOAD, { body: ATTACHMENT }, 'POST');
    openDoc('concepts/power.md', '?tab=edit');
    const area = await editor();
    area.setSelectionRange(8, 8);
    const file = new File(['png bytes'], 'image.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('attach-picker'), { target: { files: [file] } });

    await waitFor(() =>
      expect(area.value).toBe(`${BODY.slice(0, 8)}![image](att:3fa9c2e1b07d)${BODY.slice(8)}`),
    );
  });

  it('does not upload a paste of text, or without an identity', async () => {
    server.on(UPLOAD, { body: ATTACHMENT }, 'POST');
    openDoc('concepts/power.md', '?tab=edit', null);
    const area = await editor();
    fireEvent.paste(area, { clipboardData: { files: [], types: ['text/plain'] } });
    const file = new File(['png bytes'], 'image.png', { type: 'image/png' });
    fireEvent.paste(area, { clipboardData: { files: [file], types: ['Files'] } });
    expect(await screen.findByText(/Set your email to attach files/)).toBeInTheDocument();
    expect(server.matching(UPLOAD, 'POST')).toHaveLength(0);
    expect(area.value).toBe(BODY);
  });

  it('saves the whole body with its base revision and message, and clears the draft', async () => {
    const user = userEvent.setup();
    server.on(WRITE, { body: docView({ revision: 3 }) }, 'POST');
    openDoc('concepts/power.md', '?tab=edit');
    const area = await editor();
    await user.type(area, ' more');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Added more');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.matching(WRITE, 'POST')).toHaveLength(1));
    expect(server.last(WRITE, 'POST').body).toEqual({
      base_revision: 2,
      body: `${BODY} more`,
      message: 'Added more',
      author_email: AUTHOR,
      surface: 'web',
    });
    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent(
        /^\/projects\/demo\/doc\/concepts\/power\.md$/,
      ),
    );
    expect(readDraft(draftKey('demo', DOC_ID))).toBeNull();
  });

  it('shows a stale save’s conflict, keeps the user’s text, and overwrites against the new revision', async () => {
    const user = userEvent.setup();
    const theirs = docView({ revision: 3, body: `${BODY}\nAn agent line.`, events: [] });
    server.onceOn(
      WRITE,
      {
        status: 409,
        body: { error: 'base revision 2 is stale', current_revision: 3, current: theirs },
      },
      'POST',
    );
    server.on(WRITE, { body: docView({ revision: 4, body: `${BODY} mine` }) }, 'POST');
    server.onceOn(`/tracker/docs/${DOC_ID}/revisions`, {
      body: {
        doc_id: DOC_ID,
        revisions: [
          ...REVISIONS,
          { ...REVISIONS[1]!, revision: 3, message: 'Agent edit', ts: '2026-01-02T06:00:00Z' },
        ],
      },
    });
    openDoc('concepts/power.md', '?tab=edit');
    const area = await editor();
    await user.type(area, ' mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const conflict = await screen.findByRole('region', { name: 'Stale save' });
    // The user's text is kept, exactly.
    expect(area.value).toBe(`${BODY} mine`);
    const diff = within(conflict).getByRole('list', { name: 'Revision 3 against your text' });
    const deleted = within(diff)
      .getAllByRole('listitem')
      .filter((row) => row.getAttribute('data-kind') === 'del')
      .map((row) => row.textContent);
    const added = within(diff)
      .getAllByRole('listitem')
      .filter((row) => row.getAttribute('data-kind') === 'add')
      .map((row) => row.textContent);
    expect(deleted.some((text) => text?.includes('An agent line.'))).toBe(true);
    expect(added.some((text) => text?.includes('mine'))).toBe(true);
    expect(await within(conflict).findByText(/Agent edit/)).toBeInTheDocument();
    // The draft is still kept, at its old base.
    await waitFor(() => expect(readDraft(draftKey('demo', DOC_ID))?.base_revision).toBe(2));

    await user.click(within(conflict).getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(server.matching(WRITE, 'POST')).toHaveLength(2));
    expect(server.last(WRITE, 'POST').body).toMatchObject({
      base_revision: 3,
      body: `${BODY} mine`,
    });
  });

  it('Discard mine takes the newer text after a confirm', async () => {
    const user = userEvent.setup();
    const theirs = docView({ revision: 3, body: 'Theirs.', events: [] });
    server.on(
      WRITE,
      { status: 409, body: { error: 'stale', current_revision: 3, current: theirs } },
      'POST',
    );
    openDoc('concepts/power.md', '?tab=edit');
    const area = await editor();
    await user.type(area, ' mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Discard mine' }));
    const dialog = screen.getByRole('dialog', { name: 'Discard your text?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard mine' }));
    expect(area.value).toBe('Theirs.');
    expect(screen.queryByRole('region', { name: 'Stale save' })).not.toBeInTheDocument();
  });

  it('restores a draft after a remount, and keeps it when a save fails', async () => {
    const user = userEvent.setup();
    server.on(WRITE, { status: 500, body: { error: 'disk on fire' } }, 'POST');
    const first = openDoc('concepts/power.md', '?tab=edit');
    const area = await editor();
    await user.type(area, ' unsaved');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('disk on fire')).toBeInTheDocument();
    first.unmount();

    const kept = readDraft(draftKey('demo', DOC_ID));
    expect(kept?.body).toBe(`${BODY} unsaved`);
    expect(kept?.base_revision).toBe(2);

    remount(
      '/projects/demo/doc/concepts/power.md?tab=edit',
      '/projects/:project/doc/*',
      <DocView />,
    );
    const again = await editor();
    expect(again.value).toBe(`${BODY} unsaved`);
    expect(screen.getByText('Your unsaved changes were restored.')).toBeInTheDocument();
  });

  it('flags a draft written against an older revision', async () => {
    window.localStorage.setItem(
      draftKey('demo', DOC_ID),
      JSON.stringify({ body: 'old draft', base_revision: 1, message: '', saved_at: STAMP }),
    );
    window.localStorage.setItem('rag.ledger.author_email', AUTHOR);
    remount('/projects/demo/doc/concepts/power.md', '/projects/:project/doc/*', <DocView />);
    expect(await screen.findByRole('tab', { name: 'Edit · unsaved' })).toBeInTheDocument();
    expect(screen.getByText(/You have unsaved changes to this document/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Edit · unsaved' }));
    });
    expect((await editor()).value).toBe('old draft');
    expect(
      screen.getByText(/written against revision 1; the document is now at revision 2/),
    ).toBeInTheDocument();
  });
});

// ---- History ----------------------------------------------------------------

describe('the history', () => {
  it('lists each revision with its author, agent and message, newest first, and shows a diff', async () => {
    const user = userEvent.setup();
    const DIFF = `/tracker/docs/${DOC_ID}/diff?to=2`;
    server.on(DIFF, {
      body: {
        doc_id: DOC_ID,
        from: 1,
        to: 2,
        diff: '--- revision 1\n+++ revision 2\n@@ -1,2 +1,2 @@\n # Power\n-Old line\n+New line\n',
      },
    });
    openDoc('concepts/power.md', '?tab=history');
    await screen.findByText('Tightened it');
    const rows = screen.getAllByRole('listitem').filter((row) => row.hasAttribute('data-revision'));
    expect(rows.map((row) => row.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(within(rows[0]!).getByText('Tightened it')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Some Model 1/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('MCP')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/you, on the web/)).toBeInTheDocument();

    await user.click(within(rows[0]!).getByRole('button', { name: 'Diff from 1' }));
    const diff = await within(rows[0]!).findByRole('list', {
      name: 'Revision 2 against revision 1',
    });
    const kinds = within(diff)
      .getAllByRole('listitem')
      .map((row) => [row.getAttribute('data-kind'), row.textContent?.trim()]);
    expect(kinds).toEqual([
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['same', '# Power'],
      ['del', '−Old line'],
      ['add', '+New line'],
    ]);
  });

  it('restores an old revision with a message, or without one', async () => {
    const user = userEvent.setup();
    server.on(RESTORE, { body: docView({ revision: 3 }) }, 'POST');
    openDoc('concepts/power.md', '?tab=history');
    await screen.findByText('Tightened it');
    const rows = screen.getAllByRole('listitem').filter((row) => row.hasAttribute('data-revision'));
    expect(within(rows[0]!).queryByRole('button', { name: 'Restore…' })).not.toBeInTheDocument();

    await user.click(within(rows[1]!).getByRole('button', { name: 'Restore…' }));
    const dialog = screen.getByRole('dialog', { name: 'Restore revision 1?' });
    await user.type(within(dialog).getByLabelText('Message (optional)'), 'Back to the first words');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(server.matching(RESTORE, 'POST')).toHaveLength(1));
    expect(server.last(RESTORE, 'POST').body).toEqual({
      revision: 1,
      base_revision: 2,
      message: 'Back to the first words',
      author_email: AUTHOR,
      surface: 'web',
    });
  });
});

// ---- New concept ------------------------------------------------------------

describe('New concept', () => {
  it('creates the concept from a title, its slug and the first text, then opens it', async () => {
    const user = userEvent.setup();
    server.on(
      '/tracker/demo/concepts',
      { body: concept('power-generation', { title: 'Power generation' }) },
      'POST',
    );
    server.on(docUrl('concepts/power-generation.md'), {
      body: docView({ path: 'concepts/power-generation.md', title: 'Power generation' }),
    });
    server.on('/tracker/demo/concepts/power-generation', {
      body: concept('power-generation', { events: [] }),
    });
    mount(
      <Routes>
        <Route path="/projects/:project/docs/new" element={<NewConceptView />} />
        <Route path="/projects/:project/doc/*" element={<DocView />} />
      </Routes>,
      { route: '/projects/demo/docs/new' },
    );

    const create = screen.getByRole('button', { name: 'Create concept' });
    expect(create).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Power generation');
    expect(screen.getByRole('textbox', { name: 'Slug' })).toHaveValue('power-generation');
    await user.type(await editor(), 'First musing.');
    await user.click(create);

    await waitFor(() => expect(server.matching('/tracker/demo/concepts', 'POST')).toHaveLength(1));
    expect(server.last('/tracker/demo/concepts', 'POST').body).toEqual({
      slug: 'power-generation',
      title: 'Power generation',
      body: 'First musing.',
      author_email: AUTHOR,
      surface: 'web',
    });
    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent(
        '/projects/demo/doc/concepts/power-generation.md',
      ),
    );
    expect(readDraft(draftKey('demo', 'new-concept'))).toBeNull();
    expect(readDraft(draftKey('demo', 'new-concept:meta'))).toBeNull();
  });

  it('refuses a slug the server would refuse', async () => {
    const user = userEvent.setup();
    mountAt('/projects/:project/docs/new', <NewConceptView />, {
      route: '/projects/demo/docs/new',
    });
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Fine');
    const slug = screen.getByRole('textbox', { name: 'Slug' });
    await user.clear(slug);
    await user.type(slug, 'Not OK');
    expect(screen.getByRole('button', { name: 'Create concept' })).toBeDisabled();
    expect(server.matching('/tracker/demo/concepts', 'POST')).toHaveLength(0);
  });
});

// ---- Search: the tracker corpus (TC-07) -------------------------------------

describe('searching the tracker', () => {
  it('sends corpus tracker, draws document and item hits, and opens one', async () => {
    const user = userEvent.setup();
    server.on(
      '/search',
      {
        body: {
          query: 'power plant',
          top_k: 8,
          reranked: true,
          candidates: 2,
          timings: { embed_ms: 1, search_ms: 1, rerank_ms: 1, total_ms: 3 },
          results: [
            {
              corpus: 'tracker',
              repo: 'demo',
              rel_path: 'concepts/power.md',
              start_line: 1,
              end_line: 4,
              text: 'Power\nA plant of some kind.',
              ann_score: 0.6,
              title: 'Power',
              citation: 'demo:concepts/power.md@r2',
              tracker_id: DOC_ID,
              kind: 'concept',
              revision: 2,
            },
            {
              corpus: 'tracker',
              repo: 'demo',
              rel_path: 'demo-t0004',
              start_line: 0,
              end_line: 0,
              text: 'Build the plant',
              ann_score: 0.5,
              title: 'Build the plant',
              citation: 'demo-t0004',
              tracker_id: 'demo-t0004',
              kind: 'item',
              type: 'dev',
              status: 'pending',
            },
          ],
        },
      },
      'POST',
    );
    mount(<SearchView />, { route: '/?q=power+plant&corpus=tracker&repo=demo' });

    await screen.findByText('2 results in the tracker');
    expect(server.last('/search', 'POST').body).toEqual({
      query: 'power plant',
      filters: { corpus: 'tracker', repo: 'demo' },
    });
    // The ledger's type and status filters do not apply here.
    expect(screen.queryByRole('combobox', { name: 'Topic type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByText('demo:concepts/power.md@r2')).toBeInTheDocument();

    await user.click(screen.getAllByText('Build the plant')[0]!);
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo/ticket/demo-t0004');
  });

  it('offers the corpus as a filter and keeps the ledger as the default', async () => {
    const user = userEvent.setup();
    mount(<SearchView />, { route: '/' });
    const corpus = screen.getByRole('combobox', { name: 'Corpus' });
    expect(corpus).toHaveValue('');
    await user.selectOptions(corpus, 'tracker');
    await user.type(screen.getByRole('searchbox', { name: 'Search the tracker' }), 'power{enter}');
    expect(screen.getByTestId('address')).toHaveTextContent('/?q=power&corpus=tracker');
  });
});
