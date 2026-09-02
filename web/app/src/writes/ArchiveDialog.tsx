import { useState } from 'react';
import { ConfirmDialog, Icon } from '@rag/ui';

import { asApiError, setArchived, type LedgerApiError } from '../api';
import { IDENTITY_NEEDED, useWriteGate } from './gate';
import styles from './writes.module.css';

export interface ArchiveDialogProps {
  open: boolean;
  topicId: string;
  /** Shown so the reader can see they are acting on the topic they meant. */
  title: string;
  /** The value being written: `true` archives, `false` restores. */
  archived: boolean;
  onCancel: () => void;
  /** The write landed. The caller re-reads; nothing is patched here. */
  onDone: () => void;
}

/**
 * Archive or restore, with the consequence named.
 *
 * The consequence worth naming is not the deletion — nothing is deleted — it is
 * the **disappearance from search**. An archived topic keeps its id, its history
 * and its readability, and is purged from the vector index, so from that moment
 * the only way to find it is the archived listing or an id somebody already
 * has. A reader who thinks "archive" means "hide from the default view" will
 * archive something an agent then cannot find at all.
 *
 * Both directions run through one component because they are one endpoint with
 * one flag, and splitting them would give two places to get the wording wrong.
 */
export function ArchiveDialog({
  open,
  topicId,
  title,
  archived,
  onCancel,
  onDone,
}: ArchiveDialogProps) {
  const gate = useWriteGate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const confirm = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    // `ConfirmDialog` already puts the button into its loading state, so this
    // is unreachable through the button alone. It is here because all four
    // write surfaces guard on `busy`, and an odd one out is read as a reason
    // rather than as an oversight the next time somebody adds a trigger.
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setArchived(topicId, { ...gate.fields, archived })
      .then(() => {
        setBusy(false);
        onDone();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <ConfirmDialog
      open={open}
      title={archived ? 'Archive this topic?' : 'Restore this topic?'}
      danger={archived}
      busy={busy}
      confirmLabel={gate.ready ? (archived ? 'Archive' : 'Restore') : 'Set your email'}
      onConfirm={confirm}
      onCancel={() => {
        setError(null);
        onCancel();
      }}
      message={
        <div className={styles.dialogBody}>
          <p className={styles.subject}>
            <code>{topicId}</code> — {title}
          </p>
          {archived ? (
            <p>
              It stays in the ledger and stays readable at its own id, and it is{' '}
              <strong>dropped from the search index</strong>: from then on nothing finds it but the
              archived list, or an id somebody already has. The change is recorded in the topic's
              history under your name, and it is reversible from the archived list.
            </p>
          ) : (
            <p>
              It goes back into the search index and out of the archived list. Indexing is not
              instant — it catches up in about 30 seconds to 3 minutes — so a search for it
              immediately afterwards may still come up empty.
            </p>
          )}
          {!gate.ready && <p className={styles.gate}>{IDENTITY_NEEDED}</p>}
          {error !== null && (
            <p className={styles.failed} role="alert">
              <Icon name="triangle-alert" size={14} />
              <span>{error.message}</span>
            </p>
          )}
        </div>
      }
    />
  );
}
