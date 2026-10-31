/**
 * The document editor (m04, TC-03): markdown on the left, the live preview on
 * the right (stacked on a narrow screen).
 *
 * Three promises, all in service of one rule: **nothing a person types is
 * lost.**
 *
 * * **Unsaved text.** Every change is kept in this browser (`drafts.ts`) under the
 *   document and the revision it was written against, and restored on the next
 *   mount, so a reload, a closed tab or a crash costs nothing. Only a
 *   successful save, or the reader's own *Discard*, removes it.
 * * **Stale saves.** Save sends the whole body with its base revision. When
 *   another writer (usually an agent through `tracker_doc_edit`) saved in
 *   between, the server refuses it (409) with the newer document; the editor
 *   keeps the reader's text exactly as it is and shows the newer revision's
 *   difference from it, with **Overwrite** (save the reader's text against the
 *   newer revision) and **Discard mine** (take the newer text, after a
 *   confirm). Nothing is merged silently, here or on the server (D9).
 * * **Images.** A pasted or dropped file, or one chosen with **Attach**, is
 *   uploaded as an attachment and its `att:` reference written in at the
 *   cursor; a placeholder holds the place while it uploads, and Save waits for
 *   it. The machinery is `attach.tsx`'s, shared with the ticket page's bodies
 *   and note fields (rag-t0053).
 *
 * **Ctrl+S** (Cmd+S) saves wherever the focus is on the page (2026-10-30,
 * `saveShortcut.ts`), and does nothing while Save cannot be pressed. **It saves
 * on the spot and the editor stays open** (owner, 2026-10-31): the base moves to
 * the new revision, and what was typed while the save was in flight stays
 * unsaved. The Save button still saves and closes. A create has no revision to
 * stay on, so New concept's `onSaved` hears `stayed` and reopens it in the editor.
 *
 * The browser-kept text is called *unsaved* on screen (2026-10-30): "draft"
 * now means a server record not yet published. The code and storage keys keep
 * their old `draft` names, so nothing kept before is lost.
 */

import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { Button, ConfirmDialog, Field, Icon, Input, useFormat } from '@rag/ui';

