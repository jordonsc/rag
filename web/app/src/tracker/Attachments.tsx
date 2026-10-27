/**
 * A project's attachments (m04, TC-05; D8, R14): newest first, each with its
 * name, size, type, uploader and time, a preview when it is an image, and its
 * `att:` reference to copy into a document. **Upload** adds one without
 * writing it into a document (the editor's paste and drop do both).
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Spinner,
  useFormat,
} from '@rag/ui';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { useIdentity } from '../identity';
import writeStyles from '../writes/writes.module.css';
import { attachmentUrl, listAttachments, uploadAttachment } from './api';
import { Who } from './DocHistory';
import styles from './docs.module.css';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import type { Attachment } from './types';
import { byteSize } from './vocab';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; attachments: Attachment[] }
  | { kind: 'error'; error: LedgerApiError };

/** Copy text to the clipboard; `false` when the browser refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const format = useFormat();
  const { email } = useIdentity();
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const url = attachmentUrl(attachment.sha256);
  const image = attachment.media_type.startsWith('image/');

  const copy = () => {
    void copyText(attachment.ref).then((ok) => setCopied(ok ? 'yes' : 'no'));
  };

  return (
    <li className={styles.attachment} data-ref={attachment.ref}>
      <div className={styles.thumb}>
        {image && url !== null ? (
          <img src={url} alt={attachment.name} loading="lazy" />
        ) : (
          <Icon name="paperclip" size={28} />
        )}
      </div>
      <div className={styles.attachmentBody}>
        {url === null ? (
          <span className={styles.attachmentName}>{attachment.name}</span>
        ) : (
          <a className={styles.attachmentName} href={url} target="_blank" rel="noopener noreferrer">
            {attachment.name}
          </a>
        )}
        <span className={styles.docMeta}>
          {byteSize(attachment.size)} · {attachment.media_type}
        </span>
        <Who
          email={attachment.author_email}
          agent={attachment.agent}
          surface={attachment.surface}
          self={email}
        />
        <time className={styles.docMeta} dateTime={attachment.uploaded_at}>
          {format.stamp(attachment.uploaded_at)}
        </time>
        <span className={styles.ref}>
          <code>{attachment.ref}</code>
          <IconButton
            icon={copied === 'yes' ? 'check' : 'copy'}
            label={`Copy ${attachment.ref}`}
            variant="ghost"
            size={14}
            onClick={copy}
          />
        </span>
        {copied === 'no' && (
          <span className={styles.status} role="status">
            The browser would not copy; select the reference instead.
          </span>
        )}
      </div>
    </li>
  );
}

export function Attachments({ project }: { project: string }) {
  const gate = useTrackerGate();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAttachments(project, controller.signal)
      .then((response) => setLoaded({ kind: 'ready', attachments: response.attachments }))
      .catch((cause: unknown) => {
        if (!isAbort(cause)) {
          setLoaded({ kind: 'error', error: asApiError(cause) });
        }
      });
    return () => controller.abort();
  }, [project, attempt]);

  const choose = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    input.current?.click();
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0 || gate.fields === null) {
      return;
    }
    const fields = gate.fields;
    setBusy(true);
    setError(null);
    Promise.all(files.map((file) => uploadAttachment(project, file, fields)))
      .catch((cause: unknown) => setError(asApiError(cause)))
      .finally(() => {
        setBusy(false);
        setAttempt((n) => n + 1);
      });
  };

  return (
    <div className={styles.tabBody}>
      <div className={styles.toolbar}>
        <p className={styles.toolbarNote}>
          Embed one in a document as <code>![name](att:…)</code>. In the editor, paste or drop a
          file instead.
        </p>
        <Button size="sm" onClick={choose} loading={busy}>
          <Icon name="upload" size={14} />
          Upload
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          className={styles.hiddenInput}
          onChange={upload}
          aria-label="Files to upload"
        />
      </div>
      {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
      {error !== null && (
        <p className={writeStyles.failed} role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{error.message}</span>
        </p>
      )}
      {loaded.kind === 'loading' && <Spinner size={16} label="Loading the attachments" />}
      {loaded.kind === 'error' && (
        <Card>
          <ErrorState
            message="Could not list the attachments."
            detail={loaded.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </Card>
      )}
      {loaded.kind === 'ready' &&
        (loaded.attachments.length === 0 ? (
          <Card>
            <EmptyState icon="image" title="No attachments yet" />
          </Card>
        ) : (
          <ul className={styles.attachments} aria-label="Attachments">
            {loaded.attachments.map((attachment) => (
              <AttachmentCard key={attachment.id} attachment={attachment} />
            ))}
          </ul>
        ))}
    </div>
  );
}
