/**
 * **Ctrl+S** (and **Cmd+S** on a Mac) saves what is being edited
 * (2026-10-30): the document editor, the ticket's Edit, New concept and the
 * Add ticket, Add gate and Add request dialogs.
 *
 * One window listener serves every form that asks for it, so the shortcut
 * works wherever the focus is, not only in a text box:
 *
 * * **The latest wins.** Each active form is pushed on a stack as it
 *   becomes active; the key goes to the top one alone, so an Edit dialog
 *   opened over a page saves the dialog, never the page beneath it.
 * * **A modal owns the keyboard.** When a modal dialog is open that does not
 *   hold the top form (a rename, a note), nothing is saved: a form behind a
 *   modal is not the one being looked at.
 * * **The browser's Save Page never opens** while any form is registered,
 *   saved or not: a press with nothing to save, a save in flight or no
 *   identity set does nothing at all.
 *
 * With nothing registered the key is left to the browser.
 *
 * What a press does is the form's. The document editor and the ticket's Edit
 * **save on the spot and stay open** (owner, 2026-10-31), where their Save
 * buttons close; New concept creates and reopens in the document's editor. The
 * add dialogs submit and close: staying would invite a second press to file
 * the same ticket twice.
 */

import { useEffect, useRef, type RefObject } from 'react';

interface Entry {
  /** What a press does; `null` while there is nothing it may save. */
  save: () => (() => void) | null;
  /** The form's own element: a modal holding it does not block it. */
  root: RefObject<HTMLElement | null> | undefined;
}

const stack: Entry[] = [];

/** Whether a key event is Ctrl+S or Cmd+S, without Alt or Shift. */
export function isSaveKey(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's'
  );
}

function onKeyDown(event: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (top === undefined || !isSaveKey(event)) {
    return;
  }
  event.preventDefault();
  if (event.repeat) {
    return;
  }
  const modals = document.querySelectorAll('[aria-modal="true"]');
  const modal = modals[modals.length - 1];
  const root = top.root?.current ?? null;
  if (modal !== undefined && (root === null || !modal.contains(root))) {
    return;
  }
  top.save()?.();
}

function push(entry: Entry) {
  if (stack.length === 0) {
    window.addEventListener('keydown', onKeyDown);
  }
  stack.push(entry);
}

function pull(entry: Entry) {
  const at = stack.indexOf(entry);
  if (at >= 0) {
    stack.splice(at, 1);
  }
  if (stack.length === 0) {
    window.removeEventListener('keydown', onKeyDown);
  }
}

/**
 * Save on Ctrl+S while `active`. `save` is `null` when a press must do
 * nothing (nothing changed, a save in flight, no identity set): the key is
 * still taken from the browser. `root` is an element inside the form, needed
 * only for a form drawn in a modal dialog.
 */
export function useSaveShortcut(
  active: boolean,
  save: (() => void) | null,
  root?: RefObject<HTMLElement | null>,
) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const entry: Entry = { save: () => latest.current, root };
    push(entry);
    return () => pull(entry);
  }, [active, root]);
}
