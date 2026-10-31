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
  Toggle,
} from '@rag/ui';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { listItems, updateItem } from './api';
import { AttachTextarea, useAttachments } from './attach';
import {
  ApprovalDialog,
  LABELS_HELP,
  MakeDraftDialog,
  NoteDialog,
  PARALLEL_LABEL,
  PublishDialog,
  SEND_BACK_NOTE_ROWS,
} from './dialogs';
import { useSaveShortcut } from './saveShortcut';
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
  | 'publish'
  | 'makeDraft'
  | 'edit';

export interface ItemActionsProps {
  item: Item;
  /** The write landed: re-read the item. */
  onWritten: () => void;
}

const REASON_OPTIONS = BLOCK_REASONS.map((value) => ({ value, label: blockReasonLabel(value) }));

/**
 * The item page's writes (D15): note, status, block or unblock, defer or
 * resume (rag-t0017), confirm or send back an item in review (rag-t0024; on
 * a second row of their own, green and amber: rag-t0041),
 * approve or ratify, edit, and publish a draft or make one (2026-10-30: a
 * draft's Publish is a row of its own, first, as the thing to do next).
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
    <div className={styles.actionRows}>
      {item.draft === true && (
        <div className={writeStyles.actions} role="group" aria-label="Draft">
          <Button size="sm" variant="accent" onClick={show('publish')}>
            <Icon name="eye" size={14} />
            Publish
          </Button>
        </div>
      )}
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
        {item.draft !== true && item.queued && (
          <Button size="sm" variant="ghost" onClick={show('makeDraft')}>
            <Icon name="eye-off" size={14} />
            Make draft
          </Button>
        )}
        <Button size="sm" onClick={show('edit')}>
          <Icon name="pencil" size={14} />
          Edit…
        </Button>
        {!gate.ready && <span className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</span>}
      </div>
      {/* The owner's verdict on work in review, on a row of its own under the
          rest: Confirm in the done green, Send back in the blocked amber
          (rag-t0041). */}
      {item.status === 'review' && (
        <div className={writeStyles.actions} role="group" aria-label="Review">
          <Button size="sm" variant="good" onClick={show('confirm')}>
            <Icon name="check" size={14} />
            Confirm
          </Button>
          <Button size="sm" variant="caution" onClick={show('sendBack')}>
            <Icon name="rotate-ccw" size={14} />
            Send back
          </Button>
        </div>
      )}

      <NoteDialog
        project={item.project}
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
        project={item.project}
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
        project={item.project}
        open={open === 'block'}
        title="Block this ticket"
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
            help="Tickets of this project. It unblocks itself when the last of them is done; a cancelled one never frees it."
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
                candidates === null ? 'Loading the tickets…' : 'Find a ticket by id or title'
              }
            />
          </Field>
        )}
      </NoteDialog>
      <NoteDialog
        project={item.project}
        open={open === 'unblock'}
        title="Unblock this ticket?"
        subject={subject}
        message={<p>It goes back into the queue at the place it kept while blocked.</p>}
        confirmLabel="Unblock"
        onCancel={close}
        onSubmit={send({ blocked: false })}
        onDone={done}
      />
      <NoteDialog
        project={item.project}
        open={open === 'defer'}
        title="Defer this ticket?"
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
        project={item.project}
        open={open === 'resume'}
        title="Resume this ticket?"
        subject={subject}
        message={<p>It goes back to pending at the place it kept while deferred.</p>}
        confirmLabel="Resume"
        onCancel={close}
        onSubmit={send({ status: 'pending' })}
        onDone={done}
      />
      <NoteDialog
        project={item.project}
        open={open === 'confirm'}
        title="Confirm this ticket?"
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
        project={item.project}
        open={open === 'sendBack'}
        title="Send this ticket back?"
        subject={subject}
        message={<p>It goes back to in progress at the place it kept while in review.</p>}
        noteRows={SEND_BACK_NOTE_ROWS}
        confirmLabel="Send back"
        onCancel={close}
        onSubmit={send({ status: 'in_progress' })}
        onDone={done}
      />
      <ApprovalDialog
        project={item.project}
        action={open === 'ratify' || open === 'approve' ? open : null}
        subject={subject}
        onCancel={close}
        onDone={done}
      />
      <NoteDialog
        project={item.project}
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
      <PublishDialog
        project={item.project}
        item={open === 'publish' ? item : null}
        onCancel={close}
        onDone={done}
      />
      <MakeDraftDialog
        project={item.project}
        item={open === 'makeDraft' ? item : null}
        onCancel={close}
        onDone={done}
      />
      {open === 'edit' && (
        <EditItemDialog item={item} onCancel={close} onDone={done} onSavedInPlace={onWritten} />
      )}
    </div>
  );
}

// ---- Edit -------------------------------------------------------------------

