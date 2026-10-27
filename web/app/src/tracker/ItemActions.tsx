import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  type ChipListHandle,
  Dialog,
  Field,
  Form,
  Icon,
  IconButton,
  Input,
  Picker,
  Segmented,
  Select,
  Textarea,
  Toggle,
} from '@rag/ui';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { listItems, updateItem } from './api';
import { ApprovalDialog, LABELS_HELP, NoteDialog, PARALLEL_LABEL } from './dialogs';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { LabelEditor, submittedLabels, useProjectLabels } from './LabelEditor';
import { sameLabels } from './labels';
import styles from './item.module.css';
import {
  BLOCK_REASONS,
  INTENSITIES,
  LINK_KINDS,
  type BlockReason,
  type Intensity,
  type Item,
  type ItemStatus,
  type ItemUpdate,
  type Link,
  type LinkKind,
} from './types';
import {
  approvalLabel,
  blockReasonLabel,
  intensityLabel,
  linkKindLabel,
  nextStatuses,
  transitionLabel,
} from './vocab';

type Open =
  | 'note'
  | 'status'
  | 'block'
  | 'unblock'
  | 'defer'
  | 'resume'
  | 'confirm'
  | 'sendBack'
  | 'approve'
  | 'ratify'
  | 'withdraw'
  | 'edit';

export interface ItemActionsProps {
  item: Item;
  /** The write landed: re-read the item. */
  onWritten: () => void;
}

const REASON_OPTIONS = BLOCK_REASONS.map((value) => ({ value, label: blockReasonLabel(value) }));

/**
 * The item page's writes (D15): note, status, block or unblock, defer or
 * resume (rag-t0017), confirm or send back an item in review (rag-t0024),
 * approve or ratify, edit.
 *
 * Each is one `POST /tracker/items/{id}`. Only **Note** needs text; every
 * other write's note is optional (D7, amended by the owner 2026-10-27), and
 * without one the history records the change itself. From
 * the web an approval is the **owner's** (`owner`), or the owner's
 * **ratification** of an agent's (`agent` → `ratified`), D10. Nothing is
 * hidden when no identity is set: pressing opens the prompt.
 */
