/**
 * The record a document belongs to, on the document page (m04, TC-02): a
 * concept's state, approval and links; a spec's state, approval and
 * milestones; a milestone's spec, state and approval. With their writes:
 * **State…**, **Approve** / **Ratify** / **Withdraw approval** (each with an
 * optional note, D7 as amended 2026-10-27, D10) and, on a concept, **Links…**.
 *
 * From the web an approval is the owner's (`owner`), or the owner's
 * ratification of an agent's (`agent` → `ratified`), as on the item page.
 */

import { useState } from 'react';
import {
  Button,
  Dialog,
  Field,
  Form,
  Icon,
  IconButton,
  Input,
  Panel,
  Select,
  useFormat,
} from '@rag/ui';
import { Link } from 'react-router';

import { asApiError, type LedgerApiError } from '../api';
import writeStyles from '../writes/writes.module.css';
import { updateConcept, updateMilestone, updateSpec } from './api';
import { AttachTextarea, useAttachments } from './attach';
import { NoteDialog } from './dialogs';
import { StateBadge } from './docParts';
import styles from './docs.module.css';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import itemStyles from './item.module.css';
import { ApprovalBadge, LinkChips } from './parts';
import { docPath } from './paths';
import {
  CONCEPT_STATES,
  LINK_KINDS,
  MILESTONE_STATES,
  SPEC_STATES,
  type Approval,
  type Concept,
  type ConceptState,
  type Link as RecordLink,
  type LinkKind,
  type Milestone,
  type MilestoneState,
  type Spec,
  type SpecState,
  type TrackerAuthor,
} from './types';
import { approvalLabel, linkKindLabel, recordStateLabel } from './vocab';

/** The record a document belongs to. A free-standing document has none. */
export type DocRecord =
  | { kind: 'concept'; record: Concept }
  | { kind: 'spec'; record: Spec }
  | { kind: 'milestone'; record: Milestone };

interface Change {
  state?: string;
  approval?: Approval;
  add_links?: RecordLink[];
  remove_links?: RecordLink[];
  note?: string;
}

function send(target: DocRecord, change: Change, fields: TrackerAuthor): Promise<unknown> {
  switch (target.kind) {
    case 'concept': {
      const { state, ...rest } = change;
      return updateConcept(
        target.record.project,
        target.record.slug,
        { ...rest, ...(state === undefined ? {} : { state: state as ConceptState }) },
        fields,
      );
    }
    case 'spec': {
      const { state, approval, note } = change;
      return updateSpec(
        target.record.project,
        target.record.slug,
        {
          ...(state === undefined ? {} : { state: state as SpecState }),
          ...(approval === undefined ? {} : { approval }),
          ...(note === undefined ? {} : { note }),
        },
        fields,
      );
    }
    case 'milestone': {
      const { state, approval, note } = change;
      return updateMilestone(
        target.record.project,
        target.record.spec,
        target.record.code,
        {
          ...(state === undefined ? {} : { state: state as MilestoneState }),
          ...(approval === undefined ? {} : { approval }),
          ...(note === undefined ? {} : { note }),
        },
        fields,
      );
    }
  }
}

function statesOf(target: DocRecord): readonly string[] {
  return target.kind === 'concept'
    ? CONCEPT_STATES
    : target.kind === 'spec'
      ? SPEC_STATES
      : MILESTONE_STATES;
}

const NOUN: Record<DocRecord['kind'], string> = {
  concept: 'concept',
  spec: 'spec',
  milestone: 'milestone',
};

type Open = 'state' | 'approve' | 'ratify' | 'withdraw' | 'links';

export interface RecordPanelProps {
  target: DocRecord;
  /** A write landed: re-read the record. */
  onWritten: () => void;
}

