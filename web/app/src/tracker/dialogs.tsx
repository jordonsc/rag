/**
 * The tracker's write dialogs: one with a note, the owner's approval of an
 * item, the two that add to the queue, Add request (rag-t0044), Publish and
 * Make draft (2026-10-30), and the roadmap's: New phase, Release, Recall and
 * Move to phase (spec:roadmap RM-46, RM-48).
 *
 * The ledger's write rules hold here unchanged: the identity gate prompts
 * rather than hides (`useTrackerGate`), nothing is optimistic (the caller
 * re-reads once `onDone` fires), and a failure is the server's own sentence.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
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
  Select,
  Toggle,
} from '@rag/ui';
import { Link } from 'react-router';

import { asApiError, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import {
  TrackerApiError,
  createItem,
  createPhase,
  recallPhase,
  releasePhase,
  setItemPhase,
  updateItem,
} from './api';
import { useSaveShortcut } from './saveShortcut';
import { AttachTextarea, useAttachments } from './attach';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { keptKey, useKeptText } from './keptText';
import { LabelEditor, submittedLabels, useProjectLabels } from './LabelEditor';
import { itemPath } from './paths';
import roadmapStyles from './roadmap.module.css';
import type {
  Intensity,
  Item,
  PhaseFigures,
  PhaseOutcome,
  PhaseRecord,
  TrackerAuthor,
  Waiting,
  WorkType,
} from './types';
import { INTENSITIES, WORK_TYPES } from './types';
import { useRoadmap } from './useRoadmap';
import { readVelocityWindow } from './velocity';
import {
  approvalLabel,
  gateTitle,
  intensityLabel,
  itemTypeHint,
  itemTypeLabel,
  phaseStateLabel,
} from './vocab';

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
 *
 * A click away, Esc or the X keeps the note for the next time the same action
 * is opened on the same record; **Cancel** discards it (`keptText.ts`).
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
  const kept = useKeptText(open ? keptKey(project, subject?.id ?? title, confirmLabel) : null);
  const note = kept.text;
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, kept.update);

  const missing = noteRequired && note.trim() === '';

  const dismiss = () => {
    setTouched(false);
    setError(null);
    attacher.clearError();
    onCancel();
  };

  const discard = () => {
    kept.set('');
    dismiss();
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
        kept.set('');
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
      onClose={dismiss}
      title={title}
      width={520}
      footer={
        <>
          <Button onClick={discard} disabled={busy}>
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
              onChange={kept.set}
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
  /**
   * The phase it is created in (spec:roadmap D7), on a phase's page: it joins
   * that phase's tail while planned, the queue's bottom once released.
   */
  phase?: string;
  /** With `phase`: where it lands, on the main button. Defaults to the bottom. */
  addLabel?: string;
  onCancel: () => void;
  onDone: () => void;
}

