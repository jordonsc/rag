import { useId, useState, type FormEvent } from 'react';
import { Button, Icon, Input } from '@rag/ui';
import { useMatch, useNavigate } from 'react-router';

import { asApiError } from '../api';
import { getDoc } from '../tracker/api';
import { docPath, itemPath, itemProject } from '../tracker/paths';
import { isTopicId, topicPath } from './ids';
import styles from './openTopic.module.css';

/**
 * What the box opens (2026-10-30, owner): a ledger topic (`demo-l0001`, or a
 * legacy `demo-0001`), a tracker ticket (`demo-t0001`) or a tracker document
 * (`demo-d0001`). The three are told apart by the letter after the last dash.
 */
export const OPEN_ID_ERROR =
  'That is not an id. A ledger topic looks like demo-l0001 (older ones: demo-0001), a ticket demo-t0001, a document demo-d0001.';

/**
 * A short id, on a project's pages (owner, 2026-10-31): `t1630` there means
 * `<project>-t1630`, and likewise `d0003` and `l0077`. The digits pad to the
 * four an id is minted with, so `t42` is `-t0042`. Anything else, and anything
 * with no project in hand, comes back as it was typed.
 */
export function expandShortId(value: string, project: string | null): string {
  const short = /^([tdl])([0-9]+)$/i.exec(value);
  if (short === null || project === null) {
    return value;
  }
  return `${project}-${short[1]!.toLowerCase()}${short[2]!.padStart(4, '0')}`;
}

/** The project a document id belongs to: everything before the final `-d`. */
export function docProject(id: string): string | null {
  const match = /^(.+)-d[0-9]{4,}$/.exec(id);
  return match === null ? null : match[1]!;
}

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
 * Open a topic, a ticket or a document by the id an agent quoted.
 *
 * **The journey this whole viewer exists for.** Somebody is handed `demo-0001`
 * in a chat log or a commit message and wants to read it; everything else here
 * — search, the archive listing — is a way of finding an id you were not given.
 * So this is one component used in the shell, where it is reachable from every
 * page, and on the 404 page, where it is the fix for how the reader got there.
 *
 * Three answers, and the malformed one is why this is not just a link:
 *
 * * **A topic id** navigates to `/topic/{id}`, which either renders the
 *   topic or — for an id retired by a move — follows the server's pointer.
 *   **A ticket id** navigates to its ticket page. **A document id** is looked
 *   up first (a document's page is addressed by its path), and a document
 *   that does not exist says so here.
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
  // The box sits in the shell, outside the routes, so it reads the address.
  const project = useMatch('/projects/:project/*')?.params.project ?? null;
  const errorId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = value.trim();
    if (typed === '') {
      setError(null);
      return;
    }
    const trimmed = expandShortId(typed, project);
    setError(null);
    // The typed id is kept rather than cleared: the commonest reason to come
    // back to this box is that the last one was a digit out.
    const ticketProject = itemProject(trimmed);
    if (ticketProject !== null) {
      navigate(itemPath(ticketProject, trimmed));
      return;
    }
    if (docProject(trimmed) !== null) {
      setLooking(true);
      getDoc(trimmed, { history: false })
        .then((doc) => navigate(docPath(doc.project, doc.path)))
        .catch((cause: unknown) => {
          const e = asApiError(cause);
          setError(e.status === 404 ? `There is no document ${trimmed}.` : e.message);
        })
        .finally(() => setLooking(false));
      return;
    }
    if (!isTopicId(trimmed)) {
      setError(OPEN_ID_ERROR);
      return;
    }
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
          placeholder={project === null ? 'demo-l0001 · -t0001 · -d0001' : 't0001 · d0001 · l0001'}
          aria-label={label}
          aria-describedby={error === null ? undefined : errorId}
          invalid={error !== null}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </span>
      <Button type="submit" variant="primary" aria-label={actionLabel} disabled={looking}>
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
