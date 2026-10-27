/**
 * Unsaved document drafts, kept in this browser (m04, TC-03).
 *
 * **Nothing a person types into a document may be lost.** A reload, a closed
 * tab or a crash between keystroke and Save leaves the text here, under the
 * document it belongs to, with the revision it was written against; the
 * editor restores it on its next mount, and only a successful save (or the
 * reader's own *Discard*) removes it.
 *
 * Guarded as `identity/storage.ts` guards the email: `localStorage` throws
 * rather than returning `undefined` when a browser refuses site data, and a
 * full quota throws on write. A draft that cannot be kept says so
 * ({@link writeDraft} returns `false`) rather than failing the edit.
 */

const PREFIX = 'rag.tracker.draft:';

export interface Draft {
  /** The text in the editor. */
  body: string;
  /** The revision the text was written against: the save's `base_revision`. */
  base_revision: number;
  /** The save message typed so far. */
  message: string;
  /** When the draft was last written (RFC 3339). */
  saved_at: string;
  /** Fields beside the body (a new concept's title and slug). */
  extra?: Record<string, string>;
}

/** The storage key of a document's draft: one per project and document. */
export function draftKey(project: string, doc: string): string {
  return `${PREFIX}${project}:${doc}`;
}

function valid(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.body === 'string' &&
    typeof draft.base_revision === 'number' &&
    typeof draft.message === 'string' &&
    typeof draft.saved_at === 'string' &&
    (draft.extra === undefined || (typeof draft.extra === 'object' && draft.extra !== null))
  );
}

export function readDraft(key: string): Draft | null {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keep a draft. `false` when the browser would not keep it. */
export function writeDraft(key: string, draft: Draft): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage refused: there was nothing kept to clear.
  }
}

/** Whether a draft is kept for this key. */
export function hasDraft(key: string): boolean {
  return readDraft(key) !== null;
}