/** A create's `phase`, never blank: the server refuses that (spec:roadmap RM-23). */
function inPhase(phase: string | undefined): { phase?: string } {
  return phase === undefined || phase === '' ? {} : { phase };
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
export function AddItemDialog({
  open,
  project,
  phase,
  addLabel = 'Add to the bottom',
  onCancel,
  onDone,
}: AddDialogProps) {
  const gate = useTrackerGate();
  const [type, setType] = useState<WorkType>('dev');
  // What is typed for a phase stays with that phase, apart from the queue's.
  const keptRecord = phase === undefined ? 'new-item' : `new-item-${phase}`;
  const keptTitle = useKeptText(open ? keptKey(project, keptRecord, 'title') : null);
  const keptBody = useKeptText(open ? keptKey(project, keptRecord, 'body') : null);
  const title = keptTitle.text;
  const body = keptBody.text;
  const [approved, setApproved] = useState(true);
  const [parallel, setParallel] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const [labelProblem, setLabelProblem] = useState<string | undefined>(undefined);
  const labelEntry = useRef<ChipListHandle>(null);
  const vocabulary = useProjectLabels(project, open);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, keptBody.update);
  const root = useRef<HTMLDivElement>(null);

  const reset = () => {
    setType('dev');
    keptTitle.set('');
    keptBody.set('');
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

  // A click away, Esc or the X keeps what was written, for the next time this
  // is opened; Cancel (above) discards it.
  const dismiss = () => {
    setTouched(false);
    setError(null);
    attacher.clearError();
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
        ...inPhase(phase),
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
      onClose={dismiss}
      title="Add a ticket"
      width={600}
      footer={
        <AddFooter
          busy={busy}
          disabled={attacher.uploads > 0}
          ready={gate.ready}
          label={addLabel}
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
            <Input
              value={title}
              onChange={keptTitle.set}
              invalid={touched && title.trim() === ''}
            />
          </Field>
          <Field label="Body" help="Markdown: the brief, the scope, the acceptance. Optional.">
            <AttachTextarea value={body} onChange={keptBody.set} attacher={attacher} rows={8} />
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
  const keptTitle = useKeptText(open ? keptKey(project, 'new-request', 'title') : null);
  const keptBody = useKeptText(open ? keptKey(project, 'new-request', 'body') : null);
  const title = keptTitle.text;
  const body = keptBody.text;
  const [approved, setApproved] = useState(true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, keptBody.update);
  const root = useRef<HTMLDivElement>(null);

  const reset = () => {
    keptTitle.set('');
    keptBody.set('');
    setApproved(true);
    setTouched(false);
    setError(null);
    attacher.clearError();
  };

  const close = () => {
    reset();
    onCancel();
  };

  // A click away, Esc or the X keeps what was written, for the next time this
  // is opened; Cancel (above) discards it.
  const dismiss = () => {
    setTouched(false);
    setError(null);
    attacher.clearError();
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
      onClose={dismiss}
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
            <Input
              value={title}
              onChange={keptTitle.set}
              invalid={touched && title.trim() === ''}
            />
          </Field>
          <Field
            label="Request"
            help="Markdown: the idea, and how to prioritise it (at the top, before a ticket, after a gate). The manager breaks it into tickets."
          >
            <AttachTextarea value={body} onChange={keptBody.set} attacher={attacher} rows={16} />
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
export function AddGateDialog({
  open,
  project,
  phase,
  addLabel = 'Add to the bottom',
  onCancel,
  onDone,
}: AddDialogProps) {
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
        ...inPhase(phase),
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
          label={addLabel}
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
  item: (Pick<Item, 'id' | 'title' | 'type'> & Pick<Partial<Item>, 'frozen'>) | null;
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
        item?.frozen === true ? (
          <p>
            It stays frozen, in its place in the phase, and is no longer a draft. Agents are told
            nothing until the phase is released.
          </p>
        ) : (
          <p>
            It leaves Drafts for{' '}
            {what === 'request' ? 'Requests' : 'the queue, at the place it kept as a draft'}. Agents
            watching the feed are told, once, with it as it now stands.
          </p>
        )
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
        item?.frozen === true ? (
          <p>
            It stays frozen, in its place in the phase, and goes on being a draft when the phase is
            released: nothing picks it up until you publish it.
          </p>
        ) : (
          <p>
            It moves to Drafts and keeps its place. Agents are told once; after that its changes
            stay out of the feed and nothing picks it up until you publish it.
          </p>
        )
      }
      confirmLabel="Make draft"
      onCancel={onCancel}
      onSubmit={(note, fields) => updateItem(item!.id, { draft: true, note }, fields)}
      onDone={onDone}
    />
  );
}

// ---- The roadmap (spec:roadmap RM-46, RM-48) ----------------------------------

/** "1 ticket", "40 tickets". */
function tickets(n: number): string {
  return `${n} ${n === 1 ? 'ticket' : 'tickets'}`;
}

/**
 * Who is left waiting on whom across the boundary (D13), each id a link. It warns:
 * neither a release nor a recall is refused for it. Nothing when nobody is.
 */
export function WaitingList({ project, pairs }: { project: string; pairs: readonly Waiting[] }) {
  if (pairs.length === 0) {
    return null;
  }
  return (
    <div className={roadmapStyles.waiting} role="note">
      <Icon name="triangle-alert" size={14} />
      <div>
        <strong>Left waiting across the boundary</strong>
        <ul className={roadmapStyles.waitingList}>
          {pairs.map(({ ticket, on }) => (
            <li key={`${ticket}:${on}`}>
              <Link to={itemPath(project, ticket)}>
                <code>{ticket}</code>
              </Link>
              {' waits on '}
              <Link to={itemPath(project, on)}>
                <code>{on}</code>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export interface PhaseWriteDialogProps {
  project: string;
  /** The phase, read with its tickets; `null` is closed. */
  phase: PhaseRecord | null;
  onCancel: () => void;
  /** The write landed: what it moved, and what it left waiting. The caller re-reads. */
  onDone: (outcome: PhaseOutcome) => void;
}

type ReleasePlace = 'bottom' | 'top';

const RELEASE_PLACES: readonly { value: ReleasePlace; label: string }[] = [
  { value: 'bottom', label: 'At the bottom' },
  { value: 'top', label: 'At the top' },
];

/**
 * **Release** a planned phase (D11, D13, D18): it states what joins the queue,
 * where, and who it leaves waiting, before it is pressed. It warns and never
 * refuses. A queued ticket's before and after are not offered here: move the
 * tickets afterwards. The counts are from the tickets on the page, so a draft is
 * stated apart: a released draft stays one, undispatched.
 */
export function ReleaseDialog({ project, phase, onCancel, onDone }: PhaseWriteDialogProps) {
  const [place, setPlace] = useState<ReleasePlace>('bottom');
  const outcome = useRef<PhaseOutcome | null>(null);
  const frozen = (phase?.tickets ?? []).filter((ticket) => ticket.frozen === true);
  const drafts = frozen.filter((ticket) => ticket.draft === true).length;
  const joining = frozen.length - drafts;
  const where = place === 'top' ? 'at the top' : 'at the bottom';
  return (
    <NoteDialog
      project={project}
      open={phase !== null}
      title="Release this phase?"
      {...(phase === null ? {} : { subject: phase })}
      message={
        <>
          <p>
            {`Release “${phase?.title ?? ''}”? `}
            {joining === 0 && drafts === 0
              ? 'It has no frozen tickets, so nothing joins the queue: it is simply marked released.'
              : `${tickets(joining)} ${joining === 1 ? 'joins' : 'join'} the queue, ${where}. ` +
                `${joining === 1 ? 'It becomes' : 'They become'} visible to agents, and one notice is sent.`}
          </p>
          {drafts > 0 && (
            <p>
              {`${drafts} ${drafts === 1 ? 'draft goes' : 'drafts go'} with ${joining === 1 ? 'it' : 'them'}: `}
              they stay drafts, and nothing picks them up until you publish them.
            </p>
          )}
          <WaitingList project={project} pairs={phase?.would_wait ?? []} />
        </>
      }
      noteHelp="Why, when it is not obvious. It follows “Phase released.” in the phase’s history and in the notice."
      confirmLabel="Release"
      onCancel={onCancel}
      onSubmit={(note, fields) =>
        releasePhase(
          project,
          phase!.id,
          { place: place === 'top' ? { top: true } : { bottom: true }, note },
          fields,
        ).then((answer) => {
          outcome.current = answer;
        })
      }
      onDone={() => {
        setPlace('bottom');
        onDone(outcome.current!);
      }}
    >
      <Field label="Where in the queue">
        <Segmented
          value={place}
          onChange={(value) => setPlace(value as ReleasePlace)}
          options={RELEASE_PLACES}
          label="Where in the queue"
        />
      </Field>
    </NoteDialog>
  );
}

/**
 * **Recall** a released phase (D12, D13): its pending tickets go back to it,
 * whatever their block or draft, and the rest stay where they are. The counts are
 * from the tickets on the page, as what the server will do is by status.
 */
export function RecallDialog({ project, phase, onCancel, onDone }: PhaseWriteDialogProps) {
  const outcome = useRef<PhaseOutcome | null>(null);
  const linked = phase?.tickets ?? [];
  const back = linked.filter((ticket) => ticket.status === 'pending').length;
  const working = linked.filter(
    (ticket) => ticket.status === 'in_progress' || ticket.status === 'review',
  ).length;
  const aside = linked.filter(
    (ticket) => ticket.status === 'failed' || ticket.status === 'deferred',
  ).length;
  return (
    <NoteDialog
      project={project}
      open={phase !== null}
      title="Recall this phase?"
      {...(phase === null ? {} : { subject: phase })}
      message={
        <>
          <p>
            {`Recall “${phase?.title ?? ''}”? `}
            {`${back} pending ${back === 1 ? 'ticket goes' : 'tickets go'} back to the phase, out of the queue. `}
            {`${tickets(working)} in progress or review ${working === 1 ? 'stays' : 'stay'} where ${working === 1 ? 'it is' : 'they are'}.`}
            {aside > 0 &&
              ` ${aside} failed or deferred ${aside === 1 ? 'ticket stays' : 'tickets stay'} too.`}
          </p>
          <p>The phase goes to the top of the roadmap, as it is next.</p>
          <WaitingList project={project} pairs={phase?.would_wait ?? []} />
        </>
      }
      noteHelp="Why, when it is not obvious. It follows “Phase recalled.” in the phase’s history and in the notice."
      confirmLabel="Recall"
      onCancel={onCancel}
      onSubmit={(note, fields) =>
        recallPhase(project, phase!.id, { note }, fields).then((answer) => {
          outcome.current = answer;
        })
      }
      onDone={() => onDone(outcome.current!)}
    />
  );
}

export interface NewPhaseDialogProps {
  open: boolean;
  project: string;
  onCancel: () => void;
  /** It was created: the caller goes to it, or re-reads. */
  onDone: (phase: PhaseRecord) => void;
}

/**
 * **New phase**: a title and what it is for. It joins the bottom of the roadmap,
 * planned, and nothing in it reaches the queue until it is released. A click
 * away, Esc or the X keeps what was written; Cancel discards it. Ctrl+S is the
 * main button.
 */
export function NewPhaseDialog({ open, project, onCancel, onDone }: NewPhaseDialogProps) {
  const gate = useTrackerGate();
  const keptTitle = useKeptText(open ? keptKey(project, 'new-phase', 'title') : null);
  const keptBody = useKeptText(open ? keptKey(project, 'new-phase', 'body') : null);
  const title = keptTitle.text;
  const body = keptBody.text;
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const attacher = useAttachments(project, keptBody.update);
  const root = useRef<HTMLDivElement>(null);

  const dismiss = () => {
    setTouched(false);
    setError(null);
    attacher.clearError();
    onCancel();
  };

  const close = () => {
    keptTitle.set('');
    keptBody.set('');
    dismiss();
  };

  const submit = () => {
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
    createPhase(project, { title: title.trim(), body }, gate.fields)
      .then((phase) => {
        setBusy(false);
        keptTitle.set('');
        keptBody.set('');
        setTouched(false);
        attacher.clearError();
        onDone(phase);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };
  useSaveShortcut(open, gate.ready && !busy && attacher.uploads === 0 ? submit : null, root);

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      title="New phase"
      width={600}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={attacher.uploads > 0} onClick={submit}>
            {gate.ready ? 'Add to the roadmap' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody} ref={root}>
          <Field
            label="Title"
            error={touched && title.trim() === '' ? 'A phase needs a title.' : undefined}
          >
            <Input
              value={title}
              onChange={keptTitle.set}
              invalid={touched && title.trim() === ''}
            />
          </Field>
          <Field
            label="Body"
            help="Markdown: what this phase is for. Optional. Its tickets stay frozen, out of the queue, until it is released."
          >
            <AttachTextarea value={body} onChange={keptBody.set} attacher={attacher} rows={8} />
          </Field>
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          <Failure error={error} />
        </div>
      </Form>
    </Dialog>
  );
}

/**
 * Why a ticket cannot move to a phase, or `null` when it can (D4, D8): the
 * server's rules, read here only to decide what to offer.
 */
export function phaseMoveRefusal(
  item: Pick<Item, 'status'> & Pick<Partial<Item>, 'phase' | 'frozen'>,
  target: Pick<PhaseFigures, 'id' | 'state'>,
): string | null {
  const same = item.phase === target.id;
  const frozen = item.frozen === true;
  if (target.state === 'planned') {
    if (frozen && same) {
      return 'already frozen here';
    }
    return !frozen && item.status !== 'pending' ? 'only a pending ticket can be frozen' : null;
  }
  return !frozen && same ? 'already its phase' : null;
}

/** What a move to `target` will do, said before it is pressed (D8). */
function moveEffect(frozen: boolean, target: PhaseFigures): string {
  if (target.state === 'planned') {
    return 'It is frozen at the bottom of that phase: out of the queue, and out of every agent’s sight until the phase is released.';
  }
  return frozen
    ? 'That phase is released, so this one joins the bottom of the queue, unfrozen, linked to it.'
    : 'That phase is released, so only the link is written: it keeps its place in the queue.';
}

export interface MovePhaseDialogProps {
  item: Item;
  onCancel: () => void;
  onDone: () => void;
}

/**
 * **Move to phase** (D8), drawn only while open: the project's planned and
 * released phases from `useRoadmap`, each one the ticket's status rules out
 * offered disabled with the reason, so the choice explains itself.
 */
export function MovePhaseDialog({ item, onCancel, onDone }: MovePhaseDialogProps) {
  const [window] = useState(readVelocityWindow);
  const { roadmap, error } = useRoadmap(item.project, window, null);
  const [chosen, setChosen] = useState('');
  const phases = useMemo(
    () => (roadmap === null ? [] : [...roadmap.planned, ...roadmap.released, ...roadmap.complete]),
    [roadmap],
  );
  const options = phases.map((phase) => {
    const refusal = phaseMoveRefusal(item, phase);
    return {
      value: phase.id,
      label: `${phase.title} (${phaseStateLabel(phase.state).toLowerCase()})${
        refusal === null ? '' : `: ${refusal}`
      }`,
      disabled: refusal !== null,
    };
  });
  const target = phases.find((phase) => phase.id === chosen);
  return (
    <NoteDialog
      project={item.project}
      open
      title="Move this ticket to a phase"
      subject={item}
      {...(target === undefined
        ? {}
        : { message: <p>{moveEffect(item.frozen === true, target)}</p> })}
      confirmLabel="Move to phase"
      onCancel={onCancel}
      onSubmit={(note, fields) =>
        chosen === ''
          ? Promise.reject(new TrackerApiError(0, 'Choose a phase.'))
          : setItemPhase(item.id, { phase: chosen, note }, fields)
      }
      onDone={onDone}
    >
      {roadmap === null && error !== null && <Failure error={error} />}
      <Field label="Phase">
        {roadmap !== null && phases.length === 0 ? (
          <p>This project has no planned or released phase. Add one on its Roadmap tab.</p>
        ) : (
          <Select
            value={chosen}
            onChange={setChosen}
            options={options}
            aria-label="Phase"
            placeholder={
              roadmap === null && error === null ? 'Loading the phases…' : 'Choose a phase'
            }
          />
        )}
      </Field>
    </NoteDialog>
  );
}
