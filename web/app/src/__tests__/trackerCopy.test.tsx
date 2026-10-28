/**
 * Copying the item's id from its page (rag-t0042).
 *
 * Both ways a browser copies: the asynchronous clipboard in a secure context,
 * and, over the LAN's plain http where `navigator.clipboard` does not exist,
 * a hidden textarea and `execCommand('copy')`. Then the fall-back when the
 * clipboard refuses, a browser that refuses both, "Copied" coming and going,
 * and the keyboard.
 */

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { onTestFinished } from 'vitest';

import { COPIED_MS, copyText } from '../tracker/CopyButton';
import { ItemView } from '../tracker/ItemView';
import { mountAt } from './harness';
import { TrackerServer, item } from './trackerFixtures';

const ID = 'demo-t0067';

let writeText: ReturnType<typeof vi.fn>;
let execCommand: ReturnType<typeof vi.fn>;
/** What the textarea held when `execCommand` ran, and whether it was selected. */
let commanded: Array<{ value: string; selected: boolean }>;

/** The browser: secure (with a clipboard) or plain http (without one). */
function browser(secure: boolean, options: { commandWorks?: boolean } = {}) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: secure ? { writeText } : undefined,
  });
  execCommand.mockImplementation(() => {
    const area = document.activeElement;
    if (area instanceof HTMLTextAreaElement) {
      commanded.push({
        value: area.value,
        selected: area.selectionStart === 0 && area.selectionEnd === area.value.length,
      });
    }
    return options.commandWorks ?? true;
  });
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  execCommand = vi.fn();
  commanded = [];
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  const server = new TrackerServer();
  server.on(
    `/tracker/items/${ID}`,
    { body: item(ID, { title: 'Copy me', type: 'design', events: [] }) },
    'GET',
  );
  server.install();
});

afterEach(() => {
  delete (window as { isSecureContext?: unknown }).isSecureContext;
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (document as { execCommand?: unknown }).execCommand;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open() {
  mountAt('/projects/:project/ticket/:id', <ItemView />, { route: `/projects/demo/ticket/${ID}` });
  await screen.findByRole('heading', { name: 'Copy me' });
  return screen.getByRole('button', { name: `Copy ${ID}` });
}

describe('the id’s copy button', () => {
  it('sits right after the id in the top row', async () => {
    const button = await open();
    const id = screen.getByText(ID, { selector: 'code' });
    expect(id.nextElementSibling).toContainElement(button);
  });

  it('copies with the clipboard in a secure context, and says so for a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const button = await open();
    browser(true);
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(execCommand).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPIED_MS + 100);
    });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('copies over plain http, with no clipboard, through a hidden textarea', async () => {
    const user = userEvent.setup();
    const button = await open();
    browser(false);
    await user.click(button);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(commanded).toEqual([{ value: ID, selected: true }]);
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    // The textarea is gone and the button has the focus back.
    expect(document.querySelector('textarea')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('falls back to the textarea when the clipboard refuses', async () => {
    const user = userEvent.setup();
    const button = await open();
    browser(true);
    writeText.mockImplementation(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    await user.click(button);
    expect(writeText).toHaveBeenCalled();
    expect(commanded).toEqual([{ value: ID, selected: true }]);
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  });

  it('says it could not copy when the browser refuses every way', async () => {
    const user = userEvent.setup();
    const button = await open();
    browser(false, { commandWorks: false });
    await user.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('Could not copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('works from the keyboard', async () => {
    const user = userEvent.setup();
    const button = await open();
    browser(false);
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(commanded).toHaveLength(1));
    await user.keyboard(' ');
    await waitFor(() => expect(commanded).toHaveLength(2));
    expect(commanded[1]!.value).toBe(ID);
  });
});

describe('copyText', () => {
  it('copies without a clipboard API at all, and reports a refusal', async () => {
    browser(false);
    await expect(copyText('att:3fa9c2e1b07d')).resolves.toBe(true);
    expect(commanded.at(-1)!.value).toBe('att:3fa9c2e1b07d');
    browser(false, { commandWorks: false });
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('survives a browser with no execCommand', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    delete (document as { execCommand?: unknown }).execCommand;
    await expect(copyText('x')).resolves.toBe(false);
  });
});