export function RecordPanel({ target, onWritten }: RecordPanelProps) {
  const gate = useTrackerGate();
  const format = useFormat();
  const [open, setOpen] = useState<Open | null>(null);
  const record = target.record;
  const others = statesOf(target).filter((state) => state !== record.state);
  const [state, setState] = useState<string>(others[0] ?? '');
  const noun = NOUN[target.kind];
  const subject = {
    id:
      target.kind === 'milestone'
        ? `${target.record.spec}/${target.record.code}`
        : target.record.slug,
    title: record.title,
  };

  const show = (which: Open) => () => {
    if (!gate.ready) {
      gate.prompt();
      return;
    }
    if (which === 'state') {
      setState(others[0] ?? '');
    }
    setOpen(which);
  };
  const close = () => setOpen(null);
  const done = () => {
    setOpen(null);
    onWritten();
  };
  const noteHelp = `Why, when it is not obvious from the change. It is kept in the ${noun}’s history.`;

  return (
    <Panel header={`${noun[0]!.toUpperCase()}${noun.slice(1)}`}>
      <div className={styles.record}>
        <dl className={styles.facts}>
          <div>
            <dt>State</dt>
            <dd>
              <StateBadge state={record.state} />
            </dd>
          </div>
          <div>
            <dt>Approval</dt>
            <dd>
              <ApprovalBadge approval={record.approval} always />
            </dd>
          </div>
          {target.kind === 'milestone' && (
            <>
              <div>
                <dt>Spec</dt>
                <dd>
                  <Link to={docPath(record.project, `specs/${target.record.spec}/master.md`)}>
                    {target.record.spec}
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Milestone</dt>
                <dd>
                  <code className={styles.mono}>{target.record.code}</code>
                </dd>
              </div>
            </>
          )}
          {target.kind === 'concept' && (
            <div>
              <dt>Links</dt>
              <dd>
                {target.record.links.length === 0 ? (
                  'none'
                ) : (
                  <LinkChips project={record.project} links={target.record.links} max={12} />
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>Updated</dt>
            <dd>{format.stamp(record.updated_at)}</dd>
          </div>
        </dl>

        {target.kind === 'spec' && (
          <div>
            <p className={styles.toolbarNote}>
              {target.record.milestones.length === 0
                ? 'No milestones: a small spec is its master document alone.'
                : `${target.record.milestones.length} ${target.record.milestones.length === 1 ? 'milestone' : 'milestones'}`}
            </p>
            {target.record.milestones.length > 0 && (
              <ul className={styles.rows} aria-label="Milestones">
                {target.record.milestones.map((milestone) => (
                  <li key={milestone.code} className={styles.docRow} data-code={milestone.code}>
                    <code className={styles.code}>{milestone.code}</code>
                    <Link to={docPath(record.project, milestone.path)} className={styles.docTitle}>
                      {milestone.title}
                    </Link>
                    <span className={styles.docMeta}>
                      <StateBadge state={milestone.state} />
                      <ApprovalBadge approval={milestone.approval} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className={writeStyles.actions}>
          {others.length > 0 && (
            <Button size="sm" onClick={show('state')}>
              <Icon name="circle-dot" size={14} />
              State…
            </Button>
          )}
          {record.approval === 'agent' && (
            <Button size="sm" variant="accent" onClick={show('ratify')}>
              <Icon name="shield-check" size={14} />
              Ratify
            </Button>
          )}
          {record.approval === 'unapproved' && (
            <Button size="sm" variant="accent" onClick={show('approve')}>
              <Icon name="shield-check" size={14} />
              Approve
            </Button>
          )}
          {(record.approval === 'owner' || record.approval === 'ratified') && (
            <Button size="sm" variant="ghost" onClick={show('withdraw')}>
              Withdraw approval
            </Button>
          )}
          {target.kind === 'concept' && (
            <Button size="sm" onClick={show('links')}>
              <Icon name="link" size={14} />
              Links…
            </Button>
          )}
          {!gate.ready && <span className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</span>}
        </div>
      </div>

      <NoteDialog
        project={target.record.project}
        open={open === 'state'}
        title={`Change the ${noun}’s state`}
        subject={subject}
        noteHelp={noteHelp}
        confirmLabel="Change state"
        onCancel={close}
        onSubmit={(note, fields) => send(target, { state, note }, fields)}
        onDone={done}
      >
        <Field label="New state">
          <Select
            value={state}
            onChange={setState}
            options={others.map((value) => ({ value, label: recordStateLabel(value) }))}
          />
        </Field>
      </NoteDialog>
      <NoteDialog
        project={target.record.project}
        open={open === 'approve'}
        title="Approve as the owner?"
        subject={subject}
        message={
          <p>
            Records the owner’s approval: <strong>{approvalLabel('owner')}</strong>. A record, not a
            lock: nothing is refused either way.
          </p>
        }
        noteHelp={noteHelp}
        confirmLabel="Approve"
        onCancel={close}
        onSubmit={(note, fields) => send(target, { approval: 'owner', note }, fields)}
        onDone={done}
      />
      <NoteDialog
        project={target.record.project}
        open={open === 'ratify'}
        title="Ratify the agent’s approval?"
        subject={subject}
        message={
          <p>
            An agent approved this. Ratifying records that you, the owner, confirm it:{' '}
            <strong>{approvalLabel('ratified')}</strong>.
          </p>
        }
        noteHelp={noteHelp}
        confirmLabel="Ratify"
        onCancel={close}
        onSubmit={(note, fields) => send(target, { approval: 'ratified', note }, fields)}
        onDone={done}
      />
      <NoteDialog
        project={target.record.project}
        open={open === 'withdraw'}
        title="Withdraw the approval?"
        subject={subject}
        message={<p>Sets the approval back to {approvalLabel('unapproved').toLowerCase()}.</p>}
        noteHelp={noteHelp}
        confirmLabel="Withdraw"
        danger
        onCancel={close}
        onSubmit={(note, fields) => send(target, { approval: 'unapproved', note }, fields)}
        onDone={done}
      />
      {open === 'links' && target.kind === 'concept' && (
        <LinksDialog concept={target.record} onCancel={close} onDone={done} />
      )}
    </Panel>
  );
}

// ---- A concept's links ------------------------------------------------------

/** A concept links to records; `from` and `became` are between items (rag-t0044). */
const KIND_OPTIONS = LINK_KINDS.filter((value) => value !== 'from' && value !== 'became').map(
  (value) => ({ value, label: linkKindLabel(value) }),
);

function sameLink(a: RecordLink, b: RecordLink): boolean {
  return a.kind === b.kind && a.target === b.target;
}

/** Add and remove a concept's links: the specs and ledger topics it became. */
function LinksDialog({
  concept,
  onCancel,
  onDone,
}: {
  concept: Concept;
  onCancel: () => void;
  onDone: () => void;
}) {
  const gate = useTrackerGate();
  const [links, setLinks] = useState<RecordLink[]>(concept.links);
  const [kind, setKind] = useState<LinkKind>('spec');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const noteFiles = useAttachments(concept.project, setNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const added = links.filter((link) => !concept.links.some((had) => sameLink(had, link)));
  const removed = concept.links.filter((had) => !links.some((link) => sameLink(had, link)));
  const unchanged = added.length === 0 && removed.length === 0;

  const add = () => {
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
    if (busy || noteFiles.uploads > 0 || unchanged) {
      return;
    }
    setBusy(true);
    setError(null);
    send(
      { kind: 'concept', record: concept },
      {
        ...(added.length === 0 ? {} : { add_links: added }),
        ...(removed.length === 0 ? {} : { remove_links: removed }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      },
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
      title={`Links of ${concept.slug}`}
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
            {gate.ready ? 'Save links' : 'Set your email'}
          </Button>
        </>
      }
    >
      <Form onSubmit={submit}>
        <div className={writeStyles.dialogBody}>
          <div className={itemStyles.linkEditor}>
            {links.length > 0 && (
              <ul className={itemStyles.linkList}>
                {links.map((link) => (
                  <li key={`${link.kind}:${link.target}`} className={itemStyles.linkEdit}>
                    <span className={itemStyles.linkKind}>{linkKindLabel(link.kind)}</span>
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
            <div className={itemStyles.linkAdd}>
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
                  kind === 'milestone' ? 'spec/m01' : kind === 'ledger' ? 'rag-l0042' : ''
                }
                aria-label="Link target"
              />
              <Button size="sm" onClick={add} disabled={target.trim() === ''}>
                Add link
              </Button>
            </div>
          </div>
          <Field label="Note" help="Optional: why, kept in the concept’s history.">
            <AttachTextarea value={note} onChange={setNote} attacher={noteFiles} rows={2} />
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