import { asApiError, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { cx } from '../util';
import { listRevisions, TrackerApiError, type DocConflict } from './api';
import { AttachButton, AttachFailure, uploadingText, useAttachments } from './attach';
import { changed, diffLines, withContext } from './diff';
import { SAVE_AS_DRAFT, SAVE_AS_DRAFT_HINT } from './dialogs';
import { DocMarkdown, LineDiff } from './docParts';
import styles from './docs.module.css';
import frame from './tracker.module.css';
import { clearDraft, readDraft, writeDraft, type Draft } from './drafts';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { useSaveShortcut } from './saveShortcut';
import type { DocumentView, Revision, TrackerAuthor } from './types';
import { surfaceLabel } from './vocab';

export interface DocEditorProps {
  project: string;
  /** The document's path: the preview resolves relative links from it. */
  path: string;
  /** Where the draft is kept (`drafts.ts`'s `draftKey`). */
  storageKey: string;
  /** The document's current text. */
  initial: string;
  /** The document's current revision: the base of a save (0 before it exists). */
  revision: number;
  /** The document's id, when it exists: a stale save names who saved since. */
  docId?: string;
  /** The save button's words. */
  saveLabel?: string;
  /**
   * Offer **Save as draft** beside Save (2026-10-30): the same write, with
   * `asDraft` true. For a create (New concept); Ctrl+S is still Save.
   */
  offerDraft?: boolean;
  /** Why Save cannot be pressed yet (fields outside the editor), or nothing. */
  blocked?: string;
  /** A save of an unchanged body is refused by the server; a create is not. */
  requireChange?: boolean;
  /** What the message is called: a revision's message, or a create's note. */
  messageLabel?: string;
  /**
   * The write. Resolves when it landed, with the document when there is one
   * to go on editing (Ctrl+S then stays here, against its new revision); a
   * rejection with a 409's `conflict` opens the stale-save view, any other is
   * shown as the server said it.
   */
  onSave: (
    body: string,
    base: number,
    message: string,
    fields: TrackerAuthor,
    asDraft: boolean,
  ) => Promise<DocumentView | void>;
  /**
   * The save landed and the editor is done (the draft is already gone).
   * `stayed`: it was Ctrl+S, so the reader means to go on editing.
   */
  onSaved: (stayed: boolean) => void;
  /** Ctrl+S landed and the editor stays open, on `saved`'s revision. */
  onSavedInPlace?: (saved: DocumentView) => void;
  /** Leave the editor. The draft stays unless the reader discarded it. */
  onClose: () => void;
  /** The reader discarded the draft (before `onClose`): forget anything kept beside it. */
  onDiscard?: () => void;
}

/** Moved to `attach.tsx` (rag-t0053); kept here for the callers that import it from the editor. */
export { attachmentMarkdown } from './attach';

function draftNotice(draft: Draft, revision: number): string {
  const stale = draft.base_revision < revision;
  return stale
    ? `Your unsaved changes were restored. They were written against revision ${draft.base_revision}; the document is now at revision ${revision}, so saving them will show what changed first.`
    : 'Your unsaved changes were restored.';
}

export function DocEditor({
  project,
  path,
  storageKey,
  initial,
  revision,
  docId,
  saveLabel = 'Save',
  offerDraft = false,
  blocked,
  requireChange = true,
  messageLabel = 'Message',
  onSave,
  onSaved,
  onSavedInPlace,
  onClose,
  onDiscard,
}: DocEditorProps) {
  const gate = useTrackerGate();
  const format = useFormat();

  // The draft is read once, at mount: it is what the editor starts from.
  const [restored] = useState<Draft | null>(() => readDraft(storageKey));
  const [body, setBody] = useState(restored?.body ?? initial);
  const [base, setBase] = useState(restored?.base_revision ?? revision);
  const [message, setMessage] = useState(restored?.message ?? '');
  // The text that is safe on the server: unchanged from it is not a draft.
  const [pristine, setPristine] = useState(initial);
  const [notice, setNotice] = useState<string | null>(
    restored === null ? null : draftNotice(restored, revision),
  );
  // The revision Ctrl+S last saved, said until the text moves on from it.
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [conflict, setConflict] = useState<DocConflict | null>(null);
  const [since, setSince] = useState<Revision[] | null>(null);
  const [confirm, setConfirm] = useState<'discard-mine' | 'discard-draft' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const preview = useDeferredValue(body);

  const saved = useRef(false);
  const source = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const attacher = useAttachments(project, (change) => {
    saved.current = false;
    setBody(change);
  });
  const uploads = attacher.uploads;
  const latest = useRef({ body, base, message, pristine });
  latest.current = { body, base, message, pristine };

  // ---- the draft ----------------------------------------------------------

  /** Keep the text in this browser, or forget it when it matches the server's. */
  const persist = useCallback((): boolean => {
    if (saved.current) {
      return true;
    }
    const now = latest.current;
    if (now.body !== now.pristine || now.message.trim() !== '') {
      return writeDraft(storageKey, {
        body: now.body,
        base_revision: now.base,
        message: now.message,
        saved_at: new Date().toISOString(),
      });
    }
    clearDraft(storageKey);
    return true;
  }, [storageKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setStorageFailed(!persist()), 300);
    return () => window.clearTimeout(timer);
  }, [body, base, message, pristine, persist]);

  // A reload, a closed tab or leaving the page keeps the last keystroke too.
  useEffect(() => {
    const flush = () => {
      persist();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [persist]);

  const edit = (next: string) => {
    saved.current = false;
    setBody(next);
  };

  // ---- saving -------------------------------------------------------------

  const save = (against: number, asDraft = false, stay = false) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (busy || uploads > 0 || blocked !== undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    const sentBody = body;
    const sentMessage = message;
    onSave(body, against, message.trim(), gate.fields, asDraft)
      .then((result) => {
        setBusy(false);
        setConflict(null);
        if (stay && result !== undefined && onSavedInPlace !== undefined) {
          // On the spot: the next save builds on this revision. Only what was
          // saved stops being unsaved: typing goes on while a save is in
          // flight, and `persist` keeps that against the new base.
          setBase(result.revision);
          setPristine(sentBody);
          setSavedRevision(result.revision);
          setNotice(null);
          setMessage((now) => (now === sentMessage ? '' : now));
          const now = latest.current;
          if (now.body === sentBody && now.message === sentMessage) {
            clearDraft(storageKey);
          }
          onSavedInPlace(result);
          return;
        }
        saved.current = true;
        clearDraft(storageKey);
        onSaved(stay);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        const failure = asApiError(cause);
        if (failure instanceof TrackerApiError && failure.conflict !== null) {
          setConflict(failure.conflict);
          setSince(null);
          if (docId !== undefined) {
            const from = against;
            listRevisions(docId)
              .then((response) =>
                setSince(response.revisions.filter((revision) => revision.revision > from)),
              )
              .catch(() => setSince(null));
          }
          return;
        }
        setError(failure);
      });
  };

  const discardMine = () => {
    if (conflict === null) {
      return;
    }
    saved.current = false;
    setBody(conflict.current.body);
    setPristine(conflict.current.body);
    setBase(conflict.current_revision);
    setMessage('');
    setConflict(null);
    setConfirm(null);
    setNotice(`Your text was discarded. This is revision ${conflict.current_revision}.`);
    clearDraft(storageKey);
  };

  const discardDraft = () => {
    saved.current = true;
    clearDraft(storageKey);
    setConfirm(null);
    onDiscard?.();
    onClose();
  };

  // ---- attachments --------------------------------------------------------

  // ---- drawing ------------------------------------------------------------

  const dirty = body !== pristine;
  const unchanged = requireChange && !dirty;
  // Ctrl+S anywhere on the page is the Save button, and does what it does.
  const canSave = gate.ready && !busy && !unchanged && uploads === 0 && blocked === undefined;
  useSaveShortcut(true, canSave ? () => save(base, false, true) : null, root);
  const conflictRows = conflict === null ? [] : withContext(diffLines(conflict.current.body, body));
  const conflictDiffers = conflict !== null && changed(diffLines(conflict.current.body, body));

  return (
    <div className={styles.editor} ref={root}>
      {notice !== null && (
        <p className={frame.notice} role="status">
          <Icon name="info" size={14} />
          <span>{notice}</span>
          {restored !== null && dirty && (
            <Button size="sm" variant="ghost" onClick={() => setConfirm('discard-draft')}>
              Discard unsaved changes
            </Button>
          )}
        </p>
      )}

      {conflict !== null && (
        <section className={styles.conflict} aria-label="Stale save">
          <h2 className={styles.conflictTitle}>
            <Icon name="triangle-alert" size={16} />
            Not saved: the document changed while you were editing
          </h2>
          <p>
            You were editing revision {base}; it is now at revision {conflict.current_revision}.
            Your text is unchanged below. Overwrite saves it as it is over the newer revision;
            Discard mine replaces it with the newer text.
          </p>
          {since !== null && since.length > 0 && (
            <ul className={styles.conflictWho}>
              {since.map((revision) => (
                <li key={revision.revision}>
                  Revision {revision.revision}: {revision.author_email}
                  {revision.surface === 'mcp' ? ` · ${revision.agent}` : ' · on the web'} (
                  {surfaceLabel(revision.surface)}), {format.stamp(revision.ts)}
                  {revision.message.trim() !== '' && <> — {revision.message}</>}
                </li>
              ))}
            </ul>
          )}
          {conflictDiffers ? (
            <LineDiff
              rows={conflictRows}
              addedLabel="only in your text"
              deletedLabel={`only in revision ${conflict.current_revision}`}
              label={`Revision ${conflict.current_revision} against your text`}
            />
          ) : (
            <p>Your text is the same as revision {conflict.current_revision}.</p>
          )}
          <div className={styles.commitButtons}>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => save(conflict.current_revision)}
            >
              <Icon name="save" size={14} />
              Overwrite
            </Button>
            <Button variant="danger" onClick={() => setConfirm('discard-mine')} disabled={busy}>
              Discard mine
            </Button>
          </div>
        </section>
      )}

      <div className={styles.panes}>
        <div className={styles.pane}>
          <div className={styles.paneHead}>
            <span>Markdown</span>
            <span className={styles.paneTools}>
              <span>Paste or drop a file to attach it</span>
              <AttachButton attacher={attacher} target={() => source.current} />
            </span>
          </div>
          <textarea
            ref={source}
            className={cx(styles.source, attacher.dropping && styles.sourceDropping)}
            value={body}
            onChange={(event) => edit(event.target.value)}
            {...attacher.handlers}
            aria-label="Markdown"
            spellCheck
          />
        </div>
        <div className={styles.pane}>
          <div className={styles.paneHead}>
            <span>Preview</span>
          </div>
          <div className={styles.preview} aria-label="Preview">
            {preview.trim() === '' ? (
              <p className={styles.status}>Nothing to preview yet.</p>
            ) : (
              <DocMarkdown project={project} path={path} source={preview} />
            )}
          </div>
        </div>
      </div>

      <div className={styles.commit}>
        <div className={styles.commitMessage}>
          <Field label={messageLabel} help="One line: what changed. Optional.">
            <Input value={message} onChange={setMessage} placeholder="What changed" />
          </Field>
        </div>
        <div className={styles.commitButtons}>
          <Button onClick={onClose} disabled={busy}>
            {dirty ? 'Close (keeps your unsaved changes)' : 'Close'}
          </Button>
          {offerDraft && gate.ready && (
            <span title={SAVE_AS_DRAFT_HINT}>
              <Button
                disabled={busy || unchanged || uploads > 0 || blocked !== undefined}
                onClick={() => save(base, true)}
              >
                <Icon name="eye-off" size={14} />
                {SAVE_AS_DRAFT}
              </Button>
            </span>
          )}
          <Button
            variant="primary"
            loading={busy}
            disabled={unchanged || uploads > 0 || blocked !== undefined}
            onClick={() => save(base)}
          >
            <Icon name="save" size={14} />
            {gate.ready ? saveLabel : 'Set your email'}
          </Button>
        </div>
      </div>
      {savedRevision !== null && !dirty && (
        <p className={styles.status} role="status">
          Saved as revision {savedRevision}.
        </p>
      )}
      {uploads > 0 && (
        <p className={styles.status} role="status">
          {uploadingText(uploads)} Save waits for {uploads === 1 ? 'it' : 'them'}.
        </p>
      )}
      <AttachFailure attacher={attacher} />
      {blocked !== undefined && <p className={styles.status}>{blocked}</p>}
      {storageFailed && (
        <p className={writeStyles.failed} role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>
            This browser would not keep your unsaved changes. Save before leaving the page.
          </span>
        </p>
      )}
      {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
      {error !== null && (
        <p className={writeStyles.failed} role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{error.message}</span>
        </p>
      )}

      <ConfirmDialog
        open={confirm === 'discard-mine'}
        title="Discard your text?"
        message="Your text is replaced by the newer revision and your unsaved changes are deleted. This cannot be undone."
        confirmLabel="Discard mine"
        danger
        onConfirm={discardMine}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard-draft'}
        title="Discard your unsaved changes?"
        message="The unsaved text is deleted and the editor closes. This cannot be undone."
        confirmLabel="Discard changes"
        danger
        onConfirm={discardDraft}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
