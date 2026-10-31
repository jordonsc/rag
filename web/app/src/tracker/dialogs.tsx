/**
 * The tracker's write dialogs: one with a note, the owner's approval of an
 * item, the two that add to the queue, Add request (rag-t0044), and Publish
 * and Make draft (2026-10-30).
 *
 * The ledger's write rules hold here unchanged: the identity gate prompts
 * rather than hides (`useTrackerGate`), nothing is optimistic (the caller
 * re-reads once `onDone` fires), and a failure is the server's own sentence.
 */

import { useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  type ChipListHandle,
  Dialog,
  Field,
  Form,
  Icon,
  Input,
  Segmented,
  Toggle,
} from '@rag/ui';

import { asApiError, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { createItem, updateItem } from './api';
import { useSaveShortcut } from './saveShortcut';
import { AttachTextarea, useAttachments } from './attach';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { LabelEditor, submittedLabels, useProjectLabels } from './LabelEditor';
import type { Intensity, Item, TrackerAuthor, WorkType } from './types';
import { INTENSITIES, WORK_TYPES } from './types';
import { approvalLabel, gateTitle, intensityLabel, itemTypeHint, itemTypeLabel } from './vocab';

/** The item a dialog acts on, named at its top so the reader can check it. */
export interface Subject {
  id: string;
  title: string;
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

// ---- A write with a note ----------------------------------------------------

/** A note box's default height, in rows. */
export const NOTE_ROWS = 3;
/** The **Send back** note box: twice the default (owner, rag-t0045). */
export const SEND_BACK_NOTE_ROWS = NOTE_ROWS * 2;

export interface NoteDialogProps {
  open: boolean;
  /**
   * The project a file attached to the note is uploaded to (rag-t0053): the
   * note box takes a paste, a drop or **Attach**, and the write waits for the
   * uploads.
   */
  project: string;
  title: string;
  subject?: Subject;
  /** What the write will do, said before it is pressed. */
  message?: ReactNode;
  /** Extra fields above the note. */
  children?: ReactNode;
  /**
   * Only **Add note** needs one: the note is all it records. Every other
   * write's note is optional (D7, amended by the owner 2026-10-27); without one
   * the server writes the history entry from the change.
   */
  noteRequired?: boolean;
  noteLabel?: string;
  /** What the note is for, under its box. Defaults to the item's history. */
  noteHelp?: string;
  /**
   * The note box's height in rows. Defaults to `NOTE_ROWS`; **Send back**
   * takes twice that (`SEND_BACK_NOTE_ROWS`), as the reason an item goes back
   * is usually longer than other notes (owner, rag-t0045).
   */
  noteRows?: number;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  /** The write itself. Its rejection is shown; its resolution closes. */
  onSubmit: (note: string, fields: TrackerAuthor) => Promise<unknown>;
  /** The write landed. The caller re-reads. */
  onDone: () => void;
}

/**
 * A write that carries a note, optional unless `noteRequired`.
 *
 * An optional note left blank is simply not sent. A required note (Add note)
 * left blank is **not sent** either: the form says so and stays open. The
 * server would refuse it anyway, but a round trip to be told what the form
 * already knew is a worse answer than the form's.
 */
export function NoteDialog({
  open,
  project,
  title,
  subject,
  message,
  children,
  noteRequired = false,
  noteLabel = 'Note',
  noteHelp,
  noteRows = NOTE_ROWS,
  confirmLabel,
  danger = false,
  onCancel,
  onSubmit,
  onDone,
}: NoteDialogProps) {
  const gate = useTrackerGate();
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, setNote);

  const missing = noteRequired && note.trim() === '';

  const close = () => {
    setNote('');
    setTouched(false);
    setError(null);
    attacher.clearError();
    onCancel();
  };

  const submit = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (missing || busy || attacher.uploads > 0) {
      return;
    }
    setBusy(true);
    setError(null);
    onSubmit(note.trim(), gate.fields)
      .then(() => {
        setBusy(false);
        setNote('');
        setTouched(false);
        attacher.clearError();
        onDone();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      width={520}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={attacher.uploads > 0}
            onClick={submit}
          >
            {gate.ready ? confirmLabel : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
          {subject !== undefined && (
            <p className={writeStyles.subject}>
              <code>{subject.id}</code> — {subject.title}
            </p>
          )}
          {message}
          {children}
          <Field
            label={noteRequired ? noteLabel : `${noteLabel} (optional)`}
            help={
              noteHelp ??
              (noteRequired
                ? 'It is kept in the ticket’s history.'
                : 'Why, when it is not obvious from the change. It is kept in the ticket’s history.')
            }
            error={touched && missing ? 'A note needs some text.' : undefined}
          >
            <AttachTextarea
              value={note}
              onChange={setNote}
              attacher={attacher}
              rows={noteRows}
              invalid={touched && missing}
              placeholder={noteRequired ? 'What to record' : 'Why'}
            />
          </Field>
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}

// ---- The owner's approval ---------------------------------------------------

/**
 * The two approvals the web gives (D10): **ratify** an agent's approval
 * (`agent` → `ratified`) or **approve** an unapproved item as the owner
 * (`owner`).
 */
export type ApprovalAction = 'ratify' | 'approve';

export interface ApprovalDialogProps {
  /** Which approval; `null` is closed. */
  action: ApprovalAction | null;
  /** Where a file attached to the note goes. */
  project: string;
  /** The item it approves; its id is what the write names. */
  subject: Subject | null;
  onCancel: () => void;
  /** The write landed. The caller re-reads. */
  onDone: () => void;
}

/**
 * The confirmation before an approval, with an optional note: the item page's
 * **Ratify** and **Approve** buttons and the dashboard's row controls (the
 * *Agent-approved* badge and *Approve*) all open this one.
 */
export function ApprovalDialog({
  action,
  project,
  subject,
  onCancel,
  onDone,
}: ApprovalDialogProps) {
  const ratify = action === 'ratify';
  return (
    <NoteDialog
      open={action !== null && subject !== null}
      project={project}
      title={ratify ? 'Ratify the agent’s approval?' : 'Approve as the owner?'}
      {...(subject === null ? {} : { subject })}
      message={
        ratify ? (
          <p>
            An agent approved this. Ratifying records that you, the owner, confirm it:{' '}
            <strong>{approvalLabel('ratified')}</strong>.
          </p>
        ) : (
          <p>
            Records the owner’s approval: <strong>{approvalLabel('owner')}</strong>. A record, not a
            lock: nothing is refused either way.
          </p>
        )
      }
      confirmLabel={ratify ? 'Ratify' : 'Approve'}
      onCancel={onCancel}
      onSubmit={(note, fields) =>
        updateItem(subject!.id, { approval: ratify ? 'ratified' : 'owner', note }, fields)
      }
      onDone={onDone}
    />
  );
}

// ---- Add an item ------------------------------------------------------------

export interface AddDialogProps {
  open: boolean;
  project: string;
  onCancel: () => void;
  onDone: () => void;
}

const TYPE_OPTIONS = WORK_TYPES.map((type) => ({ value: type, label: itemTypeLabel(type) }));

/**
 * The box under an add dialog's fields. The owner adding work is the owner's
 * approval of it (rag-t0010), so it starts ticked; ticked sends
 * `approval: "owner"`, unticked sends nothing and the item starts unapproved.
 */
const START_APPROVED_LABEL = `Create it ${approvalLabel('owner').toLowerCase()}`;

/** What a create sends for the box: the approval when ticked, nothing when not. */
export function startApproval(approved: boolean): { approval?: 'owner' } {
  return approved ? { approval: 'owner' } : {};
}

/**
 * The parallel box's label (rag-t0013), on Add item and on the item page's
 * Edit: work that may start while a gate above it is still pending.
 */
export const PARALLEL_LABEL = 'Parallel: may start before the gates above it, lands after them';

/**
 * **Save as draft** (2026-10-30), beside each add dialog's own button: the
 * same create with `draft: true`. A draft keeps the place it was added at but
 * sits under Drafts; the feed leaves its changes out and nothing dispatches it
 * until it is published.
 */
export const SAVE_AS_DRAFT = 'Save as draft';
export const SAVE_AS_DRAFT_HINT =
  'Keep it to yourself for now: agents watching the feed are not told, and nothing picks it up until you publish it.';

/** What a create sends for **Save as draft**: `draft: true`, or nothing. */
export function asDraft(draft: boolean): { draft?: true } {
  return draft ? { draft: true } : {};
}

/**
 * **Add item**: type, title, body, whether it starts owner-approved, and
 * whether it is parallel (unticked by default: it may then start before the
 * gates above it clear, rag-t0013); it joins the bottom of the queue, or
 * Drafts with **Save as draft**. Ctrl+S is the main button.
 */
export function AddItemDialog({ open, project, onCancel, onDone }: AddDialogProps) {
  const gate = useTrackerGate();
  const [type, setType] = useState<WorkType>('dev');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [approved, setApproved] = useState(true);
  const [parallel, setParallel] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const [labelProblem, setLabelProblem] = useState<string | undefined>(undefined);
  const labelEntry = useRef<ChipListHandle>(null);
  const vocabulary = useProjectLabels(project, open);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, setBody);
  const root = useRef<HTMLDivElement>(null);

  const reset = () => {
    setType('dev');
    setTitle('');
    setBody('');
    setApproved(true);
    setParallel(false);
    setLabels([]);
    setLabelProblem(undefined);
    setTouched(false);
    setError(null);
    attacher.clearError();
  };

  const close = () => {
    reset();
    onCancel();
  };

  const submit = (draft = false) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (title.trim() === '' || busy || attacher.uploads > 0) {
      return;
    }
    const chosen = submittedLabels(labelEntry.current, labels, vocabulary);
    if ('problem' in chosen) {
      setLabelProblem(chosen.problem);
      return;
    }
    setLabels(chosen.labels);
    setBusy(true);
    setError(null);
    createItem(
      project,
      {
        type,
        title: title.trim(),
        body,
        ...startApproval(approved),
        ...(parallel ? { parallel: true } : {}),
        ...(chosen.labels.length > 0 ? { labels: chosen.labels } : {}),
        ...asDraft(draft),
      },
      gate.fields,
    )
      .then(() => {
        setBusy(false);
        reset();
        onDone();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };
  useSaveShortcut(
    open,
    gate.ready && !busy && attacher.uploads === 0 ? () => submit() : null,
    root,
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a ticket"
      width={600}
      footer={
        <AddFooter
          busy={busy}
          disabled={attacher.uploads > 0}
          ready={gate.ready}
          label="Add to the bottom"
          onCancel={close}
          onSubmit={submit}
        />
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody} ref={root}>
          <Field label="Type" help={itemTypeHint(type)}>
            <Segmented
              value={type}
              onChange={(value) => setType(value as WorkType)}
              options={TYPE_OPTIONS}
              label="Type"
            />
          </Field>
          <Field
            label="Title"
            error={touched && title.trim() === '' ? 'A ticket needs a title.' : undefined}
          >
            <Input value={title} onChange={setTitle} invalid={touched && title.trim() === ''} />
          </Field>
          <Field label="Body" help="Markdown: the brief, the scope, the acceptance. Optional.">
            <AttachTextarea value={body} onChange={setBody} attacher={attacher} rows={8} />
          </Field>
          <Field label="Labels" help={LABELS_HELP} error={labelProblem}>
            <LabelEditor
              values={labels}
              onChange={setLabels}
              vocabulary={vocabulary}
              handleRef={labelEntry}
              onProblem={setLabelProblem}
            />
          </Field>
          <Checkbox checked={approved} onChange={setApproved} label={START_APPROVED_LABEL} />
          <Checkbox checked={parallel} onChange={setParallel} label={PARALLEL_LABEL} />
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}

interface AddFooterProps {
  busy: boolean;
  disabled: boolean;
  ready: boolean;
  /** The main button: what a create does. */
  label: string;
  onCancel: () => void;
  onSubmit: (draft: boolean) => void;
}

/**
 * An add dialog's buttons: Cancel, **Save as draft** (2026-10-30) and the
 * main create. Two buttons rather than a box to tick: a draft does not land
 * where the main button says (the bottom, Requests), so the button pressed
 * says what happens.
 */
function AddFooter({ busy, disabled, ready, label, onCancel, onSubmit }: AddFooterProps) {
  return (
    <>
      <Button onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      {ready && (
        <span title={SAVE_AS_DRAFT_HINT}>
          <Button disabled={busy || disabled} onClick={() => onSubmit(true)}>
            <Icon name="eye-off" size={14} />
            {SAVE_AS_DRAFT}
          </Button>
        </span>
      )}
      <Button variant="primary" loading={busy} disabled={disabled} onClick={() => onSubmit(false)}>
        {ready ? label : 'Set your email'}
      </Button>
    </>
  );
}

/** The labels field's help, on Add item and the item page's Edit (rag-t0027). */
export const LABELS_HELP =
  'Optional: what it is about, such as Frontend or Docs. The project’s labels are offered.';

// ---- Add a request -----------------------------------------------------------

/**
 * **Add request** (rag-t0044): the owner's idea, a title and the request
 * itself (what is wanted, and how to prioritise it), in a bigger box than an
 * item's body. Owner-approved by default, as every owner creation is. It is
 * filed in Requests, never in the queue: the manager, woken by the event
 * feed, breaks it into tickets that link back to it and marks it done.
 */
export function AddRequestDialog({ open, project, onCancel, onDone }: AddDialogProps) {
  const gate = useTrackerGate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [approved, setApproved] = useState(true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, setBody);
  const root = useRef<HTMLDivElement>(null);

  const reset = () => {
    setTitle('');
    setBody('');
    setApproved(true);
    setTouched(false);
    setError(null);
    attacher.clearError();
  };

  const close = () => {
    reset();
    onCancel();
  };

  const submit = (draft = false) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (title.trim() === '' || busy || attacher.uploads > 0) {
      return;
    }
    setBusy(true);
    setError(null);
    createItem(
      project,
      {
        type: 'request',
        title: title.trim(),
        body,
        ...startApproval(approved),
        ...asDraft(draft),
      },
      gate.fields,
    )
      .then(() => {
        setBusy(false);
        reset();
        onDone();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };
  useSaveShortcut(
    open,
    gate.ready && !busy && attacher.uploads === 0 ? () => submit() : null,
    root,
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a request"
      width={720}
      footer={
        <AddFooter
          busy={busy}
          disabled={attacher.uploads > 0}
          ready={gate.ready}
          label="File the request"
          onCancel={close}
          onSubmit={submit}
        />
      }
    >
      <Form onSubmit={submit}>
        {/* A file dropped anywhere on the form goes into the request. */}
        <div
          className={writeStyles.dialogBody}
          ref={root}
          {...attacher.dropZone(() => root.current?.querySelector('textarea') ?? null)}
        >
          <Field
            label="Title"
            error={touched && title.trim() === '' ? 'A request needs a title.' : undefined}
          >
            <Input value={title} onChange={setTitle} invalid={touched && title.trim() === ''} />
          </Field>
          <Field
            label="Request"
            help="Markdown: the idea, and how to prioritise it (at the top, before a ticket, after a gate). The manager breaks it into tickets."
          >
            <AttachTextarea value={body} onChange={setBody} attacher={attacher} rows={16} />
          </Field>
          <Checkbox checked={approved} onChange={setApproved} label={START_APPROVED_LABEL} />
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}

// ---- Add a gate -------------------------------------------------------------

const INTENSITY_OPTIONS = INTENSITIES.map((value) => ({ value, label: intensityLabel(value) }));

/**
 * **Add gate**: intensity, release and whether it starts owner-approved, as
 * Add item's box and for the same reason; it joins the bottom. A gate carries
 * no version number (R7): its version falls where it falls in the queue.
 */
export function AddGateDialog({ open, project, onCancel, onDone }: AddDialogProps) {
  const gate = useTrackerGate();
  const [intensity, setIntensity] = useState<Intensity>('standard');
  const [release, setRelease] = useState(false);
  const [approved, setApproved] = useState(true);
  // The title follows the choices until the reader types one of their own.
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const shown = title ?? gateTitle(intensity, release);

  const reset = () => {
    setIntensity('standard');
    setRelease(false);
    setApproved(true);
    setTitle(null);
    setError(null);
  };

  const close = () => {
    reset();
    onCancel();
  };

  const submit = (draft = false) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const finalTitle = shown.trim() === '' ? gateTitle(intensity, release) : shown.trim();
    createItem(
      project,
      {
        type: 'gate',
        title: finalTitle,
        intensity,
        release,
        ...startApproval(approved),
        ...asDraft(draft),
      },
      gate.fields,
    )
      .then(() => {
        setBusy(false);
        reset();
        onDone();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };
  useSaveShortcut(open, gate.ready && !busy ? () => submit() : null, root);

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a gate"
      width={480}
      footer={
        <AddFooter
          busy={busy}
          disabled={false}
          ready={gate.ready}
          label="Add to the bottom"
          onCancel={close}
          onSubmit={submit}
        />
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody} ref={root}>
          <Field label="Intensity">
            <Segmented
              value={intensity}
              onChange={(value) => setIntensity(value as Intensity)}
              options={INTENSITY_OPTIONS}
              label="Intensity"
            />
          </Field>
          <Toggle checked={release} onChange={setRelease} label="Release after this gate" />
          <Field label="Title">
            <Input value={shown} onChange={setTitle} />
          </Field>
          <Checkbox checked={approved} onChange={setApproved} label={START_APPROVED_LABEL} />
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}

// ---- Publish and Make draft (2026-10-30) --------------------------------------

export interface DraftDialogProps {
  project: string;
  /** The ticket it acts on; `null` is closed. */
  item: Pick<Item, 'id' | 'title' | 'type'> | null;
  onCancel: () => void;
  /** The write landed. The caller re-reads. */
  onDone: () => void;
}

/**
 * **Publish** a draft ticket (`draft: false`): it takes its place in the
 * queue (or Requests), and the feed announces it, so a watching manager hears
 * of it once, as it now stands.
 */
export function PublishDialog({ project, item, onCancel, onDone }: DraftDialogProps) {
  const what = item?.type === 'gate' ? 'gate' : item?.type === 'request' ? 'request' : 'ticket';
  return (
    <NoteDialog
      project={project}
      open={item !== null}
      title={`Publish this ${what}?`}
      {...(item === null ? {} : { subject: item })}
      message={
        <p>
          It leaves Drafts for{' '}
          {what === 'request' ? 'Requests' : 'the queue, at the place it kept as a draft'}. Agents
          watching the feed are told, once, with it as it now stands.
        </p>
      }
      confirmLabel="Publish"
      onCancel={onCancel}
      onSubmit={(note, fields) => updateItem(item!.id, { draft: false, note }, fields)}
      onDone={onDone}
    />
  );
}

/**
 * **Make draft** (`draft: true`): a published ticket goes back to Drafts,
 * keeping its place. The feed says so once; its changes after that are left
 * out until it is published again, and nothing dispatches it meanwhile.
 */
export function MakeDraftDialog({ project, item, onCancel, onDone }: DraftDialogProps) {
  const what = item?.type === 'gate' ? 'gate' : item?.type === 'request' ? 'request' : 'ticket';
  return (
    <NoteDialog
      project={project}
      open={item !== null}
      title={`Make this ${what} a draft?`}
      {...(item === null ? {} : { subject: item })}
      message={
        <p>
          It moves to Drafts and keeps its place. Agents are told once; after that its changes stay
          out of the feed and nothing picks it up until you publish it.
        </p>
      }
      confirmLabel="Make draft"
      onCancel={onCancel}
      onSubmit={(note, fields) => updateItem(item!.id, { draft: true, note }, fields)}
      onDone={onDone}
    />
  );
}
