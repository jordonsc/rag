import { useId, useState, type FormEvent } from 'react';
import { Button, Icon, Input } from '@rag/ui';
import { useNavigate } from 'react-router';

import { TOPIC_ID_ERROR, isTopicId, topicPath } from './ids';
import styles from './openTopic.module.css';

export interface OpenTopicProps {
  /**
   * The field's accessible name.
   *
   * A prop rather than a constant because two of these can be on screen at
   * once — the shell always carries one, and the 404 page offers another right
   * where the reader is looking — and two controls sharing an accessible name
   * is a genuine defect for anyone navigating by name rather than by eye.
   */
  label?: string;
  /** The submit button's accessible name, when "Open" alone would be ambiguous. */
  actionLabel?: string;
  /** The bar-sized presentation: narrower, and the error floats over the page. */
  compact?: boolean;
  autoFocus?: boolean;
}

/**
 * Open a topic by the id an agent quoted.
 *
 * **The journey this whole viewer exists for.** Somebody is handed `demo-0001`
 * in a chat log or a commit message and wants to read it; everything else here
 * — search, the archive listing — is a way of finding an id you were not given.
 * So this is one component used in the shell, where it is reachable from every
 * page, and on the 404 page, where it is the fix for how the reader got there.
 *
 * Three answers, and the malformed one is why this is not just a link:
 *
 * * **An id that parses** navigates to `/topic/{id}`, which either renders the
 *   topic or — for an id retired by a move — follows the server's pointer.
 * * **An id that does not parse** says so here, before a request. A round trip
 *   that could only have returned a 404 tells the reader nothing they could act
 *   on; the shape of an id does.
 * * **A blank box** does nothing at all. Someone who has typed nothing has not
 *   made a mistake, and scolding them for pressing Enter is noise.
 */
export function OpenTopic({
  label = 'Topic id',
  actionLabel,
  compact = false,
  autoFocus = false,
}: OpenTopicProps) {
  const navigate = useNavigate();
  const errorId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      setError(null);
      return;
    }
    if (!isTopicId(trimmed)) {
      setError(TOPIC_ID_ERROR);
      return;
    }
    setError(null);
    // The typed id is kept rather than cleared: the commonest reason to come
    // back to this box is that the last one was a digit out.
    navigate(topicPath(trimmed));
  };

  return (
    <form className={compact ? `${styles.form} ${styles.compact}` : styles.form} onSubmit={submit}>
      <span className={styles.field}>
        <Input
          value={value}
          onChange={(next) => {
            setValue(next);
            // The complaint is about what was submitted, not about what is
            // being typed now.
            if (error !== null) {
              setError(null);
            }
          }}
          placeholder="demo-0001"
          aria-label={label}
          aria-describedby={error === null ? undefined : errorId}
          invalid={error !== null}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </span>
      <Button type="submit" variant="primary" aria-label={actionLabel}>
        Open
      </Button>
      {error !== null && (
        <p className={styles.error} id={errorId} role="alert">
          <Icon name="triangle-alert" size={13} />
          <span>{error}</span>
        </p>
      )}
    </form>
  );
}
