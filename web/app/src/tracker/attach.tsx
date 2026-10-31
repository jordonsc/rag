/**
 * Attaching files to text being written (rag-t0053; m04 TC-03 first).
 *
 * One implementation for every text box that takes a file: the documents
 * editor, a ticket's body (Add, Edit, Add request) and every note field (the
 * `NoteDialog` behind Add note, Send back, Confirm, block, defer, ratify…, and
 * the Edit dialog's note). A file **pasted**, **dropped** or chosen with
 * **Attach** is uploaded as a project attachment (`uploadAttachment`, the
 * 50 MB cap included), and its reference is written at the cursor:
 * `![name](att:…)` for an image, `[name](att:…)` for anything else.
 *
 * While it uploads a placeholder holds the cursor's place and the box says how
 * many are in flight, so a caller can hold its write until they land. A
 * failure removes only the placeholder: **the typed text is kept**, and the
 * box says which file was not attached and why. Without an identity nothing
 * uploads, the identity prompt opens, and the box says why.
 *
 * **A drop has room** (owner, 2026-10-31). A `dropZone` takes files on any
 * element around the box, and says so under it, since a file let go just
 * outside a drop target is opened by the browser in place of the page. The box
 * and its bar are always one; Add request's whole form is one too.
 */

import {
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { Button, Icon, Textarea } from '@rag/ui';

import { asApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { cx } from '../util';
import { uploadAttachment } from './api';
import styles from './attach.module.css';
import { useTrackerGate } from './gate';
import type { Attachment } from './types';

/** Why a file was not uploaded: no identity is set. */
export const ATTACH_IDENTITY_NEEDED =
  'Set your email to attach files: the tracker records who uploaded each one.';

/** Characters that would end a markdown link's text early. */
export function linkText(text: string): string {
  return text.replace(/[[\]\n\r]/g, ' ').trim();
}

/** What an uploaded file is written into the text as. */
export function attachmentMarkdown(attachment: Attachment): string {
  const name = linkText(attachment.name) || 'attachment';
  if (attachment.media_type.startsWith('image/')) {
    const alt = name.replace(/\.[A-Za-z0-9]+$/, '') || 'image';
    return `![${alt}](${attachment.ref})`;
  }
  return `[${name}](${attachment.ref})`;
}

/** A change to the caller's text, given the text as it is when it applies. */
export type TextUpdate = (change: (current: string) => string) => void;

/** The event handlers a text box needs to take pasted and dropped files. */
export interface AttachHandlers {
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
}

/** The same, for an element around a text box. */
export interface DropZoneHandlers {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface Attacher {
  /** Uploads in flight: a write waits while this is above 0. */
  uploads: number;
  /** Why the last file was not attached, or nothing. */
  error: string | null;
  /** A file is being dragged over the box. */
  dropping: boolean;
  clearError: () => void;
  /**
   * Upload `files` and write their references into the text at `area`'s
   * selection (replacing it), or at the end when there is no box.
   */
  attach: (files: File[], area: HTMLTextAreaElement | null) => void;
  handlers: AttachHandlers;
  /** Take files dropped anywhere on an element, into the box `target` finds. */
  dropZone: (target: () => HTMLTextAreaElement | null) => DropZoneHandlers;
}

// Placeholders are unique across every box on the page, so two uploads of
// one name never resolve into each other's place.
let placeholders = 0;

/**
 * The upload machinery for one text box. `update` changes the caller's text
 * (a `useState` setter does): it is called once to insert the placeholders and
 * once per file as it lands or fails.
 */
export function useAttachments(project: string, update: TextUpdate): Attacher {
  const gate = useTrackerGate();
  const [uploads, setUploads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const attach = (files: File[], area: HTMLTextAreaElement | null) => {
    if (files.length === 0) {
      return;
    }
    if (gate.fields === null) {
      gate.prompt();
      setError(ATTACH_IDENTITY_NEEDED);
      return;
    }
    const fields = gate.fields;
    const pending = files.map((file) => {
      placeholders += 1;
      return {
        file,
        placeholder: `![Uploading ${linkText(file.name) || 'file'}…](#uploading-${placeholders})`,
      };
    });
    const text = pending.map((upload) => upload.placeholder).join('\n');
    let caret = 0;
    update((current) => {
      const start = area === null ? current.length : Math.min(area.selectionStart, current.length);
      const end = area === null ? current.length : Math.min(area.selectionEnd, current.length);
      caret = start + text.length;
      return current.slice(0, start) + text + current.slice(end);
    });
    if (area !== null) {
      // After React has written the new value: the caret goes after the insert.
      window.setTimeout(() => {
        area.focus();
        area.selectionStart = caret;
        area.selectionEnd = caret;
      }, 0);
    }
    setError(null);
    setUploads((n) => n + pending.length);
    for (const upload of pending) {
      uploadAttachment(project, upload.file, fields)
        .then((attachment) => {
          update((current) => current.replace(upload.placeholder, attachmentMarkdown(attachment)));
        })
        .catch((cause: unknown) => {
          update((current) => current.replace(upload.placeholder, ''));
          setError(
            `${upload.file.name || 'The file'} was not attached: ${asApiError(cause).message}`,
          );
        })
        .finally(() => setUploads((n) => n - 1));
    }
  };

  const handlers: AttachHandlers = {
    onPaste: (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      attach(files, event.currentTarget);
    },
    onDragOver: (event) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault();
        setDropping(true);
      }
    },
    onDragLeave: () => setDropping(false),
    // Dropped files go to the cursor, not to the drop point.
    onDrop: (event) => {
      setDropping(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      attach(files, event.currentTarget);
    },
  };

  const dropZone = (target: () => HTMLTextAreaElement | null): DropZoneHandlers => ({
    onDragOver: (event) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault();
        setDropping(true);
      }
    },
    // Crossing into a child of the zone is not leaving it.
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropping(false);
      }
    },
    onDrop: (event) => {
      setDropping(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      // One upload: a zone inside a zone has the file, the outer one does not.
      event.stopPropagation();
      attach(files, target());
    },
  });

  return { uploads, error, dropping, clearError: () => setError(null), attach, handlers, dropZone };
}

