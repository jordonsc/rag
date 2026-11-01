/**
 * Text typed into a dialog and not sent yet, kept in this browser.
 *
 * A click outside a dialog, Esc or its X closes it; none of them is a decision
 * about what was written. So the text stays here, and opening **the same
 * action on the same ticket** brings it back, from whichever page it is opened
 * and after a reload. Only a successful send, or the dialog's own **Cancel**,
 * removes it (owner, 2026-11-01).
 *
 * Guarded as `drafts.ts` is. A browser that refuses site data keeps the text
 * only while the dialog is open: writing still works, and nothing fails.
 */

import { useState } from 'react';

import type { TextUpdate } from './attach';

const PREFIX = 'rag.tracker.kept:';

/** The storage key of one action's text: `parts` name the project, the record and the action. */
export function keptKey(...parts: string[]): string {
  return `${PREFIX}${parts.join(':')}`;
}

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, text: string): void {
  try {
    if (text === '') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, text);
    }
  } catch {
    // Refused or full: the text stays in the open dialog, and goes when it closes.
  }
}

export interface KeptText {
  text: string;
  /** Replace the text. */
  set: (text: string) => void;
  /** Change the text from what it now is: what an attachment's upload does. */
  update: TextUpdate;
}

/**
 * The text kept under `key`, read afresh whenever the key changes. `null` (a
 * dialog that is closed) holds nothing.
 *
 * `update` writes to the key it was made for, whatever is open by then: an
 * upload that finishes after a click away still lands in the text it belongs
 * to, and a send that lands after one still clears its own.
 */
export function useKeptText(key: string | null): KeptText {
  const [kept, setKept] = useState(() => ({ key, text: key === null ? '' : read(key) }));
  let current = kept;
  if (kept.key !== key) {
    current = { key, text: key === null ? '' : read(key) };
    setKept(current);
  }

  const update: TextUpdate = (change) => {
    if (key === null) {
      return;
    }
    setKept((now) => {
      const text = change(now.key === key ? now.text : read(key));
      write(key, text);
      return now.key === key ? { key, text } : now;
    });
  };

  return { text: current.text, set: (text) => update(() => text), update };
}
