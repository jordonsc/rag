import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  Form,
  Icon,
  Input,
  Panel,
  Spinner,
  useFormat,
} from '@rag/ui';
import { Link, useParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { Markdown } from '../markdown/Markdown';
import { cx } from '../util';
import writeStyles from '../writes/writes.module.css';
import {
  archivePhase,
  getPhase,
  isProjectName,
  moveItem,
  PROJECT_NAME_ERROR,
  unarchivePhase,
  updateItem,
  updatePhase,
} from './api';
import { AttachTextarea, useAttachments } from './attach';
import {
  AddGateDialog,
  AddItemDialog,
  ApprovalDialog,
  MakeDraftDialog,
  NoteDialog,
  PublishDialog,
  RecallDialog,
  ReleaseDialog,
  WaitingList,
  type ApprovalAction,
} from './dialogs';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import itemStyles from './item.module.css';
import { EventTimeline } from './ItemView';
import { ApprovalBadge, BlockDetail, DraftBadge, PageNotice } from './parts';
import { projectPath, roadmapPath, storeLastProject } from './paths';
import { PhaseTitlesProvider } from './phaseTitles';
import { QueueList } from './QueueList';
import { FlatRow } from './QueueView';
import styles from './roadmap.module.css';
import { useSaveShortcut } from './saveShortcut';
import { RETURN_STATE } from './scrollMemory';
import frame from './tracker.module.css';
import type { Item, Phase, PhaseOutcome, PhaseRecord, PhaseUpdate, Place } from './types';
import { useFeedRefresh } from './useFeed';
import { dotState, itemStatusLabel, phaseStateLabel, phaseStateTone, type DotState } from './vocab';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; phase: PhaseRecord }
  | { kind: 'error'; error: LedgerApiError };

/** What a write said it moved, shown until dismissed. */
type Written = { text: string; outcome: PhaseOutcome };

type Notice = { tone: 'warn' | 'crit'; text: string };

/** The groups a released phase's tickets are drawn in, in order (RM-45). */
const OPEN_GROUPS: readonly DotState[] = [
  'in_progress',
  'review',
  // Not in RM-45's list, which would lose them: a failed ticket is still in the queue.
  'failed',
  'pending',
  'blocked',
  'deferred',
];
const FOLDED_GROUPS: readonly DotState[] = ['done', 'cancelled'];

/** A group's section edge, as the dashboard draws the same status. */
const GROUP_EDGE: Partial<Record<DotState, string | undefined>> = {
  review: frame.section_review,
  blocked: frame.section_blocked,
  deferred: frame.section_deferred,
};

function ticketCount(n: number): string {
  return `${n} ${n === 1 ? 'ticket' : 'tickets'}`;
}

/** A release's `placed` as a phrase: `at the top`, `before demo-t0001`. */
function placedWords(placed: string | null): string {
  return placed === 'top' || placed === 'bottom' ? `at the ${placed}` : (placed ?? 'at the bottom');
}

