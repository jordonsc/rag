/**
 * Copying a short reference to the clipboard (rag-t0042): the item page's id,
 * an attachment's `att:` reference.
 *
 * **The UI is served over plain http on the LAN**, where the browser is not a
 * secure context and `navigator.clipboard` is absent. There the copy falls
 * back to the old way: a hidden, read-only textarea holding the text, selected,
 * and `document.execCommand('copy')`. It runs synchronously inside the click,
 * which is what the command needs to be allowed. The asynchronous API is used
 * whenever it is there, and a refusal from it falls back too.
 */

import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@rag/ui';

import styles from './item.module.css';

/** The hidden-textarea copy; `false` when the browser refused it. */
export function copyByCommand(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // On screen (an off-screen element may not be selectable) but unseen, and
  // fixed so selecting it never scrolls the page.
  Object.assign(area.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  });
  const previous = document.activeElement;
  document.body.appendChild(area);
  let copied = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    // The copy took focus to the textarea: give it back to the button, so
    // a keyboard reader is where they were.
    if (previous instanceof HTMLElement) {
      previous.focus();
    }
  }
  return copied;
}

/** Copy text to the clipboard; `false` when the browser refused every way. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (window.isSecureContext && typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Refused (a permission, a focus rule): try the old way.
    }
  }
  return copyByCommand(text);
}

/** How long "Copied" shows. */
export const COPIED_MS = 1500;

/**
 * A copy icon for `text`, with "Copied" beside it for a moment after a press
 * (or why it could not). A button, so Enter and Space work, named
 * `Copy <text>` for a screen reader; the word is a live status.
 */
export function CopyButton({ text }: { text: string }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    void copyText(text).then((ok) => {
      setResult(ok ? 'copied' : 'failed');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setResult(null), COPIED_MS);
    });
  };

  return (
    <span className={styles.copy}>
      <IconButton
        icon={result === 'copied' ? 'check' : 'copy'}
        label={`Copy ${text}`}
        variant="ghost"
        size={14}
        onClick={copy}
      />
      <span className={styles.copied} role="status">
        {result === 'copied' ? 'Copied' : result === 'failed' ? 'Could not copy' : ''}
      </span>
    </span>
  );
}
