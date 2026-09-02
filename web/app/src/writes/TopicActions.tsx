import { useState } from 'react';
import { Button } from '@rag/ui';
import { useNavigate } from 'react-router';

import type { Topic } from '../api';
import { topicPath } from '../ledger/ids';
import { ArchiveDialog } from './ArchiveDialog';
import { MoveDialog } from './MoveDialog';
import { IDENTITY_NEEDED, useWriteGate } from './gate';
import styles from './writes.module.css';

export interface TopicActionsProps {
  topic: Topic;
  /** Re-read the topic. Used for the write that leaves the reader here. */
  onWritten: () => void;
}

/**
 * The two writes that act on the topic rather than adding to it.
 *
 * Both are confirmations, and neither is a form control on the header, because
 * both do something a reader cannot take back by re-editing a field: one takes
 * the topic out of the search index, the other changes its id. Amending —
 * status, state, title, tags — is not here at all: it belongs to the append
 * form, because every amendment is an event with a rationale.
 *
 * **Neither button is hidden or disabled when nobody has said who they are.**
 * A control that vanishes teaches a reader the application cannot do the thing;
 * a control that is dead teaches them nothing at all. These stay live, say what
 * is missing, and open the identity prompt when pressed.
 */
export function TopicActions({ topic, onWritten }: TopicActionsProps) {
  const navigate = useNavigate();
  const gate = useWriteGate();
  const [archiving, setArchiving] = useState(false);
  const [moving, setMoving] = useState(false);

  const open = (show: (on: boolean) => void) => () => {
    if (!gate.ready) {
      gate.prompt();
      return;
    }
    show(true);
  };

  return (
    <div className={styles.actions}>
      <Button size="sm" variant="accent" onClick={open(setMoving)}>
        Move…
      </Button>
      <Button
        size="sm"
        variant={topic.archived ? 'accent' : 'caution'}
        onClick={open(setArchiving)}
      >
        {topic.archived ? 'Restore…' : 'Archive…'}
      </Button>
      {!gate.ready && <span className={styles.gate}>{IDENTITY_NEEDED}</span>}

      <ArchiveDialog
        open={archiving}
        topicId={topic.topic_id}
        title={topic.title}
        archived={!topic.archived}
        onCancel={() => setArchiving(false)}
        onDone={() => {
          setArchiving(false);
          onWritten();
        }}
      />
      <MoveDialog
        open={moving}
        topicId={topic.topic_id}
        repo={topic.repo}
        onCancel={() => setMoving(false)}
        onDone={(newTopicId) => {
          setMoving(false);
          // The topic this view is showing no longer exists under this id, so
          // there is nothing here to re-read. Go to the id the server minted,
          // carrying the old one so the destination can say what happened.
          navigate(topicPath(newTopicId), {
            replace: true,
            state: { movedFrom: topic.topic_id },
          });
        }}
      />
    </div>
  );
}