export function ItemActions({ item, onWritten }: ItemActionsProps) {
  const gate = useTrackerGate();
  const [open, setOpen] = useState<Open | null>(null);
  const statuses = nextStatuses(item.status);
  const [status, setStatus] = useState<ItemStatus | ''>('');
  const [reason, setReason] = useState<BlockReason>('review');
  // Block with reason dependency (rag-t0018): the items it waits on, chosen
  // from the project's queued items, read when that reason is first chosen.
  const [waitsOn, setWaitsOn] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<Item[] | null>(null);

  useEffect(() => {
    if (open !== 'block' || reason !== 'dependency' || candidates !== null) {
      return undefined;
    }
    const controller = new AbortController();
    listItems(item.project, undefined, controller.signal)
      .then((response) => setCandidates(dependencyCandidates(item, response.items)))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          // Without the list the picker offers nothing; the server still
          // checks what is sent.
          setCandidates([]);
        }
      });
    return () => controller.abort();
  }, [open, reason, candidates, item]);

  const show = (which: Open) => () => {
    if (!gate.ready) {
      gate.prompt();
      return;
    }
    if (which === 'status') {
      setStatus(statuses[0] ?? '');
    }
    if (which === 'block') {
      setWaitsOn([]);
      setCandidates(null);
    }
    setOpen(which);
  };
  const close = () => setOpen(null);
  const done = () => {
    setOpen(null);
    onWritten();
  };
  const subject = { id: item.id, title: item.title };
  const send = (body: ItemUpdate) => (note: string, fields: Parameters<typeof updateItem>[2]) =>
    updateItem(item.id, { ...body, note }, fields);

  return (
    <div className={writeStyles.actions}>
      <Button size="sm" onClick={show('note')}>
        <Icon name="message-square" size={14} />
        Note
      </Button>
      {statuses.length > 0 && (
        <Button size="sm" onClick={show('status')}>
          <Icon name="circle-dot" size={14} />
          Status…
        </Button>
      )}
      {item.queued &&
        (item.blocked ? (
          <Button size="sm" variant="caution" onClick={show('unblock')}>
            <Icon name="lock-open" size={14} />
            Unblock
          </Button>
        ) : (
          <Button size="sm" onClick={show('block')}>
            <Icon name="lock" size={14} />
            Block…
          </Button>
        ))}
      {item.status === 'deferred' ? (
        <Button size="sm" onClick={show('resume')}>
          <Icon name="circle-play" size={14} />
          Resume
        </Button>
      ) : (
        statuses.includes('deferred') && (
          <Button size="sm" onClick={show('defer')}>
            <Icon name="circle-pause" size={14} />
            Defer
          </Button>
        )
      )}
      {item.status === 'review' && (
        <>
          <Button size="sm" variant="accent" onClick={show('confirm')}>
            <Icon name="check" size={14} />
            Confirm
          </Button>
          <Button size="sm" onClick={show('sendBack')}>
            <Icon name="rotate-ccw" size={14} />
            Send back
          </Button>
        </>
      )}
      {item.approval === 'agent' && (
        <Button size="sm" variant="accent" onClick={show('ratify')}>
          <Icon name="shield-check" size={14} />
          Ratify
        </Button>
      )}
      {item.approval === 'unapproved' && (
        <Button size="sm" variant="accent" onClick={show('approve')}>
          <Icon name="shield-check" size={14} />
          Approve
        </Button>
      )}
      {(item.approval === 'owner' || item.approval === 'ratified') && (
        <Button size="sm" variant="ghost" onClick={show('withdraw')}>
          Withdraw approval
        </Button>
      )}
      <Button size="sm" onClick={show('edit')}>
        <Icon name="pencil" size={14} />
        Edit…
      </Button>
      {!gate.ready && <span className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</span>}

      <NoteDialog
        open={open === 'note'}
        title="Add a note"
        subject={subject}
        confirmLabel="Add note"
        noteRequired
        onCancel={close}
        onSubmit={send({})}
        onDone={done}
      />
      <NoteDialog
        open={open === 'status'}
        title="Change the status"
        subject={subject}
        confirmLabel="Change status"
        onCancel={close}
        onSubmit={(note, fields) =>
          updateItem(item.id, { status: status as ItemStatus, note }, fields)
        }
        onDone={done}
      >
        <Field label="New status">
          <Select
            value={status}
            onChange={(value) => setStatus(value as ItemStatus)}
            options={statuses.map((to) => ({ value: to, label: transitionLabel(item.status, to) }))}
          />
        </Field>
      </NoteDialog>
      <NoteDialog
        open={open === 'block'}
        title="Block this item"
        subject={subject}
        message={
          <p>
            It moves to Blocked on the dashboard and keeps its place in the queue, so unblocking
            puts it back where it was.
          </p>
        }
        confirmLabel="Block"
        onCancel={close}
        onSubmit={(note, fields) =>
          updateItem(
            item.id,
            {
              blocked: true,
              block_reason: reason,
              ...(reason === 'dependency' ? { depends_on: waitsOn } : {}),
              note,
            },
            fields,
          )
        }
        onDone={done}
      >
        <Field label="Reason">
          <Segmented
            value={reason}
            onChange={(value) => setReason(value as BlockReason)}
            options={REASON_OPTIONS}
            label="Reason"
          />
        </Field>
        {reason === 'dependency' && (
          <Field
            label="Waits on"
            help="Items of this project. It unblocks itself when the last of them is done; a cancelled one never frees it."
          >
            <Picker
              multiple
              values={waitsOn}
              onChange={setWaitsOn}
              options={(candidates ?? []).map((candidate) => ({
                value: candidate.id,
                label: candidate.title,
                code: candidate.id,
              }))}
              placeholder={
                candidates === null ? 'Loading the items…' : 'Find an item by id or title'
              }
            />
          </Field>
        )}
      </NoteDialog>
      <NoteDialog
        open={open === 'unblock'}
        title="Unblock this item?"
        subject={subject}
        message={<p>It goes back into the queue at the place it kept while blocked.</p>}
        confirmLabel="Unblock"
        onCancel={close}
        onSubmit={send({ blocked: false })}
        onDone={done}
      />
      <NoteDialog
        open={open === 'defer'}
        title="Defer this item?"
        subject={subject}
        message={
          <p>
            It moves to Deferred on the dashboard and keeps its place in the queue, so resuming puts
            it back where it was. Nothing picks it up while it is deferred.
          </p>
        }
        confirmLabel="Defer"
        onCancel={close}
        onSubmit={send({ status: 'deferred' })}
        onDone={done}
      />
      <NoteDialog
        open={open === 'resume'}
        title="Resume this item?"
        subject={subject}
        message={<p>It goes back to pending at the place it kept while deferred.</p>}
        confirmLabel="Resume"
        onCancel={close}
        onSubmit={send({ status: 'pending' })}
        onDone={done}
      />
      <NoteDialog
        open={open === 'confirm'}
        title="Confirm this item?"
        subject={subject}
        message={
          <p>It is done: it leaves the queue and shows under Done until you acknowledge it.</p>
        }
        confirmLabel="Confirm"
        onCancel={close}
        onSubmit={send({ status: 'done' })}
        onDone={done}
      />
      <NoteDialog
        open={open === 'sendBack'}
        title="Send this item back?"
        subject={subject}
        message={<p>It goes back to in progress at the place it kept while in review.</p>}
        confirmLabel="Send back"
        onCancel={close}
        onSubmit={send({ status: 'in_progress' })}
        onDone={done}
      />
      <ApprovalDialog
        action={open === 'ratify' || open === 'approve' ? open : null}
        subject={subject}
        onCancel={close}
        onDone={done}
      />
      <NoteDialog
        open={open === 'withdraw'}
        title="Withdraw the approval?"
        subject={subject}
        message={<p>Sets the approval back to {approvalLabel('unapproved').toLowerCase()}.</p>}
        confirmLabel="Withdraw"
        danger
        onCancel={close}
        onSubmit={send({ approval: 'unapproved' })}
        onDone={done}
      />
      {open === 'edit' && <EditItemDialog item={item} onCancel={close} onDone={done} />}
    </div>
  );
}

