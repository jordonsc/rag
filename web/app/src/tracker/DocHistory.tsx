/**
 * A document's history (m04, TC-04): its revisions, newest first, each with
 * its author, agent, surface, time and message; any one's line diff against
 * the one before; its body as it was; and **Restore**, which writes an old body
 * as a new revision after asking for a message (D9). Under the revisions, the
 * activity on the document and its record (state changes, approvals, links,
 * renames), from their events.
 */

import { useEffect, useState } from 'react';
import { Button, ErrorState, Icon, Panel, Spinner, useFormat } from '@rag/ui';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { useIdentity } from '../identity';
import { diffDoc, getDoc, listRevisions, restoreDoc } from './api';
import { NoteDialog } from './dialogs';
import { parseUnified, type DiffRow } from './diff';
import { DocMarkdown, LineDiff } from './docParts';
import styles from './docs.module.css';
import type { DocumentView, Revision, Surface, TrackerEvent } from './types';
import { byteSize, eventKindIcon, eventKindLabel, surfaceLabel } from './vocab';

type Loaded<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: LedgerApiError };

/** Who wrote something: the address, and the agent when it came over MCP. */
export function Who({
  email,
  agent,
  surface,
  self,
}: {
  email: string;
  agent: string;
  surface: Surface;
  self: string | null;
}) {
  const web = surface === 'web';
  const qualifier = web ? (self === email ? 'you, on the web' : 'on the web') : agent;
  return (
    <span className={styles.who} data-surface={surface}>
      <Icon name={web ? 'user' : 'bot'} size={13} />
      {email} · {qualifier}
      <span className={styles.surface}>{surfaceLabel(surface)}</span>
    </span>
  );
}

/** One revision's diff against the one before, fetched when first opened. */
function RevisionDiff({ docId, revision }: { docId: string; revision: number }) {
  const [loaded, setLoaded] = useState<Loaded<DiffRow[]>>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    diffDoc(docId, { to: revision }, controller.signal)
      .then((response) => setLoaded({ kind: 'ready', value: parseUnified(response.diff) }))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [docId, revision]);

  if (loaded.kind === 'loading') {
    return <Spinner size={14} label="Loading the diff" />;
  }
  if (loaded.kind === 'error') {
    return <ErrorState message="Could not load the diff." detail={loaded.error.message} />;
  }
  return loaded.value.length === 0 ? (
    <p className={styles.status}>No change from revision {revision - 1}.</p>
  ) : (
    <LineDiff
      rows={loaded.value}
      addedLabel={`added in revision ${revision}`}
      deletedLabel={`removed in revision ${revision}`}
      label={`Revision ${revision} against revision ${revision - 1}`}
    />
  );
}

/** One revision's body as it was. */
function RevisionBody({ doc, revision }: { doc: DocumentView; revision: number }) {
  const [loaded, setLoaded] = useState<Loaded<string>>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    getDoc(doc.id, { revision, history: false }, controller.signal)
      .then((view) => setLoaded({ kind: 'ready', value: view.body }))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [doc.id, revision]);

  if (loaded.kind === 'loading') {
    return <Spinner size={14} label="Loading the revision" />;
  }
  if (loaded.kind === 'error') {
    return <ErrorState message="Could not load the revision." detail={loaded.error.message} />;
  }
  return (
    <div className={styles.oldBody}>
      <DocMarkdown project={doc.project} path={doc.path} source={loaded.value} />
    </div>
  );
}

export interface DocHistoryProps {
  doc: DocumentView;
  /** The record's events (a concept's, spec's or milestone's), shown with the document's. */
  recordEvents?: readonly TrackerEvent[];
  /** A restore landed: re-read the document. */
  onRestored: () => void;
}