function samePhase(a: PhaseRecord, b: PhaseRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The queue in `order`, any id the order does not name kept at the end. */
function inOrder(items: readonly Item[], order: readonly string[] | null): Item[] {
  if (order === null) {
    return [...items];
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const placed = order.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const named = new Set(order);
  return [...placed, ...items.filter((item) => !named.has(item.id))];
}

/** The route: a project name the server would refuse never becomes a request. */
export function PhaseView() {
  const { project = '', id = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <PhasePage key={`${project}:${id}`} project={project} id={id} />;
}

/**
 * One phase (spec:roadmap D29, RM-45): its title and body, editable; its frozen
 * tickets, sortable, and Add ticket; its released tickets by status; Release or
 * Recall behind a confirmation that states the count and any warning; Archive
 * or Unarchive; its history, folded.
 *
 * Live as the ticket page is: any event in the project's feed re-reads it,
 * settled, and a read that says nothing new does not re-render. A frozen ticket
 * cannot be deferred (D5), so its menu has no Defer. Nothing here is optimistic
 * but a dropped row, shown where it was dropped until the server answers.
 */
function PhasePage({ project, id }: { project: string; id: string }) {
  const gate = useTrackerGate();
  const format = useFormat();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [written, setWritten] = useState<Written | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<'item' | 'gate' | null>(null);
  const [acting, setActing] = useState<'release' | 'recall' | 'archive' | 'unarchive' | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [drafting, setDrafting] = useState<Item | null>(null);
  const [publishing, setPublishing] = useState<Item | null>(null);
  const [approving, setApproving] = useState<{ item: Item; action: ApprovalAction } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState<Partial<Record<DotState, boolean>>>({});

  /** Read the phase. `quiet` is a live re-read: when it fails, what is on screen stays. */
  const load = useCallback(
    async (quiet: boolean) => {
      const seq = ++latest.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      try {
        const phase = await getPhase(project, id, { tickets: true, history: true }, abort.signal);
        if (seq !== latest.current) {
          return;
        }
        setLoaded((prev) =>
          prev.kind === 'ready' && samePhase(prev.phase, phase) ? prev : { kind: 'ready', phase },
        );
      } catch (error) {
        if (isAbort(error) || seq !== latest.current) {
          return;
        }
        setLoaded((prev) =>
          quiet && prev.kind === 'ready' ? prev : { kind: 'error', error: asApiError(error) },
        );
      }
    },
    [project, id],
  );

  useEffect(() => {
    void load(false);
    return () => {
      latest.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  useEffect(() => storeLastProject(project), [project]);
  useFeedRefresh(project, () => void load(true));

  /** The response to every write here: read the phase again, by id. */
  const refetch = useCallback(() => load(false), [load]);

  const move = useCallback(
    (item: Item, place: Place, order: string[]) => {
      if (gate.fields === null) {
        gate.prompt();
        return;
      }
      setNotice(null);
      setPendingOrder(order);
      moveItem(item.id, place, gate.fields)
        .then(() => refetch())
        .catch((cause: unknown) => {
          setNotice({
            tone: 'crit',
            text: `${item.id} was not moved: ${asApiError(cause).message} The list shows the server’s order.`,
          });
          return refetch();
        })
        .finally(() => setPendingOrder(null));
    },
    [gate, refetch],
  );

  const approve = useCallback(
    (item: Item, action: ApprovalAction) => {
      if (!gate.ready) {
        gate.prompt();
        return;
      }
      setApproving({ item, action });
    },
    [gate],
  );

  const interrupted = useCallback(() => {
    setNotice({
      tone: 'warn',
      text: 'The phase changed while you were dragging, so nothing was moved. This is the server’s order now.',
    });
  }, []);

  const tickets = loaded.kind === 'ready' ? (loaded.phase.tickets ?? []) : [];
  const frozen = useMemo(() => tickets.filter((ticket) => ticket.frozen === true), [tickets]);
  const shownFrozen = useMemo(() => inOrder(frozen, pendingOrder), [frozen, pendingOrder]);
  const serverOrder = useMemo(() => frozen.map((ticket) => ticket.id).join(' '), [frozen]);
  const unfrozen = useMemo(() => tickets.filter((ticket) => ticket.frozen !== true), [tickets]);

  const rowDetail = useCallback(
    (item: Item): ReactNode => (
      <>
        {item.draft === true && <DraftBadge />}
        <BlockDetail project={project} item={item} />
      </>
    ),
    [project],
  );

  if (loaded.kind === 'loading') {
    return (
      <div className={frame.loading}>
        <Spinner size={18} />
        <span>Loading {id}…</span>
      </div>
    );
  }

  if (loaded.kind === 'error') {
    return (
      <Card>
        <ErrorState
          message={
            loaded.error.status === 404
              ? `There is no phase ${id} in ${project}.`
              : `Could not load ${id}.`
          }
          detail={loaded.error.message}
          onRetry={() => void refetch()}
        />
      </Card>
    );
  }

  const phase = loaded.phase;
  const planned = phase.state === 'planned';
  const released = phase.state === 'released';
  const archived = phase.state === 'archived';
  const guarded = (action: () => void) => () => {
    if (gate.ready) {
      action();
    } else {
      gate.prompt();
    }
  };
  const groupOf = (state: DotState) => unfrozen.filter((ticket) => dotState(ticket) === state);
  const addLabel = planned ? 'Add to this phase' : 'Add to the bottom of the queue';
  const addButtons = (
    <div className={frame.sectionActions}>
      <Button size="sm" onClick={() => setAdding('item')}>
        <Icon name="plus" size={14} />
        Add ticket
      </Button>
      <Button size="sm" onClick={() => setAdding('gate')}>
        <Icon name="flag" size={14} />
        Add gate
      </Button>
    </div>
  );
  const row = (item: Item, state: DotState) => (
    <FlatRow
      key={item.id}
      project={project}
      item={item}
      state={state}
      actions={
        <>
          <ApprovalBadge approval={item.approval} />
          {item.done_at !== null && (
            <time className={frame.when} dateTime={item.done_at}>
              {format.stamp(item.done_at)}
            </time>
          )}
        </>
      }
      detail={rowDetail(item)}
      note={item.blocked ? item.block_note : null}
    />
  );

  return (
    // Every ticket here is this phase's: a chip on each row would say nothing.
    <PhaseTitlesProvider project={project} enabled={false} omit={phase.id}>
      <article className={itemStyles.view}>
        <p className={itemStyles.crumbs}>
          <Link to={roadmapPath(project)} state={RETURN_STATE}>
            <Icon name="arrow-left" size={13} />
            {project} roadmap
          </Link>
        </p>

        <header className={itemStyles.header}>
          <div className={itemStyles.identity}>
            <Icon name="map" size={14} />
            <Badge tone={phaseStateTone(phase.state)}>{phaseStateLabel(phase.state)}</Badge>
            {phase.size.complete && <Badge tone="good">Complete</Badge>}
            <code className={itemStyles.id}>{phase.id}</code>
          </div>
          <h1 className={itemStyles.title}>{phase.title}</h1>
          <dl className={itemStyles.meta}>
            <div>
              <dt>Project</dt>
              <dd>
                <Link to={projectPath(project)} state={RETURN_STATE}>
                  {project}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Tickets</dt>
              <dd>
                {`${phase.size.total} in all`}
                {phase.size.drafts > 0 &&
                  `, ${phase.size.drafts} ${phase.size.drafts === 1 ? 'draft' : 'drafts'}`}
                {phase.size.blocked > 0 && `, ${phase.size.blocked} blocked`}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{format.stamp(phase.created_at)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{format.stamp(phase.updated_at)}</dd>
            </div>
            {phase.released_at !== null && (
              <div>
                <dt>Released</dt>
                <dd>{format.stamp(phase.released_at)}</dd>
              </div>
            )}
          </dl>
        </header>

        <div className={writeStyles.actions}>
          {planned && (
            <Button size="sm" variant="accent" onClick={guarded(() => setActing('release'))}>
              <Icon name="rocket" size={14} />
              Release
            </Button>
          )}
          {released && (
            <Button size="sm" variant="caution" onClick={guarded(() => setActing('recall'))}>
              <Icon name="rotate-ccw" size={14} />
              Recall
            </Button>
          )}
          <Button size="sm" onClick={guarded(() => setEditing(true))}>
            <Icon name="pencil" size={14} />
            Edit…
          </Button>
          {archived ? (
            <Button size="sm" onClick={guarded(() => setActing('unarchive'))}>
              <Icon name="archive-restore" size={14} />
              Unarchive
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={guarded(() => setActing('archive'))}>
              <Icon name="archive" size={14} />
              Archive
            </Button>
          )}
          {!gate.ready && <span className={writeStyles.gate}>{TRACKER_IDENTITY_NEEDED}</span>}
        </div>

        {notice !== null && (
          <PageNotice tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </PageNotice>
        )}
        {written !== null && (
          <PageNotice onDismiss={() => setWritten(null)}>
            {written.text}
            <WaitingList project={project} pairs={written.outcome.waiting} />
          </PageNotice>
        )}

        <Panel header="Body">
          {phase.body.trim() === '' ? (
            <p className={itemStyles.empty}>No body.</p>
          ) : (
            <Markdown source={phase.body} attachments className={styles.body} />
          )}
        </Panel>

        {planned && (
          <section className={frame.section} aria-label="Frozen tickets">
            <header className={frame.sectionHead}>
              <h2 className={frame.sectionTitle}>
                Frozen tickets <span className={frame.count}>{frozen.length}</span>
              </h2>
              {addButtons}
            </header>
            {shownFrozen.length === 0 ? (
              <EmptyState
                icon="map"
                title="No frozen tickets"
                message="Add ticket puts work here, out of the queue, until the phase is released."
              />
            ) : (
              <QueueList
                project={project}
                items={shownFrozen}
                label="Frozen tickets"
                reorderable={pendingOrder === null}
                {...(pendingOrder === null ? {} : { reorderHint: 'A move is being saved.' })}
                revision={serverOrder}
                onMove={move}
                onRemove={setRemoving}
                onDraft={setDrafting}
                onPublish={setPublishing}
                onApproval={approve}
                onInterrupted={interrupted}
                rowDetail={rowDetail}
              />
            )}
          </section>
        )}

        {released && unfrozen.length === 0 && (
          <section className={frame.section} aria-label="Released tickets">
            <header className={frame.sectionHead}>
              <h2 className={frame.sectionTitle}>Released tickets</h2>
              {addButtons}
            </header>
            <EmptyState
              icon="map"
              title="No tickets"
              message="Add ticket puts work straight into the queue, linked to this phase."
            />
          </section>
        )}

        {/* Linked and out of the phase's list: released, or, in a planned phase, pulled. */}
        {unfrozen.length > 0 && (
          <div className={styles.groupHead}>
            <h2 className={frame.sectionTitle}>
              {planned ? 'In the queue or finished' : released ? 'Released tickets' : 'Tickets'}{' '}
              <span className={frame.count}>{unfrozen.length}</span>
            </h2>
            {released && addButtons}
          </div>
        )}

        {OPEN_GROUPS.map((state) => {
          const items = groupOf(state);
          return items.length === 0 ? null : (
            <section
              key={state}
              className={cx(frame.section, GROUP_EDGE[state])}
              aria-label={itemStatusLabel(state)}
            >
              <header className={frame.sectionHead}>
                <h3 className={frame.sectionTitle}>
                  {itemStatusLabel(state)} <span className={frame.count}>{items.length}</span>
                </h3>
              </header>
              <ul className={frame.flat}>{items.map((item) => row(item, dotState(item)))}</ul>
            </section>
          );
        })}

        {FOLDED_GROUPS.map((state) => {
          const items = groupOf(state);
          return items.length === 0 ? null : (
            <Disclosure
              key={state}
              title={`${itemStatusLabel(state)} (${items.length})`}
              open={doneOpen[state] === true}
              onToggle={(open) => setDoneOpen((now) => ({ ...now, [state]: open }))}
            >
              <ul className={frame.flat} aria-label={itemStatusLabel(state)}>
                {items.map((item) => row(item, state))}
              </ul>
            </Disclosure>
          );
        })}

        <Disclosure
          title={`History (${phase.events.length})`}
          open={historyOpen}
          onToggle={setHistoryOpen}
        >
          <EventTimeline events={phase.events} />
        </Disclosure>

        {editing && (
          <EditPhaseDialog
            phase={phase}
            onCancel={() => setEditing(false)}
            onDone={() => {
              setEditing(false);
              void refetch();
            }}
            onSavedInPlace={() => void refetch()}
          />
        )}
        <AddItemDialog
          key={`item:${phase.id}`}
          open={adding === 'item'}
          project={project}
          phase={phase.id}
          addLabel={addLabel}
          onCancel={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            void refetch();
          }}
        />
        <AddGateDialog
          open={adding === 'gate'}
          project={project}
          phase={phase.id}
          addLabel={addLabel}
          onCancel={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            void refetch();
          }}
        />
        <ReleaseDialog
          project={project}
          phase={acting === 'release' ? phase : null}
          onCancel={() => setActing(null)}
          onDone={(outcome) => {
            setActing(null);
            setWritten({
              text: `Released: ${ticketCount(outcome.moved)} joined the queue, ${placedWords(outcome.placed)}.`,
              outcome,
            });
            void refetch();
          }}
        />
        <RecallDialog
          project={project}
          phase={acting === 'recall' ? phase : null}
          onCancel={() => setActing(null)}
          onDone={(outcome) => {
            setActing(null);
            setWritten({
              text: `Recalled: ${ticketCount(outcome.moved)} went back to the phase, frozen.`,
              outcome,
            });
            void refetch();
          }}
        />
        <NoteDialog
          project={project}
          open={acting === 'archive'}
          title="Archive this phase?"
          subject={phase}
          message={
            <p>
              {planned
                ? 'It comes off the roadmap. A planned phase with an open ticket cannot be archived: cancel, move or release its tickets first.'
                : 'It leaves the roadmap’s lists. Its tickets stay where they are, keeping the link.'}
            </p>
          }
          noteHelp="Why, when it is not obvious. It is kept in the phase’s history."
          confirmLabel="Archive"
          onCancel={() => setActing(null)}
          onSubmit={(note, fields) => archivePhase(project, phase.id, { note }, fields)}
          onDone={() => {
            setActing(null);
            void refetch();
          }}
        />
        <NoteDialog
          project={project}
          open={acting === 'unarchive'}
          title="Unarchive this phase?"
          subject={phase}
          message={
            <p>
              {phase.released_at === null
                ? 'It goes back on the roadmap, at the bottom, as a planned phase.'
                : 'It goes back to being a released phase.'}
            </p>
          }
          noteHelp="Why, when it is not obvious. It is kept in the phase’s history."
          confirmLabel="Unarchive"
          onCancel={() => setActing(null)}
          onSubmit={(note, fields) => unarchivePhase(project, phase.id, { note }, fields)}
          onDone={() => {
            setActing(null);
            void refetch();
          }}
        />
        <NoteDialog
          project={project}
          open={removing !== null}
          title={removing?.type === 'gate' ? 'Remove this gate?' : 'Remove this ticket?'}
          {...(removing === null ? {} : { subject: removing })}
          message={
            <p>
              It is cancelled: it leaves the phase’s list, and keeps its link and its history.
              Reopening it later puts it at the top of the queue, unfrozen.
            </p>
          }
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onSubmit={(note, fields) =>
            updateItem(removing!.id, { status: 'cancelled', note }, fields)
          }
          onDone={() => {
            setRemoving(null);
            void refetch();
          }}
        />
        <ApprovalDialog
          project={project}
          action={approving?.action ?? null}
          subject={approving?.item ?? null}
          onCancel={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            void refetch();
          }}
        />
        <PublishDialog
          project={project}
          item={publishing}
          onCancel={() => setPublishing(null)}
          onDone={() => {
            setPublishing(null);
            void refetch();
          }}
        />
        <MakeDraftDialog
          project={project}
          item={drafting}
          onCancel={() => setDrafting(null)}
          onDone={() => {
            setDrafting(null);
            void refetch();
          }}
        />
      </article>
    </PhaseTitlesProvider>
  );
}

/** What an edit changes, and nothing else: an unchanged field is not sent. */
export function phaseEditBody(phase: Pick<Phase, 'title' | 'body'>, title: string, body: string) {
  const sent: PhaseUpdate = {};
  if (title.trim() !== phase.title) {
    sent.title = title.trim();
  }
  if (body !== phase.body) {
    sent.body = body;
  }
  return sent;
}

interface EditPhaseDialogProps {
  phase: PhaseRecord;
  onCancel: () => void;
  onDone: () => void;
  /** Ctrl+S landed and the dialog stays open: the page re-reads the phase. */
  onSavedInPlace: () => void;
}

/**
 * Edit a phase's title and body, as the ticket's Edit does: Save saves and closes,
 * **Ctrl+S saves on the spot and stays**. It diffs against the phase as it was when
 * the dialog opened (or as the last save left it), so a change somebody made while
 * it was up is never sent back as the owner's.
 */
function EditPhaseDialog({
  phase: opened,
  onCancel,
  onDone,
  onSavedInPlace,
}: EditPhaseDialogProps) {
  const gate = useTrackerGate();
  const [phase, setPhase] = useState(opened);
  const [title, setTitle] = useState(opened.title);
  const [body, setBody] = useState(opened.body);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const bodyFiles = useAttachments(phase.project, setBody);
  const noteFiles = useAttachments(phase.project, setNote);
  const uploading = bodyFiles.uploads + noteFiles.uploads > 0;
  const root = useRef<HTMLDivElement>(null);

  const changes = phaseEditBody(phase, title, body);
  const unchanged = Object.keys(changes).length === 0;
  const blankTitle = title.trim() === '';

  const save = (stay: boolean) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (busy || uploading || blankTitle || unchanged) {
      return;
    }
    setBusy(true);
    setError(null);
    const sentNote = note;
    updatePhase(
      phase.project,
      phase.id,
      { ...changes, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      gate.fields,
    )
      .then((answer) => {
        setBusy(false);
        if (!stay) {
          onDone();
          return;
        }
        setPhase(answer);
        // A note is said once; one being written meanwhile stays.
        setNote((now) => (now === sentNote ? '' : now));
        setSaved(true);
        onSavedInPlace();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };
  const submit = () => save(false);
  useSaveShortcut(
    true,
    gate.ready && !busy && !uploading && !unchanged && !blankTitle ? () => save(true) : null,
    root,
  );

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Edit ${phase.id}`}
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
          <Field label="Title" error={blankTitle ? 'A phase needs a title.' : undefined}>
            <Input value={title} onChange={setTitle} invalid={blankTitle} />
          </Field>
          <Field label="Body" help="Markdown: what this phase is for.">
            <AttachTextarea value={body} onChange={setBody} attacher={bodyFiles} rows={10} />
          </Field>
          <Field label="Note" help="Optional: why, kept in the phase’s history.">
            <AttachTextarea value={note} onChange={setNote} attacher={noteFiles} rows={2} />
          </Field>
          {saved && unchanged && <p role="status">Saved.</p>}
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
