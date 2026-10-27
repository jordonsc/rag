/**
 * The tracker's write dialogs: one with a note, the owner's approval of an
 * item, and the two that add to the queue.
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
  Textarea,
  Toggle,
} from '@rag/ui';

import { asApiError, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { createItem, updateItem } from './api';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { LabelEditor, submittedLabels, useProjectLabels } from './LabelEditor';
import type { Intensity, TrackerAuthor, WorkType } from './types';
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

export interface NoteDialogProps {
  open: boolean;
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
  title,
  subject,
  message,
  children,
  noteRequired = false,
  noteLabel = 'Note',
  noteHelp,
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

  const missing = noteRequired && note.trim() === '';

  const close = () => {
    setNote('');
    setTouched(false);
    setError(null);
    onCancel();
  };

  const submit = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (missing || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    onSubmit(note.trim(), gate.fields)
      .then(() => {
        setBusy(false);
        setNote('');
        setTouched(false);
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
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={submit}>
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
                ? 'It is kept in the item’s history.'
                : 'Why, when it is not obvious from the change. It is kept in the item’s history.')
            }
            error={touched && missing ? 'A note needs some text.' : undefined}
          >
            <Textarea
              value={note}
              onChange={setNote}
              rows={3}
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
export function ApprovalDialog({ action, subject, onCancel, onDone }: ApprovalDialogProps) {
  const ratify = action === 'ratify';
  return (
    <NoteDialog
      open={action !== null && subject !== null}
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
 * **Add item**: type, title, body, whether it starts owner-approved, and
 * whether it is parallel (unticked by default: it may then start before the
 * gates above it clear, rag-t0013); it joins the bottom of the queue.
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
  };

  const close = () => {
    reset();
    onCancel();
  };

  const submit = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setTouched(true);
    if (title.trim() === '' || busy) {
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

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add an item"
      width={600}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {gate.ready ? 'Add to the bottom' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
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
            error={touched && title.trim() === '' ? 'An item needs a title.' : undefined}
          >
            <Input value={title} onChange={setTitle} invalid={touched && title.trim() === ''} />
          </Field>
          <Field label="Body" help="Markdown: the brief, the scope, the acceptance. Optional.">
            <Textarea value={body} onChange={setBody} rows={8} />
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

/** The labels field's help, on Add item and the item page's Edit (rag-t0027). */
export const LABELS_HELP =
  'Optional: what it is about, such as Physics or Biomes. The project’s labels are offered.';

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

  const submit = () => {
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
      { type: 'gate', title: finalTitle, intensity, release, ...startApproval(approved) },
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

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a gate"
      width={480}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {gate.ready ? 'Add to the bottom' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
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
