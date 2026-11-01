/**
 * Text written into a dialog survives closing it without a decision (owner,
 * 2026-11-01): a click away, Esc or the X keeps it for the same action on the
 * same record; Cancel and a successful send remove it.
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ItemView } from '../tracker/ItemView';
import { keptKey, useKeptText } from '../tracker/keptText';
import { mountAt } from './harness';
import { EVENTS, TrackerServer, item } from './trackerFixtures';

const ID = 'demo-t0002';
const PATH = `/tracker/items/${ID}`;

let server: TrackerServer;

function open() {
  const record = item(ID, { title: 'Next up', status: 'review', body: 'The brief.', events: EVENTS });
  server = new TrackerServer();
  server.on(PATH, { body: record }, 'GET');
  server.on(PATH, { body: record }, 'POST');
  server.install();
  return mountAt('/projects/:project/ticket/:id', <ItemView />, {
    route: `/projects/demo/ticket/${ID}`,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEND_BACK = 'Send this ticket back?';

async function writeSendBack(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(await screen.findByRole('button', { name: 'Send back' }));
  const dialog = screen.getByRole('dialog', { name: SEND_BACK });
  await user.type(within(dialog).getByLabelText('Note (optional)'), text);
  return dialog;
}

function noteIn(name: string, label = 'Note (optional)') {
  return within(screen.getByRole('dialog', { name })).getByLabelText(label);
}

describe('text in a dialog that was closed without a decision', () => {
  it('comes back when the same action is opened after Esc', async () => {
    const user = userEvent.setup();
    open();
    const dialog = await writeSendBack(user, 'The header is wrong');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: SEND_BACK })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Send back' }));
    expect(noteIn(SEND_BACK)).toHaveValue('The header is wrong');
  });

  it('comes back after the X, and is not offered to a different action', async () => {
    const user = userEvent.setup();
    open();
    const dialog = await writeSendBack(user, 'Only for sending back');
    await user.click(within(dialog).getByRole('button', { name: 'Close dialogue' }));

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(noteIn('Confirm this ticket?')).toHaveValue('');
  });

  it('is what a later send sends, and a send clears it', async () => {
    const user = userEvent.setup();
    open();
    const dialog = await writeSendBack(user, 'Sent later');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const again = screen.getByRole('dialog', { name: SEND_BACK });
    await user.click(within(again).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(server.matching(PATH, 'POST')).toHaveLength(1));
    expect(server.last(PATH, 'POST').body).toMatchObject({
      status: 'in_progress',
      note: 'Sent later',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: SEND_BACK })).toBeNull());
    expect(window.localStorage.getItem(keptKey('demo', ID, 'Send back'))).toBeNull();
  });

  it('is discarded by Cancel', async () => {
    const user = userEvent.setup();
    open();
    const dialog = await writeSendBack(user, 'Changed my mind');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Send back' }));
    expect(noteIn(SEND_BACK)).toHaveValue('');
    expect(window.localStorage.getItem(keptKey('demo', ID, 'Send back'))).toBeNull();
  });

  it('is read back from the browser, so it outlives the page', async () => {
    const user = userEvent.setup();
    const first = open();
    await writeSendBack(user, 'Survives the page');
    first.unmount();
    expect(window.localStorage.getItem(keptKey('demo', ID, 'Send back'))).toBe('Survives the page');

    // Mounting clears storage, as a fresh browser would: put it back as a
    // reload would find it.
    open();
    window.localStorage.setItem(keptKey('demo', ID, 'Send back'), 'From before the reload');
    await user.click(await screen.findByRole('button', { name: 'Send back' }));
    expect(noteIn(SEND_BACK)).toHaveValue('From before the reload');
  });
});

describe('useKeptText', () => {
  it('lands an upload that finishes after the dialog closed in the text it belongs to', () => {
    window.localStorage.clear();
    const key = keptKey('demo', ID, 'Add note');
    const { result, rerender } = renderHook(({ at }) => useKeptText(at), {
      initialProps: { at: key as string | null },
    });
    act(() => result.current.set('Before ![Uploading a.png…](#uploading-1)'));
    const madeWhileOpen = result.current.update;

    rerender({ at: null });
    expect(result.current.text).toBe('');
    act(() => madeWhileOpen((now) => now.replace('![Uploading a.png…](#uploading-1)', 'done')));

    rerender({ at: key });
    expect(result.current.text).toBe('Before done');
  });

  it('writes nothing while closed, and keeps no key for empty text', () => {
    window.localStorage.clear();
    const key = keptKey('demo', ID, 'Add note');
    const { result } = renderHook(() => useKeptText(key));
    act(() => result.current.set('Some'));
    expect(window.localStorage.getItem(key)).toBe('Some');
    act(() => result.current.set(''));
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('still holds the text while open when the browser refuses storage', () => {
    window.localStorage.clear();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => useKeptText(keptKey('demo', ID, 'Add note')));
    act(() => result.current.set('Typed anyway'));
    expect(result.current.text).toBe('Typed anyway');
    spy.mockRestore();
  });
});