// ---- Edit -------------------------------------------------------------------

const KIND_OPTIONS = LINK_KINDS.map((value) => ({ value, label: linkKindLabel(value) }));
const INTENSITY_OPTIONS = INTENSITIES.map((value) => ({ value, label: intensityLabel(value) }));

function sameLink(a: Link, b: Link): boolean {
  return a.kind === b.kind && a.target === b.target;
}

/** What an edit changes, and nothing else: an unchanged field is not sent. */
export function editBody(
  item: Item,
  draft: {
    title: string;
    body: string;
    assignee: string;
    links: Link[];
    intensity: Intensity | null;
    release: boolean;
    /** Not on a gate (rag-t0013). Absent leaves it alone. */
    parallel?: boolean;
    /** The whole set (rag-t0027), sent wholesale when it differs. Absent leaves them alone. */
    labels?: readonly string[];
  },
): ItemUpdate {
  const body: ItemUpdate = {};
  if (draft.title.trim() !== item.title) {
    body.title = draft.title.trim();
  }
  if (draft.body !== item.body) {
    body.body = draft.body;
  }
  if (draft.assignee.trim() !== (item.assignee ?? '')) {
    body.assignee = draft.assignee.trim();
  }
  const added = draft.links.filter((link) => !item.links.some((had) => sameLink(had, link)));
  const removed = item.links.filter((had) => !draft.links.some((link) => sameLink(had, link)));
  if (added.length > 0) {
    body.add_links = added;
  }
  if (removed.length > 0) {
    body.remove_links = removed;
  }
  if (item.type === 'gate') {
    if (draft.intensity !== null && draft.intensity !== item.intensity) {
      body.intensity = draft.intensity;
    }
    if (draft.release !== item.release) {
      body.release = draft.release;
    }
  } else if (draft.parallel !== undefined && draft.parallel !== (item.parallel ?? false)) {
    body.parallel = draft.parallel;
  }
  if (draft.labels !== undefined && !sameLabels(draft.labels, item.labels ?? [])) {
    body.labels = [...draft.labels];
  }
  return body;
}

/**
 * What a dependency block may wait on (rag-t0018): the project's other
 * queued items, in id order. Done and cancelled items are left out: there is
 * nothing to wait for in either.
 */
export function dependencyCandidates(item: Item, items: readonly Item[]): Item[] {
  return items.filter((candidate) => candidate.id !== item.id && candidate.queued);
}

interface EditItemDialogProps {
  item: Item;
  onCancel: () => void;
  onDone: () => void;
}

/**
 * Edit the title, body, assignee, labels (rag-t0027) and links, a gate's
 * intensity and release, and whether any other item is parallel (rag-t0013).
 */
