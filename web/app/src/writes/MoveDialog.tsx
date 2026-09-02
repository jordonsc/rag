import { useState } from 'react';
import { ConfirmDialog, Field, Icon, Input } from '@rag/ui';

import { asApiError, moveTopic, type LedgerApiError } from '../api';
import { REPO_NAME_ERROR, isRepoName } from '../ledger/ids';
import { IDENTITY_NEEDED, useWriteGate } from './gate';
import styles from './writes.module.css';

export interface MoveDialogProps {
  open: boolean;
  topicId: string;
  /** The project it is in now — the one destination the server refuses. */
  repo: string;
  onCancel: () => void;
  /** The write landed, and the topic has a **new id**. */
  onDone: (newTopicId: string) => void;
}

/**
 * Re-file a topic under another project.
 *
 * **This mints a new id and retires the old one**, and that is why it is a
 * confirmation with the sentence spelled out rather than a project dropdown on
 * the topic header. A topic id is not an internal key: it is the string an
 * agent quoted in a commit message, a chat log or another topic's prose, and
 * moving a topic turns every one of those references into a redirect. The
 * server keeps that redirect — `GET /ledger/{old}` answers with a pointer
 * rather than a 404, and this viewer follows it — so nothing breaks. But
 * nobody's notes are updated, and this is the moment to decide that is
 * acceptable.
 */
export function MoveDialog({ open, topicId, repo, onCancel, onDone }: MoveDialogProps) {
  const gate = useWriteGate();
  const [target, setTarget] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const trimmed = target.trim();
  const targetError =
    trimmed === ''
      ? 'A destination project is required — it becomes the first half of the new id.'
      : !isRepoName(trimmed)
        ? REPO_NAME_ERROR
        : trimmed === repo
          ? `This topic is already in ${repo}.`
          : undefined;

  const confirm = () => {
    setTouched(true);
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    // `busy` is checked here and not only on the button: the destination field
    // submits on Enter, and that key is not disabled while a move is in flight.
    // Two moves would mint two ids and retire the topic twice.
    if (targetError !== undefined || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    moveTopic(topicId, { ...gate.fields, repo: trimmed })
      .then((topic) => {
        setBusy(false);
        setTarget('');
        setTouched(false);
        // The new id is computed by the server from the destination's own
        // sequence. It cannot be guessed here, which is exactly why the caller
        // is handed it rather than told to re-read the id it just retired.
        onDone(topic.topic_id);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <ConfirmDialog
      open={open}
      title="Move this topic to another project?"
      danger
      busy={busy}
      confirmLabel={gate.ready ? 'Move and retire the old id' : 'Set your email'}
      onConfirm={confirm}
      onCancel={() => {
        setError(null);
        setTouched(false);
        onCancel();
      }}
      message={
        <div className={styles.dialogBody}>
          <p>
            <code>{topicId}</code> will be <strong>retired</strong> and its content re-filed under a
            new id — <code>{trimmed === '' ? 'project' : trimmed}</code> plus a fresh number in that
            project. The whole history, the links and the original creation time come with it.
          </p>
          <p>
            The old id keeps working as a <em>pointer</em>: anything asking for it is told where the
            content went. It is not, however, the topic any more, and no commit message, comment or
            chat log that quotes it will be updated.
          </p>
          <Field
            label="Destination project"
            help="The repository name, exactly as it is written elsewhere in the ledger."
            error={touched ? targetError : undefined}
          >
            <Input
              value={target}
              onChange={setTarget}
              placeholder="e.g. rag"
              spellCheck={false}
              invalid={touched && targetError !== undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  confirm();
                }
              }}
            />
          </Field>
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