/** "Uploading 2 files…", or nothing. */
export function uploadingText(uploads: number): string | null {
  return uploads > 0 ? `Uploading ${uploads} ${uploads === 1 ? 'file' : 'files'}…` : null;
}

export interface AttachButtonProps {
  attacher: Attacher;
  /** The box the references go into, read when the files are chosen. */
  target: () => HTMLTextAreaElement | null;
}

/** **Attach**: choose files to upload into the box, at its cursor. */
export function AttachButton({ attacher, target }: AttachButtonProps) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => picker.current?.click()}>
        <Icon name="paperclip" size={14} />
        Attach
      </Button>
      <input
        ref={picker}
        className={styles.picker}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden
        data-testid="attach-picker"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          // Cleared, so choosing the same file again is a change again.
          event.currentTarget.value = '';
          attacher.attach(files, target());
        }}
      />
    </>
  );
}

/** Why the last file was not attached, as an alert, or nothing. */
export function AttachFailure({ attacher }: { attacher: Attacher }) {
  if (attacher.error === null) {
    return null;
  }
  return (
    <p className={writeStyles.failed} role="alert">
      <Icon name="triangle-alert" size={14} />
      <span>{attacher.error}</span>
    </p>
  );
}

type NativeTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'className'
>;

export interface AttachTextareaProps extends NativeTextareaProps {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  attacher: Attacher;
}

/**
 * The design system's `Textarea` that takes files: paste into it, drop on it
 * or its bar, or press **Attach** under it. A `Field`'s id and descriptions
 * reach the text box itself, so its label still names it.
 */
export function AttachTextarea({ attacher, ...rest }: AttachTextareaProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const pending = uploadingText(attacher.uploads);
  const box = () => wrap.current?.querySelector('textarea') ?? null;
  return (
    <div
      ref={wrap}
      className={cx(styles.field, attacher.dropping && styles.dropping)}
      {...attacher.dropZone(box)}
    >
      <Textarea {...rest} onPaste={attacher.handlers.onPaste} />
      <div className={styles.bar}>
        <AttachButton attacher={attacher} target={box} />
        <span className={styles.hint}>or paste or drop a file</span>
        {pending !== null && (
          <span className={styles.pending} role="status">
            {pending}
          </span>
        )}
      </div>
      <AttachFailure attacher={attacher} />
    </div>
  );
}
