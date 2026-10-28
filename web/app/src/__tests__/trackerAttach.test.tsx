/**
 * Files on the ticket page (rag-t0053): a paste, a drop or **Attach** in a
 * note field (every `NoteDialog`: Add note, Send back, …) or the body uploads
 * the file and writes its `att:` reference at the cursor; a failure keeps the
 * typed text and says why; a note in the history renders as Markdown, its
 * attached image inline and linked to the whole file, sanitised as the body is.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ItemView } from '../tracker/ItemView';
import type { Attachment, TrackerEvent } from '../tracker/types';
import { mountAt } from './harness';
import { EVENTS, STAMP, TrackerServer, item } from './trackerFixtures';

const ID = 'demo-t0002';
const PATH = `/tracker/items/${ID}`;
const UPLOAD = '/tracker/demo/attachments';

const IMAGE: Attachment = {
  id: 7,
  project: 'demo',
  sha256: `3fa9c2e1b07d${'0'.repeat(52)}`,
  ref: 'att:3fa9c2e1b07d',
  name: 'shot.png',
  media_type: 'image/png',
  size: 48213,
  author_email: 'alice@example.com',
  agent: 'Unknown',
  surface: 'web',
  uploaded_at: STAMP,
};

const LOG: Attachment = {
  ...IMAGE,
  id: 8,
  sha256: `a1b2c3d4e5f6${'0'.repeat(52)}`,
  ref: 'att:a1b2c3d4e5f6',
  name: 'gate.log',
  media_type: 'text/plain',
};

const NOTE_WITH_IMAGE: TrackerEvent = {
  event_id: 3,
  ts: '2026-01-02T05:00:00Z',
  author_email: 'alice@example.com',
  agent: 'Unknown',
  surface: 'web',
  kind: 'status',
  body: 'The light is wrong:\n\n![shot](att:3fa9c2e1b07d)\n\n<script>alert(1)</script><img src=x onerror="alert(2)">',
  fields: { status: 'in_progress' },
};

let server: TrackerServer;

function install(events: TrackerEvent[] = EVENTS) {
  const record = item(ID, {
    title: 'Next up',
    status: 'review',
    body: 'The brief.',
    events,
  });
  server = new TrackerServer();
  server.on(PATH, { body: record }, 'GET');
  server.on(PATH, { body: record }, 'POST');
  server.install();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(options: { identity?: string | null } = {}) {
  return mountAt('/projects/:project/ticket/:id', <ItemView />, {
    route: `/projects/demo/ticket/${ID}`,
    ...options,
  });
}

function png(name = 'shot.png'): File {
  return new File(['png bytes'], name, { type: 'image/png' });
}

async function openDialog(button: string, title: string) {
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Next up' });
  await user.click(screen.getByRole('button', { name: button }));
  return { user, dialog: screen.getByRole('dialog', { name: title }) };
}

describe('attaching to a note', () => {
  it('Send back: a pasted image is uploaded and referenced at the cursor, then sent', async () => {
    install();
    server.on(UPLOAD, { body: IMAGE }, 'POST');
    open();
    const { user, dialog } = await openDialog('Send back', 'Send this ticket back?');
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>('Note (optional)');

    await user.type(note, 'Wrong colour. See ');
    note.setSelectionRange(18, 18);
    fireEvent.paste(note, { clipboardData: { files: [png()], types: ['Files'] } });

    await waitFor(() => expect(note.value).toBe('Wrong colour. See ![shot](att:3fa9c2e1b07d)'));
    expect(server.matching(UPLOAD, 'POST')).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toMatchObject({
      status: 'in_progress',
      note: 'Wrong colour. See ![shot](att:3fa9c2e1b07d)',
    });
  });

  it('Add note: a dropped file that is not an image becomes a link', async () => {
    install();
    server.on(UPLOAD, { body: LOG }, 'POST');
    open();
    const { dialog } = await openDialog('Note', 'Add a note');
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>('Note');

    const file = new File(['log'], 'gate.log', { type: 'text/plain' });
    fireEvent.dragOver(note, { dataTransfer: { files: [file], types: ['Files'] } });
    fireEvent.drop(note, { dataTransfer: { files: [file], types: ['Files'] } });

    await waitFor(() => expect(note.value).toBe('[gate.log](att:a1b2c3d4e5f6)'));
  });

  it('Attach: a chosen file goes in at the cursor', async () => {
    install();
    server.on(UPLOAD, { body: IMAGE }, 'POST');
    open();
    const { user, dialog } = await openDialog('Confirm', 'Confirm this ticket?');
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>('Note (optional)');
    await user.type(note, 'Before after');
    note.setSelectionRange(7, 7);

    expect(within(dialog).getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    const picker = within(dialog).getByTestId('attach-picker');
    fireEvent.change(picker, { target: { files: [png()] } });

    await waitFor(() => expect(note.value).toBe('Before ![shot](att:3fa9c2e1b07d)after'));
  });

  it('a failed upload keeps the typed text and says which file and why', async () => {
    install();
    server.on(UPLOAD, { status: 500, body: { error: 'the disk is full' } }, 'POST');
    open();
    const { user, dialog } = await openDialog('Send back', 'Send this ticket back?');
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>('Note (optional)');
    await user.type(note, 'Still broken');
    fireEvent.paste(note, { clipboardData: { files: [png()], types: ['Files'] } });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'shot.png was not attached: the disk is full',
    );
    expect(note.value).toBe('Still broken');
    // The write was not made for it.
    expect(server.matching(PATH, 'POST')).toHaveLength(0);
  });

  it('refuses a file over 50 MB without uploading it', async () => {
    install();
    server.on(UPLOAD, { body: IMAGE }, 'POST');
    open();
    const { user, dialog } = await openDialog('Note', 'Add a note');
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>('Note');
    await user.type(note, 'Big one');
    const big = png('huge.png');
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 + 1 });
    fireEvent.paste(note, { clipboardData: { files: [big], types: ['Files'] } });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'huge.png was not attached: An attachment may be at most 50 MB.',
    );
    expect(note.value).toBe('Big one');
    expect(server.matching(UPLOAD, 'POST')).toHaveLength(0);
  });

  it('waits for an upload before the write can be sent', async () => {
    install();
    let finish: (value: Response) => void = () => undefined;
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === UPLOAD) {
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return original(input, init);
      }),
    );
    open();
    const { dialog } = await openDialog('Send back', 'Send this ticket back?');
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>('Note (optional)');
    fireEvent.paste(note, { clipboardData: { files: [png()], types: ['Files'] } });

    expect(await within(dialog).findByText('Uploading 1 file…')).toBeInTheDocument();
    expect(note.value).toMatch(/^!\[Uploading shot\.png…\]\(#uploading-\d+\)$/);
    expect(within(dialog).getByRole('button', { name: 'Send back' })).toBeDisabled();

    finish(new Response(JSON.stringify(IMAGE), { status: 200 }));
    await waitFor(() => expect(note.value).toBe('![shot](att:3fa9c2e1b07d)'));
    expect(within(dialog).getByRole('button', { name: 'Send back' })).toBeEnabled();
  });
});

describe('attaching to the body', () => {
  it('Edit: a pasted image goes into the body at the cursor and is saved', async () => {
    install();
    server.on(UPLOAD, { body: IMAGE }, 'POST');
    open();
    const { user, dialog } = await openDialog('Edit…', `Edit ${ID}`);
    const body = within(dialog).getByLabelText<HTMLTextAreaElement>('Body');
    body.setSelectionRange(4, 4);
    fireEvent.paste(body, { clipboardData: { files: [png()], types: ['Files'] } });

    await waitFor(() => expect(body.value).toBe('The ![shot](att:3fa9c2e1b07d)brief.'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toMatchObject({
      body: 'The ![shot](att:3fa9c2e1b07d)brief.',
    });
  });

  it('Edit: a failed upload into the body keeps the body as typed', async () => {
    install();
    server.on(UPLOAD, { status: 413, body: { error: 'too large' } }, 'POST');
    open();
    const { dialog } = await openDialog('Edit…', `Edit ${ID}`);
    const body = within(dialog).getByLabelText<HTMLTextAreaElement>('Body');
    fireEvent.paste(body, { clipboardData: { files: [png()], types: ['Files'] } });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'shot.png was not attached: too large',
    );
    expect(body.value).toBe('The brief.');
  });
});

describe('a note in the history', () => {
  it('renders its attached image inline, linked to the whole file, and sanitised', async () => {
    install([...EVENTS, NOTE_WITH_IMAGE]);
    const { container } = open();
    await screen.findByRole('heading', { name: 'Next up' });

    const image = screen.getByRole('img', { name: 'shot' });
    expect(image).toHaveAttribute('src', '/tracker/attachments/3fa9c2e1b07d');
    const link = image.closest('a');
    expect(link).toHaveAttribute('href', '/tracker/attachments/3fa9c2e1b07d');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // Raw HTML in a note is text, as in the body: no script, no handler.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });
});