function EditItemDialog({ item, onCancel, onDone }: EditItemDialogProps) {
  const gate = useTrackerGate();
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [assignee, setAssignee] = useState(item.assignee ?? '');
  const [links, setLinks] = useState<Link[]>(item.links);
  const [intensity, setIntensity] = useState<Intensity | null>(item.intensity);
  const [release, setRelease] = useState(item.release);
  const [parallel, setParallel] = useState(item.parallel ?? false);
  const [labels, setLabels] = useState<string[]>(item.labels ?? []);
  const [labelProblem, setLabelProblem] = useState<string | undefined>(undefined);
  const labelEntry = useRef<ChipListHandle>(null);
  const vocabulary = useProjectLabels(item.project);
  const [kind, setKind] = useState<LinkKind>('ledger');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const changes = editBody(item, {
    title,
    body,
    assignee,
    links,
    intensity,
    release,
    parallel,
    labels,
  });
  const unchanged = Object.keys(changes).length === 0;

  const addLink = () => {
    const value = target.trim();
    if (value === '' || /\s/.test(value)) {
      return;
    }
    const link = { kind, target: value };
    if (!links.some((had) => sameLink(had, link))) {
      setLinks([...links, link]);
    }
    setTarget('');
  };

  const submit = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (busy || title.trim() === '') {
      return;
    }
    // A label still in the entry box is part of the edit.
    const chosen = submittedLabels(labelEntry.current, labels, vocabulary);
    if ('problem' in chosen) {
      setLabelProblem(chosen.problem);
      return;
    }
    const sent = editBody(item, {
      title,
      body,
      assignee,
      links,
      intensity,
      release,
      parallel,
      labels: chosen.labels,
    });
    if (Object.keys(sent).length === 0) {
      return;
    }
    setLabels(chosen.labels);
    setBusy(true);
    setError(null);
    updateItem(
      item.id,
      { ...sent, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      gate.fields,
    )
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
    <Dialog
      open
      onClose={onCancel}
      title={`Edit ${item.id}`}
      width={640}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={unchanged} onClick={submit}>
            {gate.ready ? 'Save' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
          <Field label="Title" error={title.trim() === '' ? 'An item needs a title.' : undefined}>
            <Input value={title} onChange={setTitle} invalid={title.trim() === ''} />
          </Field>
          {item.type === 'gate' && (
            <>
              <Field label="Intensity">
                <Segmented
                  value={intensity ?? ''}
                  onChange={(value) => setIntensity(value as Intensity)}
                  options={INTENSITY_OPTIONS}
                  label="Intensity"
                />
              </Field>
              <Toggle checked={release} onChange={setRelease} label="Release after this gate" />
            </>
          )}
          {item.type !== 'gate' && (
            <Checkbox checked={parallel} onChange={setParallel} label={PARALLEL_LABEL} />
          )}
          <Field label="Assignee" help="Free text: the sub-agent working it. Empty clears it.">
            <Input value={assignee} onChange={setAssignee} />
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
          <Field label="Body" help="Markdown.">
            <Textarea value={body} onChange={setBody} rows={10} />
          </Field>
          <Field label="Links">
            <div className={styles.linkEditor}>
              {links.length > 0 && (
                <ul className={styles.linkList}>
                  {links.map((link) => (
                    <li key={`${link.kind}:${link.target}`} className={styles.linkEdit}>
                      <span className={styles.linkKind}>{linkKindLabel(link.kind)}</span>
                      <code>{link.target}</code>
                      <IconButton
                        icon="x"
                        label={`Remove link ${link.target}`}
                        variant="ghost"
                        size={14}
                        onClick={() => setLinks(links.filter((had) => !sameLink(had, link)))}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.linkAdd}>
                <Select
                  value={kind}
                  onChange={(value) => setKind(value as LinkKind)}
                  options={KIND_OPTIONS}
                  aria-label="Link kind"
                />
                <Input
                  value={target}
                  onChange={setTarget}
                  placeholder={
                    kind === 'milestone' ? 'spec/m01' : kind === 'ledger' ? 'rag-0042' : ''
                  }
                  aria-label="Link target"
                />
                <Button size="sm" onClick={addLink} disabled={target.trim() === ''}>
                  Add link
                </Button>
              </div>
            </div>
          </Field>
          <Field label="Note" help="Optional: why, kept in the item’s history.">
            <Textarea value={note} onChange={setNote} rows={2} />
          </Field>
          {!gate.ready && <p className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</p>}
          {error !== null && (
            <p className={writeStyles.failed} role="alert">
              <Icon name="triangle-alert" size={14} />
              <span>{error.message}</span>
            </p>
          )}
        </div>
      </Form>
    </Dialog>
  );
}