export function DocHistory({ doc, recordEvents = [], onRestored }: DocHistoryProps) {
  const format = useFormat();
  const { email } = useIdentity();
  const [loaded, setLoaded] = useState<Loaded<Revision[]>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<Record<number, 'diff' | 'body' | undefined>>({});
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listRevisions(doc.id, controller.signal)
      .then((response) => setLoaded({ kind: 'ready', value: [...response.revisions].reverse() }))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [doc.id, doc.revision, attempt]);

  const toggle = (revision: number, what: 'diff' | 'body') =>
    setOpen((current) => ({
      ...current,
      [revision]: current[revision] === what ? undefined : what,
    }));

  // A document's `edit` events are its revisions, already listed above.
  const activity = [...doc.events.filter((event) => event.kind !== 'edit'), ...recordEvents].sort(
    (a, b) => (a.ts === b.ts ? a.event_id - b.event_id : a.ts < b.ts ? 1 : -1),
  );

  return (
    <>
      <Panel header={loaded.kind === 'ready' ? `Revisions · ${loaded.value.length}` : 'Revisions'}>
        {loaded.kind === 'loading' && <Spinner size={16} label="Loading the revisions" />}
        {loaded.kind === 'error' && (
          <ErrorState
            message="Could not load the revisions."
            detail={loaded.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {loaded.kind === 'ready' && (
          <ol className={styles.revisions}>
            {loaded.value.map((revision) => {
              const current = revision.revision === doc.revision;
              const shown = open[revision.revision];
              return (
                <li
                  key={revision.revision}
                  className={styles.revision}
                  data-revision={revision.revision}
                >
                  <div className={styles.revisionHead}>
                    <span className={styles.revisionNumber}>
                      Revision {revision.revision}
                      {current && ' (current)'}
                    </span>
                    <span className={styles.revisionMessage}>
                      {revision.message.trim() === '' ? 'No message.' : revision.message}
                    </span>
                  </div>
                  <div className={styles.revisionHead}>
                    <Who
                      email={revision.author_email}
                      agent={revision.agent}
                      surface={revision.surface}
                      self={email}
                    />
                    <time className={styles.status} dateTime={revision.ts}>
                      {format.stamp(revision.ts)}
                    </time>
                    <span className={styles.status}>{byteSize(revision.size)}</span>
                  </div>
                  <div className={styles.revisionActions}>
                    {revision.revision > 1 && (
                      <Button
                        size="sm"
                        variant={shown === 'diff' ? 'accent' : 'default'}
                        onClick={() => toggle(revision.revision, 'diff')}
                        aria-expanded={shown === 'diff'}
                      >
                        <Icon name="git-compare" size={14} />
                        Diff from {revision.revision - 1}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={shown === 'body' ? 'accent' : 'default'}
                      onClick={() => toggle(revision.revision, 'body')}
                      aria-expanded={shown === 'body'}
                    >
                      <Icon name="eye" size={14} />
                      View
                    </Button>
                    {!current && (
                      <Button size="sm" onClick={() => setRestoring(revision.revision)}>
                        <Icon name="rotate-ccw" size={14} />
                        Restore…
                      </Button>
                    )}
                  </div>
                  {shown === 'diff' && <RevisionDiff docId={doc.id} revision={revision.revision} />}
                  {shown === 'body' && <RevisionBody doc={doc} revision={revision.revision} />}
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      {activity.length > 0 && (
        <Panel header={`Activity · ${activity.length}`}>
          <ol className={styles.revisions}>
            {activity.map((event) => (
              <li key={`${event.kind}:${event.event_id}:${event.ts}`} className={styles.revision}>
                <div className={styles.revisionHead}>
                  <Icon name={eventKindIcon(event.kind)} size={14} />
                  <span className={styles.revisionNumber}>{eventKindLabel(event.kind)}</span>
                  <span className={styles.revisionMessage}>{event.body}</span>
                </div>
                <div className={styles.revisionHead}>
                  <Who
                    email={event.author_email}
                    agent={event.agent}
                    surface={event.surface}
                    self={email}
                  />
                  <time className={styles.status} dateTime={event.ts}>
                    {format.stamp(event.ts)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      <NoteDialog
        open={restoring !== null}
        title={`Restore revision ${restoring ?? ''}?`}
        subject={{ id: doc.path, title: doc.title }}
        message={
          <p>
            Its text is written as a new revision, {doc.revision + 1}. Nothing is deleted: the
            revisions since stay in the history.
          </p>
        }
        noteLabel="Message"
        noteHelp={`Why, when it is not obvious. It is the new revision’s message; without one it reads “Restored revision ${restoring ?? ''}.”`}
        confirmLabel="Restore"
        onCancel={() => setRestoring(null)}
        onSubmit={(message, fields) =>
          restoreDoc(
            doc.id,
            {
              revision: restoring!,
              base_revision: doc.revision,
              ...(message === '' ? {} : { message }),
            },
            fields,
          )
        }
        onDone={() => {
          setRestoring(null);
          onRestored();
        }}
      />
    </>
  );
}