/**
 * The link kinds an edit may add (rag-t0044): never `became`, which the
 * server writes on a request as the reverse of a ticket's `from`, and no
 * `from` on a request, which comes from no other.
 */
export function addableLinkKinds(type: Item['type']): LinkKind[] {
  return LINK_KINDS.filter((kind) => kind !== 'became' && !(kind === 'from' && type === 'request'));
}
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
  /** Ctrl+S landed and the dialog stays open: the page re-reads the ticket. */
  onSavedInPlace: () => void;
}

/**
 * Edit the title, body, assignee, labels (rag-t0027) and links, a gate's
 * intensity and release, and whether any other item is parallel (rag-t0013).
 *
 * Save saves and closes; **Ctrl+S saves on the spot and stays** (owner,
 * 2026-10-31). What is compared against then moves to the ticket as saved, so
 * the next save sends only what changed after it.
 */
function EditItemDialog({ item: opened, onCancel, onDone, onSavedInPlace }: EditItemDialogProps) {
  const gate = useTrackerGate();
  // The ticket as it was when the dialog opened. The page re-reads it live
  // while the dialog is up; diffing the draft against that newer copy would
  // send back, as an edit, whatever someone else changed meanwhile. A save on
  // the spot (Ctrl+S) moves it to the ticket that save returned.
  const [item, setItem] = useState(opened);
  const [savedInPlace, setSavedInPlace] = useState(false);
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
  const kindOptions = addableLinkKinds(item.type).map((value) => ({
    value,
    label: linkKindLabel(value),
  }));
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  // The body and the note each take files (rag-t0053); Save waits for both.
  const bodyFiles = useAttachments(item.project, setBody);
  const noteFiles = useAttachments(item.project, setNote);
  const uploading = bodyFiles.uploads + noteFiles.uploads > 0;
  const root = useRef<HTMLDivElement>(null);

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

  const save = (stay: boolean) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (busy || uploading || title.trim() === '') {
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
    const sentNote = note;
    updateItem(
      item.id,
      { ...sent, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      gate.fields,
    )
      .then((saved) => {
        setBusy(false);
        if (!stay) {
          onDone();
          return;
        }
        setItem(saved);
        // The server keeps a project's casing of a label: take it, or the set
        // would read as changed for ever. Labels changed meanwhile stay.
        setLabels((now) => (sameLabels(now, chosen.labels) ? (saved.labels ?? []) : now));
        // A note is said once; one being written meanwhile stays.
        setNote((now) => (now === sentNote ? '' : now));
        setSavedInPlace(true);
        onSavedInPlace();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };
  const submit = () => save(false);
  // Ctrl+S saves and stays (2026-10-31), and does nothing while Save is disabled.
  useSaveShortcut(
    true,
    gate.ready && !busy && !uploading && !unchanged ? () => save(true) : null,
    root,
  );

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
          <Button
            variant="primary"
            loading={busy}
            disabled={unchanged || uploading}
            onClick={submit}
          >
            {gate.ready ? 'Save' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody} ref={root}>
          <Field label="Title" error={title.trim() === '' ? 'A ticket needs a title.' : undefined}>
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
          {item.type !== 'gate' && item.type !== 'request' && (
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
            <AttachTextarea value={body} onChange={setBody} attacher={bodyFiles} rows={10} />
          </Field>
          <Field label="Links">
            <div className={styles.linkEditor}>
              {links.length > 0 && (
                <ul className={styles.linkList}>
                  {links.map((link) => (
                    <li key={`${link.kind}:${link.target}`} className={styles.linkEdit}>
                      <span className={styles.linkKind}>{linkKindLabel(link.kind)}</span>
                      <code>{link.target}</code>
                      {/* A became link is the server's: it goes with its ticket's from link. */}
                      {link.kind !== 'became' && (
                        <IconButton
                          icon="x"
                          label={`Remove link ${link.target}`}
                          variant="ghost"
                          size={14}
                          onClick={() => setLinks(links.filter((had) => !sameLink(had, link)))}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.linkAdd}>
                <Select
                  value={kind}
                  onChange={(value) => setKind(value as LinkKind)}
                  options={kindOptions}
                  aria-label="Link kind"
                />
                <Input
                  value={target}
                  onChange={setTarget}
                  placeholder={
                    kind === 'milestone' ? 'spec/m01' : kind === 'ledger' ? 'rag-l0042' : ''
                  }
                  aria-label="Link target"
                />
                <Button size="sm" onClick={addLink} disabled={target.trim() === ''}>
                  Add link
                </Button>
              </div>
            </div>
          </Field>
          <Field label="Note" help="Optional: why, kept in the ticket’s history.">
            <AttachTextarea value={note} onChange={setNote} attacher={noteFiles} rows={2} />
          </Field>
          {savedInPlace && unchanged && <p role="status">Saved.</p>}
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
