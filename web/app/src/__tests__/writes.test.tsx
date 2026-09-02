/**
 * The four writes.
 *
 * These are the tests worth having, because every failure mode here is silent.
 * A tag set replaced instead of extended, a summary editor added "for
 * convenience", a write followed by a search the index has not caught up with —
 * none of them throws, and all of them destroy or misreport something. Each
 * test below names the mistake it is watching for.
 */

import { join } from 'node:path';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CreateView } from '../views/CreateView';
import { AppendPanel, ArchiveDialog, MoveDialog, TopicActions } from '../writes';
import { AUTHOR, RECORD, Server, TOPIC } from './fixtures';
import { mount } from './harness';
import { matching, read, sourceFiles } from './sources';

let server: Server;

beforeEach(() => {
  server = new Server();
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const eventReply = {
  event_id: 3,
  ts: '2026-02-01T00:00:00Z',
  author_email: AUTHOR,
  author_agent: null,
  kind: 'note',
  body: 'A note.',
  new_state: null,
  new_status: null,
  new_title: null,
  new_tags: null,
};

/** The body of the append that was sent. */
const appended = () => server.last(/\/append$/).body!;

// ---- Append -----------------------------------------------------------------

describe('AppendPanel', () => {
  const open = (options: { identity?: string | null } = {}) => {
    const onWritten = vi.fn();
    mount(<AppendPanel topic={RECORD} onWritten={onWritten} />, options);
    return onWritten;
  };

  const amend = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /Amend the topic/ }));
  };

  it('sends the note, and files the event as a note by default', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    const onWritten = open();

    await user.type(screen.getByLabelText('Note'), 'Checked against the deployed unit.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(server.last(/\/append$/)).toMatchObject({
      path: '/ledger/rag-0009/append',
      method: 'POST',
    });
    expect(appended()).toMatchObject({
      body: 'Checked against the deployed unit.',
      kind: 'note',
      author_email: AUTHOR,
      author_agent: null,
    });
    expect(onWritten).toHaveBeenCalledOnce();
  });

  /**
   * **The shape of the whole feature, not a validation detail.** A status move
   * with no prose is a fact with no reason attached, and the reason is the only
   * thing that cannot be reconstructed later from the topic itself.
   */
  it('refuses to save an amendment with no note', async () => {
    const user = userEvent.setup();
    open();

    await amend(user);
    await user.selectOptions(screen.getByLabelText('Status'), 'resolved');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    expect(screen.getByText('A note is required — say why.')).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a note that is only whitespace', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Note'), '   ');
    await user.click(screen.getByRole('button', { name: 'Append' }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * `set_tags` **replaces** the set. A form that opened with an empty tag box
   * would let a reader add one tag and silently delete the other four, and
   * nothing in the interface would say so — the append would succeed.
   */
  it('pre-populates the topic tags so an edit cannot wipe the set', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    for (const tag of TOPIC.tags) {
      expect(screen.getByText(tag)).toBeInTheDocument();
    }

    await user.type(screen.getByLabelText('Tags'), 'testing{Enter}');
    await user.type(screen.getByLabelText('Note'), 'Added a tag.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    // The whole intended set, not the one that was typed.
    expect(appended().set_tags).toEqual(['web', 'deploy', 'testing']);
  });

  it('sends the remaining tags when one is removed', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    await user.click(screen.getByRole('button', { name: 'Remove deploy' }));
    await user.type(screen.getByLabelText('Note'), 'Dropped a tag.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(appended().set_tags).toEqual(['web']);
  });

  /**
   * The other half of the same rule: an amendment that was not made must not be
   * sent. `set_title` on an unchanged title is harmless; `set_tags` on an
   * unchanged set is not — it would record a tag change on the history for
   * every append anybody ever makes.
   */
  it('omits set_title and set_tags when neither was touched', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    await user.type(screen.getByLabelText('Note'), 'Nothing amended.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(appended()).not.toHaveProperty('set_title');
    expect(appended()).not.toHaveProperty('set_tags');
    expect(appended()).not.toHaveProperty('set_status');
    expect(appended()).not.toHaveProperty('set_state');
  });

  it('omits set_title when the title is retyped identically', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, TOPIC.title);
    await user.type(screen.getByLabelText('Note'), 'No real change.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(appended()).not.toHaveProperty('set_title');
  });

  it('sends the amendments that were made', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    await user.selectOptions(screen.getByLabelText('Status'), 'resolved');
    await user.type(screen.getByLabelText('Current state'), 'Shipped.');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'A better handle');
    await user.type(screen.getByLabelText('Note'), 'Landed.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(appended()).toMatchObject({
      set_status: 'resolved',
      set_state: 'Shipped.',
      set_title: 'A better handle',
      // The kind follows what was amended unless it is overridden by hand.
      kind: 'status_change',
    });
  });

  /**
   * **Trimmed, like the note and the title either side of it.** A `Textarea`
   * collects whatever the reader's newlines left behind, and an untrimmed
   * state is written verbatim into `current_state` — and from there into the
   * text the ledger indexes and a later reader is shown.
   */
  it('trims the state it installs, as it trims everything else', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    await user.type(screen.getByLabelText('Current state'), '  Shipped.  ');
    await user.type(screen.getByLabelText('Note'), 'Landed.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(appended().set_state).toBe('Shipped.');
  });

  /**
   * **A tag typed and not entered is still a tag the reader meant.** Chips
   * commit on Enter or on `+`, so text left in the entry box was previously
   * dropped on submit — silently, and after a write that *succeeded*, which is
   * the worst shape a data loss can take.
   */
  it('commits a tag that was typed but never entered', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await amend(user);
    await user.type(screen.getByLabelText('Note'), 'Adding a tag.');
    await user.type(screen.getByPlaceholderText('Add a tag and press Enter'), 'retrieval');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(server.count(/\/append$/)).toBe(1));
    expect(appended().set_tags).toEqual([...RECORD.tags, 'retrieval']);
  });

  it('refuses a blank title rather than sending one, and reopens the amendments', async () => {
    const user = userEvent.setup();
    open();

    await amend(user);
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Note'), 'Retitling.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    expect(
      screen.getByText('A topic must keep a title. Restore it or leave it alone.'),
    ).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * `supersedes` is the one field that changes a **different** topic — it flips
   * that one to `superseded` and links the pair both ways, and nothing here
   * undoes it. Saying so before the button is pressed is the requirement.
   */
  it('states the consequence of superseding before it is saved', async () => {
    const user = userEvent.setup();
    open();

    await amend(user);
    await user.type(screen.getByLabelText('Supersedes'), 'rag-0003');

    const warning = screen.getByText(/is flipped to/);
    expect(warning).toHaveTextContent('rag-0003');
    expect(warning).toHaveTextContent(/Superseded/);
    expect(warning).toHaveTextContent(/nothing here undoes it/);
  });

  it('refuses a topic superseding itself', async () => {
    const user = userEvent.setup();
    open();

    await amend(user);
    await user.type(screen.getByLabelText('Supersedes'), TOPIC.topic_id);
    await user.type(screen.getByLabelText('Note'), 'Circular.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    expect(screen.getByText('A topic cannot supersede itself.')).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /** No `set_summary` exists on any server path, and no field offers one. */
  it('has no summary editor', async () => {
    const user = userEvent.setup();
    open();
    await amend(user);

    expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/summary/i)).not.toBeInTheDocument();
    // And it says why, where the amendments are.
    expect(screen.getByText(/summary is not amendable/i)).toBeInTheDocument();
  });

  it('re-reads the topic after a write rather than patching what it sent', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    const onWritten = open();

    await user.type(screen.getByLabelText('Note'), 'Saved.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(onWritten).toHaveBeenCalledOnce());
    // The server decides the event id, the timestamp, the resulting status and
    // what `supersedes` did elsewhere. None of it is predictable here.
    expect(server.count(/\/ledger\/search/)).toBe(0);
  });

  it('says the index will lag once a write has landed', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await user.type(screen.getByLabelText('Note'), 'Saved.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    expect(await screen.findByText(/search results catch up/)).toBeInTheDocument();
  });

  it('clears the form after a successful append', async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, eventReply);
    open();

    await user.type(screen.getByLabelText('Note'), 'Saved.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    await waitFor(() => expect(screen.getByLabelText('Note')).toHaveValue(''));
  });

  it("shows the server's own words when a write fails", async () => {
    const user = userEvent.setup();
    server.on(/\/append$/, { error: 'topic rag-0009 was moved to example-0004' }, 400);
    const onWritten = open();

    await user.type(screen.getByLabelText('Note'), 'Saved.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'topic rag-0009 was moved to example-0004',
    );
    expect(onWritten).not.toHaveBeenCalled();
    // The note is still there: a failed save must not eat what was typed.
    expect(screen.getByLabelText('Note')).toHaveValue('Saved.');
  });

  it('keeps the framework text of a 422 on screen as the detail', async () => {
    const user = userEvent.setup();
    const raw = 'Failed to deserialize the JSON body into the target type: missing field `body`';
    server.on(/\/append$/, raw, 422);
    open();

    await user.type(screen.getByLabelText('Note'), 'Saved.');
    await user.click(screen.getByRole('button', { name: 'Append' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('rejected before it reached the ledger');
    expect(alert).toHaveTextContent('missing field `body`');
  });

  // ---- The gate -------------------------------------------------------------

  it('stays visible and enabled with no identity, and prompts instead of writing', async () => {
    const user = userEvent.setup();
    const onWritten = open({ identity: null });

    const button = screen.getByRole('button', { name: 'Set your email' });
    expect(button).toBeEnabled();
    expect(screen.getByText(/Set your email and this will write/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Note'), 'Would be saved.');
    await user.click(button);

    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('says the topic is archived rather than pretending an append restores it', () => {
    mount(<AppendPanel topic={{ ...RECORD, archived: true }} onWritten={vi.fn()} />);
    expect(screen.getByText(/will not put it back in search/)).toBeInTheDocument();
  });
});

// ---- Archive / restore ------------------------------------------------------

describe('ArchiveDialog', () => {
  const open = (archived: boolean, options: { identity?: string | null } = {}) => {
    const onDone = vi.fn();
    mount(
      <ArchiveDialog
        open
        topicId={TOPIC.topic_id}
        title={TOPIC.title}
        archived={archived}
        onCancel={vi.fn()}
        onDone={onDone}
      />,
      options,
    );
    return onDone;
  };

  /** One endpoint, one flag, both directions — not two code paths to keep aligned. */
  it('archives through the flag', async () => {
    const user = userEvent.setup();
    server.on(/\/archive$/, TOPIC);
    const onDone = open(true);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(server.last(/\/archive$/)).toMatchObject({
      path: '/ledger/rag-0009/archive',
      method: 'POST',
      body: { archived: true, author_email: AUTHOR, author_agent: null },
    });
  });

  it('restores through the same endpoint with the flag the other way', async () => {
    const user = userEvent.setup();
    server.on(/\/archive$/, { ...TOPIC, archived: false });
    const onDone = open(false);

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(server.last(/\/archive$/).body).toMatchObject({ archived: false });
  });

  it('names the consequence that is actually surprising', () => {
    open(true);
    const dialog = screen.getByRole('dialog');
    // Not "it is deleted" — nothing is. The surprise is that search stops
    // finding it, so an agent cannot reach it at all.
    expect(dialog).toHaveTextContent(/dropped from the search index/);
    expect(dialog).toHaveTextContent(/reversible/);
    expect(dialog).toHaveTextContent(TOPIC.topic_id);
  });

  it('warns that a restore is not visible in search straight away', () => {
    open(false);
    expect(screen.getByRole('dialog')).toHaveTextContent(/30 seconds to 3 minutes/);
  });

  it('prompts rather than archiving when nobody has said who they are', async () => {
    const user = userEvent.setup();
    const onDone = open(true, { identity: null });

    await user.click(screen.getByRole('button', { name: 'Set your email' }));
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports a failure and does not report success', async () => {
    const user = userEvent.setup();
    server.on(/\/archive$/, { error: 'ledger is read-only' }, 503);
    const onDone = open(true);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ledger is read-only');
    expect(onDone).not.toHaveBeenCalled();
  });
});

// ---- Move -------------------------------------------------------------------

describe('MoveDialog', () => {
  const open = (options: { identity?: string | null } = {}) => {
    const onDone = vi.fn();
    mount(
      <MoveDialog
        open
        topicId={TOPIC.topic_id}
        repo={TOPIC.repo}
        onCancel={vi.fn()}
        onDone={onDone}
      />,
      options,
    );
    return onDone;
  };

  /**
   * The consequence has to be on screen **before** the button is pressed. A
   * topic id is not an internal key: it is the string somebody quoted in a
   * commit message, and moving the topic turns every one of those into a
   * redirect that nobody will update.
   */
  it('states the new-id and retired-id consequence up front', () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/rag-0009/);
    expect(dialog).toHaveTextContent(/retired/);
    expect(dialog).toHaveTextContent(/re-filed under a new id/);
    expect(dialog).toHaveTextContent(/pointer/);
    expect(dialog).toHaveTextContent(/no commit message, comment or chat log .* will be updated/);
    expect(screen.getByRole('button', { name: 'Move and retire the old id' })).toBeInTheDocument();
  });

  it('previews the id the destination will mint as it is typed', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Destination project'), 'example');
    expect(screen.getByRole('dialog')).toHaveTextContent(/example/);
  });

  it('hands back the new id the server minted, not the one it retired', async () => {
    const user = userEvent.setup();
    server.on(/\/move$/, { ...TOPIC, topic_id: 'example-0004', repo: 'example' });
    const onDone = open();

    await user.type(screen.getByLabelText('Destination project'), 'example');
    await user.click(screen.getByRole('button', { name: 'Move and retire the old id' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('example-0004'));
    expect(server.last(/\/move$/).body).toMatchObject({
      repo: 'example',
      author_email: AUTHOR,
      author_agent: null,
    });
  });

  it('refuses a move to the project it is already in', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText('Destination project'), TOPIC.repo);
    await user.click(screen.getByRole('button', { name: 'Move and retire the old id' }));

    expect(screen.getByText(`This topic is already in ${TOPIC.repo}.`)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a move with no destination', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Move and retire the old id' }));
    expect(screen.getByText(/A destination project is required/)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * **The destination is minted into an id, so it is checked the same way the
   * create form checks a project.** A slash is the sharp case and the reason
   * this test exists: `wiki/docs` would mint `wiki/docs-0001`, which
   * `/topic/:id` cannot match because a route parameter never spans a path
   * separator. The topic would be unreachable at its own address, the id it
   * came from would be a pointer to that same unreachable address, and the
   * sequence counter has already moved past the number — so the old id can
   * never be reissued either. Nothing in this viewer recovers from it.
   */
  it.each(['a project', 'wiki/docs', 'wiki?docs'])(
    'refuses %j as a destination, since the id it mints could not be opened',
    async (destination) => {
      const user = userEvent.setup();
      open();
      await user.type(screen.getByLabelText('Destination project'), destination);
      await user.click(screen.getByRole('button', { name: 'Move and retire the old id' }));

      expect(screen.getByText(/Letters, digits, dots, dashes and underscores only/)).toBeVisible();
      // Refused by the dialog's own validation, not merely by the client
      // underneath it: the field is marked invalid, which only the form does.
      expect(screen.getByLabelText('Destination project')).toBeInvalid();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  /**
   * The destination field submits on Enter, and that key is not disabled while
   * the request is in flight — so `busy` has to be checked in the handler and
   * not only reflected in the button. Two moves would mint two ids and retire
   * the topic twice.
   */
  it('sends one move however many times Enter is pressed', async () => {
    const user = userEvent.setup();
    // A request that never settles: the dialog stays busy, which is exactly the
    // window a second Enter fires into.
    const pending = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', pending);
    open();

    await user.type(screen.getByLabelText('Destination project'), 'example');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(pending).toHaveBeenCalledTimes(1);
  });

  it('prompts rather than moving when nobody has said who they are', async () => {
    const user = userEvent.setup();
    const onDone = open({ identity: null });
    await user.type(screen.getByLabelText('Destination project'), 'example');
    await user.click(screen.getByRole('button', { name: 'Set your email' }));

    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

// ---- The two actions on the topic itself ------------------------------------

describe('TopicActions', () => {
  it('keeps both controls live with no identity and prompts on either', async () => {
    const user = userEvent.setup();
    mount(<TopicActions topic={TOPIC} onWritten={vi.fn()} />, { identity: null });

    const move = screen.getByRole('button', { name: 'Move…' });
    const archive = screen.getByRole('button', { name: 'Archive…' });
    expect(move).toBeEnabled();
    expect(archive).toBeEnabled();
    expect(screen.getByText(/Set your email and this will write/)).toBeInTheDocument();

    await user.click(archive);
    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    // And the archive confirmation was *not* opened behind it.
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('offers a restore rather than an archive for an archived topic', () => {
    mount(<TopicActions topic={{ ...TOPIC, archived: true }} onWritten={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Restore…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive…' })).not.toBeInTheDocument();
  });

  it('navigates to the new id after a move instead of re-reading the retired one', async () => {
    const user = userEvent.setup();
    server.on(/\/move$/, { ...TOPIC, topic_id: 'example-0004', repo: 'example' });
    const onWritten = vi.fn();
    mount(<TopicActions topic={TOPIC} onWritten={onWritten} />);

    await user.click(screen.getByRole('button', { name: 'Move…' }));
    await user.type(screen.getByLabelText('Destination project'), 'example');
    await user.click(screen.getByRole('button', { name: 'Move and retire the old id' }));

    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent('/topic/example-0004'),
    );
    // There is nothing left at the old id to re-read.
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('re-reads the topic after an archive, since the reader stays put', async () => {
    const user = userEvent.setup();
    server.on(/\/archive$/, { ...TOPIC, archived: true });
    const onWritten = vi.fn();
    mount(<TopicActions topic={TOPIC} onWritten={onWritten} />);

    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(onWritten).toHaveBeenCalledOnce());
  });
});

// ---- Create -----------------------------------------------------------------

describe('CreateView', () => {
  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    fields: Partial<Record<'Project' | 'Title' | 'Summary' | 'Current state', string>> = {},
  ) => {
    const values = {
      Project: 'rag',
      Title: 'A new decision',
      Summary: 'The question being answered.',
      'Current state': 'Proposed; not yet implemented.',
      ...fields,
    };
    for (const [label, value] of Object.entries(values)) {
      if (value !== '') {
        await user.type(screen.getByLabelText(label), value);
      }
    }
  };

  it('creates and goes straight to the minted id', async () => {
    const user = userEvent.setup();
    server.on('/ledger', { ...TOPIC, topic_id: 'rag-0042' });
    mount(<CreateView />);

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('/topic/rag-0042'));
    expect(server.last('/ledger')).toMatchObject({
      method: 'POST',
      body: {
        type: 'decision',
        repo: 'rag',
        title: 'A new decision',
        summary: 'The question being answered.',
        initial_state: 'Proposed; not yet implemented.',
        creator_email: AUTHOR,
        creator_agent: null,
      },
    });
    // Never a search: the vector index has not seen this topic yet.
    expect(server.count(/\/ledger\/search/)).toBe(0);
  });

  it('trims what it sends, because the project becomes an id', async () => {
    const user = userEvent.setup();
    server.on('/ledger', TOPIC);
    mount(<CreateView />);

    await fill(user, { Project: '  rag  ' });
    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    await waitFor(() => expect(server.count('/ledger')).toBe(1));
    expect(server.last('/ledger').body).toMatchObject({ repo: 'rag' });
  });

  it('refuses a blank project', async () => {
    const user = userEvent.setup();
    mount(<CreateView />);

    await fill(user, { Project: '' });
    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    expect(screen.getByText(/it becomes the first half of the topic id/)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['a project', 'a/project', 'proj?ect'])(
    'refuses %j, which would produce a broken id',
    async (repo) => {
      const user = userEvent.setup();
      mount(<CreateView />);

      await fill(user, { Project: repo });
      await user.click(screen.getByRole('button', { name: 'Create topic' }));

      expect(screen.getByText(/Letters, digits, dots, dashes and underscores only/)).toBeVisible();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  /**
   * The pair that closes the dropped-tag hole from both ends: leaving the box
   * commits the draft, and a submit that never produced a blur commits it too.
   * The second is not hypothetical — a form submitted from the keyboard, or
   * one whose handler runs before the browser dispatches the blur, takes that
   * path.
   */
  it('keeps a tag that was typed but never entered', async () => {
    const user = userEvent.setup();
    server.on('/ledger', TOPIC);
    mount(<CreateView />);

    await fill(user);
    await user.type(screen.getByPlaceholderText('Add a tag and press Enter'), 'retrieval');
    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    await waitFor(() => expect(server.count('/ledger')).toBe(1));
    expect(server.last('/ledger').body).toMatchObject({ tags: ['retrieval'] });
  });

  it('keeps a typed tag even when the submit never produced a blur', async () => {
    const user = userEvent.setup();
    server.on('/ledger', TOPIC);
    const { container } = mount(<CreateView />);

    await fill(user);
    await user.type(screen.getByPlaceholderText('Add a tag and press Enter'), 'retrieval');
    // Submitted at the form, so focus never leaves the chip entry box.
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(server.count('/ledger')).toBe(1));
    expect(server.last('/ledger').body).toMatchObject({ tags: ['retrieval'] });
  });

  it('requires a title, a summary and an opening state', async () => {
    const user = userEvent.setup();
    mount(<CreateView />);

    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    expect(screen.getByText(/it is the framing, and it is fixed/)).toBeInTheDocument();
    expect(screen.getByText(/it opens the history/)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows the id the project will mint before anything is submitted', async () => {
    const user = userEvent.setup();
    mount(<CreateView />);
    await user.type(screen.getByLabelText('Project'), 'rag');
    expect(screen.getByText('rag-0001')).toBeInTheDocument();
  });

  it("offers the store's own default status for the chosen type", async () => {
    const user = userEvent.setup();
    mount(<CreateView />);
    // A decision starts proposed; everything else starts open. Showing the real
    // answer beats a blank default the reader has to submit to discover.
    expect(screen.getByText('Default for a decision: Proposed')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Incident' }));
    expect(screen.getByText('Default for a incident: Open')).toBeInTheDocument();
  });

  it('omits an unchosen status and empty tags rather than guessing', async () => {
    const user = userEvent.setup();
    server.on('/ledger', TOPIC);
    mount(<CreateView />);

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    await waitFor(() => expect(server.count('/ledger')).toBe(1));
    expect(server.last('/ledger').body).not.toHaveProperty('status');
    expect(server.last('/ledger').body).not.toHaveProperty('tags');
  });

  it('prompts rather than creating when nobody has said who they are', async () => {
    const user = userEvent.setup();
    mount(<CreateView />, { identity: null });

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set your email' }));

    expect(screen.getByRole('dialog', { name: 'Who is writing?' })).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports a failure without navigating away from the filled form', async () => {
    const user = userEvent.setup();
    server.on('/ledger', { error: 'repo must not be empty' }, 400);
    mount(<CreateView />);

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create topic' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('repo must not be empty');
    expect(screen.getByTestId('address')).toHaveTextContent('/');
    expect(screen.getByLabelText('Summary')).toHaveValue('The question being answered.');
  });

  /**
   * The summary is written **here and nowhere else**, and the form says so at
   * the point of writing rather than after the fact.
   */
  it('warns that the summary can never be edited', () => {
    mount(<CreateView />);
    expect(screen.getByLabelText('Summary')).toBeInTheDocument();
    expect(screen.getByText(/no way to edit this afterwards/)).toBeInTheDocument();
  });
});

// ---- Rules that hold across every write surface ------------------------------

describe('write surfaces, as a set', () => {
  /**
   * **Nothing is optimistic, and nothing re-searches.** A write lands in SQLite
   * at once but the vector index reconciles over the next 30 s to 3 min, so a
   * search run straight after a write cannot see it — which reads to the person
   * who just wrote it as the write having failed.
   */
  it('never runs a live search from a surface that writes', () => {
    const writers = sourceFiles().filter(
      (path) =>
        !path.endsWith(join('api', 'client.ts')) &&
        /\b(appendEvent|createTopic|moveTopic)\s*\(/.test(read(path)),
    );
    expect(writers.length).toBeGreaterThanOrEqual(3);
    for (const path of writers) {
      expect({ path, hit: /\bsearchLedger\s*\(/.test(read(path)) }).toEqual({ path, hit: false });
    }
  });

  /**
   * No control anywhere edits a summary. `Summary` survives as a **label** in
   * exactly one place — the create form, where a summary is first and only
   * written. A second one appearing is the change this watches for; the field
   * form of `set_summary` is guarded in `client.test.ts`.
   */
  it('has no summary editor anywhere in the application', () => {
    expect(matching(/label="Summary"/)).toEqual([join('views', 'CreateView.tsx')]);
  });

  /** The two shared sentences read the same wherever they appear. */
  it('says the same thing about identity and about index lag everywhere', () => {
    const surfaces = [
      <AppendPanel key="a" topic={RECORD} onWritten={vi.fn()} />,
      <TopicActions key="b" topic={TOPIC} onWritten={vi.fn()} />,
      <ArchiveDialog
        key="c"
        open
        topicId={TOPIC.topic_id}
        title={TOPIC.title}
        archived
        onCancel={vi.fn()}
        onDone={vi.fn()}
      />,
    ];
    for (const surface of surfaces) {
      const { unmount } = mount(surface, { identity: null });
      expect(
        within(document.body).getAllByText(
          'The ledger files every entry under an author. Set your email and this will write.',
        ).length,
      ).toBeGreaterThan(0);
      unmount();
    }
  });
});
