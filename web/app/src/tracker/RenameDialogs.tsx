/**
 * Renames and retitles from the documents pages (rag-t0003):
 *
 * * **Rename…** on a document's page: its path and title, with an optional
 *   note (`POST /tracker/docs/{id}/rename`). A new path leaves the old one as
 *   a redirect, so links and bookmarks to it still open the document.
 * * **Edit title…** on the Specs tab, for a spec or a milestone
 *   (`POST /tracker/{project}/specs/{slug}[/milestones/{code}]` with `title`).
 *
 * A spec, milestone or concept has a title of its own, and so does its
 * document; they start equal and the server keeps them apart. Each dialog
 * therefore offers to change the other one too (ticked by default when they
 * still agree), as a second write with its own event in that record's
 * history. When the first write lands and the second is refused, the dialog
 * closes on the first (it happened) and hands back what was not done, for the
 * page to say.
 *
 * Every write is the owner's: `surface: 'web'`, through the identity gate.
 */

import { useState } from 'react';
import { Button, Checkbox, Dialog, Field, Form, Icon, Input } from '@rag/ui';

import { asApiError, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { getDoc, renameDoc, updateConcept, updateMilestone, updateSpec } from './api';
import { AttachTextarea, useAttachments } from './attach';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { DOC_PATH_RULE, isDocPath } from './paths';
import type { DocRecord } from './RecordPanel';
import type { DocumentView, Milestone, Spec, TrackerAuthor } from './types';

const NOUN: Record<DocRecord['kind'], string> = {
  concept: 'concept',
  spec: 'spec',
  milestone: 'milestone',
};

function recordId(target: DocRecord): string {
  return target.kind === 'milestone'
    ? `${target.record.spec}/${target.record.code}`
    : target.record.slug;
}

/** Set a spec's, milestone's or concept's own title. */
export function retitleRecord(
  target: DocRecord,
  title: string,
  note: string,
  fields: TrackerAuthor,
): Promise<unknown> {
  const body = { title, ...(note === '' ? {} : { note }) };
  switch (target.kind) {
    case 'concept':
      return updateConcept(target.record.project, target.record.slug, body, fields);
    case 'spec':
      return updateSpec(target.record.project, target.record.slug, body, fields);
    case 'milestone':
      return updateMilestone(
        target.record.project,
        target.record.spec,
        target.record.code,
        body,
        fields,
      );
  }
}

function Failure({ error }: { error: LedgerApiError | null }) {
  if (error === null) {
    return null;
  }
  return (
    <p className={writeStyles.failed} role="alert">
      <Icon name="triangle-alert" size={14} />
      <span>{error.message}</span>
    </p>
  );
}

// ---- A document: Rename… ----------------------------------------------------

/** What a rename did: the document as it now is, and anything left undone. */
export interface Renamed {
  /** The document after the rename, or `null` when only its record changed. */
  doc: DocumentView | null;
  /** The second write's refusal, when the first landed. */
  problem: string | null;
}

export interface DocRenameDialogProps {
  doc: DocumentView;
  /** The record the document belongs to, when it has loaded. */
  record: DocRecord | null;
  onCancel: () => void;
  onDone: (renamed: Renamed) => void;
}

/** Rename a document: its path, its title, or both. Mounted only while open. */
export function DocRenameDialog({ doc, record, onCancel, onDone }: DocRenameDialogProps) {
  const gate = useTrackerGate();
  const [path, setPath] = useState(doc.path);
  const [title, setTitle] = useState(doc.title);
  const [alsoRecord, setAlsoRecord] = useState(
    record !== null && record.record.title === doc.title,
  );
  const [note, setNote] = useState('');
  const noteFiles = useAttachments(doc.project, setNote);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const newPath = path.trim();
  const newTitle = title.trim();
  const pathOk = isDocPath(newPath);
  const titleOk = newTitle !== '';
  const pathChanged = newPath !== doc.path;
  const titleChanged = newTitle !== doc.title;
  const recordChange = record !== null && alsoRecord && titleOk && record.record.title !== newTitle;
  const unchanged = !pathChanged && !titleChanged && !recordChange;
  const noun = record === null ? null : NOUN[record.kind];

  const submit = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (busy || noteFiles.uploads > 0 || unchanged || !pathOk || !titleOk) {
      return;
    }
    const fields = gate.fields;
    const message = note.trim();
    setBusy(true);
    setError(null);
    const first: Promise<DocumentView | null> =
      pathChanged || titleChanged
        ? renameDoc(
            doc.id,
            {
              ...(pathChanged ? { path: newPath } : {}),
              ...(titleChanged ? { title: newTitle } : {}),
              ...(message === '' ? {} : { note: message }),
            },
            fields,
          )
        : Promise.resolve(null);
    first
      .then((view) => {
        if (!recordChange || record === null) {
          setBusy(false);
          onDone({ doc: view, problem: null });
          return;
        }
        retitleRecord(record, newTitle, message, fields)
          .then(() => {
            setBusy(false);
            onDone({ doc: view, problem: null });
          })
          .catch((cause: unknown) => {
            setBusy(false);
            if (view === null) {
              setError(asApiError(cause));
              return;
            }
            onDone({
              doc: view,
              problem: `The document was renamed, but the ${NOUN[record.kind]}’s title was not changed: ${asApiError(cause).message}`,
            });
          });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Rename the document"
      width={560}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={unchanged || noteFiles.uploads > 0}
            onClick={submit}
          >
            {gate.ready ? 'Rename' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
          <p className={writeStyles.subject}>
            <code>{doc.id}</code> — {doc.path}
          </p>
          <Field label="Title" error={touched && !titleOk ? 'A title needs some text.' : undefined}>
            <Input value={title} onChange={setTitle} invalid={touched && !titleOk} />
          </Field>
          {record !== null && noun !== null && (
            <Checkbox
              checked={alsoRecord}
              onChange={setAlsoRecord}
              label={`Retitle the ${noun} ${recordId(record)} too`}
            />
          )}
          <Field
            label="Path"
            help={pathChanged ? `${doc.path} will keep opening this document.` : undefined}
            error={touched && !pathOk ? DOC_PATH_RULE : undefined}
          >
            <Input
              value={path}
              onChange={setPath}
              invalid={touched && !pathOk}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field
            label="Note (optional)"
            help="Why, when it is not obvious from the change. It is kept in the document’s history."
          >
            <AttachTextarea
              value={note}
              onChange={setNote}
              attacher={noteFiles}
              rows={2}
              placeholder="Why"
            />
          </Field>
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}

// ---- The Specs tab: Edit title… ---------------------------------------------

export type TitleTarget = { kind: 'spec'; record: Spec } | { kind: 'milestone'; record: Milestone };

export interface TitleDialogProps {
  target: TitleTarget;
  onCancel: () => void;
  /** The title changed; `problem` is the document's retitle refused, if it was. */
  onDone: (problem: string | null) => void;
}

/** A spec's or milestone's title. Mounted only while open. */
export function TitleDialog({ target, onCancel, onDone }: TitleDialogProps) {
  const gate = useTrackerGate();
  const record = target.record;
  const noun = NOUN[target.kind];
  const [title, setTitle] = useState(record.title);
  const [alsoDoc, setAlsoDoc] = useState(true);
  const [note, setNote] = useState('');
  const noteFiles = useAttachments(target.record.project, setNote);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const newTitle = title.trim();
  const titleOk = newTitle !== '';
  const unchanged = newTitle === record.title;

  const submit = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (busy || noteFiles.uploads > 0 || unchanged || !titleOk) {
      return;
    }
    const fields = gate.fields;
    const message = note.trim();
    setBusy(true);
    setError(null);
    retitleRecord(target, newTitle, message, fields)
      .then(() => {
        if (!alsoDoc) {
          setBusy(false);
          onDone(null);
          return;
        }
        // The document's title is read first: a rename that changes nothing
        // is refused, and the document may already carry the new title.
        getDoc(record.doc_id, { history: false })
          .then((doc) =>
            doc.title === newTitle
              ? null
              : renameDoc(
                  record.doc_id,
                  { title: newTitle, ...(message === '' ? {} : { note: message }) },
                  fields,
                ),
          )
          .then(() => {
            setBusy(false);
            onDone(null);
          })
          .catch((cause: unknown) => {
            setBusy(false);
            onDone(
              `The ${noun} was retitled, but its document was not: ${asApiError(cause).message}`,
            );
          });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Edit the ${noun}’s title`}
      width={520}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={unchanged || noteFiles.uploads > 0}
            onClick={submit}
          >
            {gate.ready ? 'Save title' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
          <p className={writeStyles.subject}>
            <code>{recordId(target)}</code> — {record.title}
          </p>
          <Field label="Title" error={touched && !titleOk ? 'A title needs some text.' : undefined}>
            <Input value={title} onChange={setTitle} invalid={touched && !titleOk} />
          </Field>
          <Checkbox
            checked={alsoDoc}
            onChange={setAlsoDoc}
            label={`Retitle its document (${record.path}) too`}
          />
          <Field
            label="Note (optional)"
            help={`Why, when it is not obvious from the change. It is kept in the ${noun}’s history.`}
          >
            <AttachTextarea
              value={note}
              onChange={setNote}
              attacher={noteFiles}
              rows={2}
              placeholder="Why"
            />
          </Field>
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}
