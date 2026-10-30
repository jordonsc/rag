import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Select,
  Spinner,
  Toggle,
  useFormat,
} from '@rag/ui';
import { Link, useParams, useSearchParams } from 'react-router';

import { asApiError } from '../api';
import { cx } from '../util';
import { ackDone, isProjectName, moveItem, PROJECT_NAME_ERROR, updateItem } from './api';
import {
  AddGateDialog,
  AddItemDialog,
  AddRequestDialog,
  ApprovalDialog,
  MakeDraftDialog,
  NoteDialog,
  PublishDialog,
  SEND_BACK_NOTE_ROWS,
  type ApprovalAction,
} from './dialogs';
import { ProjectTabs } from './docParts';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { hasLabel, labelsIn, normaliseLabel } from './labels';
import { ApprovalControl, DraftBadge, SecondLine, StatusDot, WaitsOn } from './parts';
import { itemPath, storeLastProject } from './paths';
import { ProjectPicker } from './ProjectPicker';
import { GateMarker, QueueList } from './QueueList';
import styles from './tracker.module.css';
import type { Item, Place } from './types';
import { useScrollMemory } from './scrollMemory';
import { useQueue } from './useQueue';
import { blockReasonLabel, dotState, type DotState } from './vocab';

type Notice = { tone: 'warn' | 'crit'; text: string };

/**
 * Put the keyboard on a row after a write from it. The control it was pressed
 * on goes when the row re-reads (a ratified badge is no longer a button), and
 * focus on a removed element falls to the page. A queue row takes focus
 * itself; a Done, Review, Blocked or Deferred row's title link does: both
 * outlive the re-read.
 */
function refocusRow(id: string) {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-id]')).find(
    (node) => node.dataset.id === id,
  );
  const active = document.activeElement;
  // Only when the reader is still on that row, or nowhere: never pull focus
  // from wherever they have moved on to while the queue re-read.
  if (row === undefined || (active !== null && active !== document.body && !row.contains(active))) {
    return;
  }
  (row.tabIndex >= 0 ? row : row.querySelector<HTMLElement>('a'))?.focus();
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

interface FlatRowProps {
  project: string;
  item: Item;
  state: DotState;
  /** The first line's right end: the approval and the section's own actions. */
  actions: ReactNode;
  /** The second line's left, after the type and the assignee. */
  detail?: ReactNode;
  /** A block note, under both lines. */
  note?: string | null;
}

/**
 * A Done, Review, Blocked or Deferred row (rag-t0026): two lines, as a queue
 * row is, without the grip or the menu. Line one is the status, the id, the
 * title and the actions (the approval, then the section's button: Confirm and
 * Send back, Unblock, Resume); line two the type, the assignee, a block and
 * what it waits on, and the labels at the right (no link chips: rag-t0031).
 * A block note, when there is one, is a third line.
 */
function FlatRow({ project, item, state, actions, detail, note }: FlatRowProps) {
  return (
    <li
      className={cx(styles.flatRow, item.status === 'in_progress' && styles.rowInProgress)}
      data-id={item.id}
    >
      <span className={styles.cellStatus}>
        <StatusDot state={state} slotted />
      </span>
      <code className={styles.cellId}>{item.id}</code>
      <Link to={itemPath(project, item.id)} className={styles.cellTitle}>
        {item.title}
      </Link>
      <span className={styles.cellMeta}>{actions}</span>
      <SecondLine project={project} item={item}>
        {detail}
      </SecondLine>
      {note !== undefined && note !== null && note !== '' && (
        <p className={styles.blockNote}>{note}</p>
      )}
    </li>
  );
}

/** A blocked item's reason (or the bare word) and what it waits on. */
function BlockDetail({ project, item }: { project: string; item: Item }) {
  if (!item.blocked) {
    return null;
  }
  return (
    <>
      <Badge tone="warn">
        {item.block_reason === null ? 'Blocked' : blockReasonLabel(item.block_reason)}
      </Badge>
      <WaitsOn project={project} ids={item.depends_on ?? []} />
    </>
  );
}

/** The route: a project name that the server would refuse never becomes a request. */
export function QueueView() {
  const { project = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <Dashboard key={project} project={project} />;
}

/**
 * A project's dashboard (D14, R12): the owner's view of the queue, modelled on
 * the manager's status report.
 *
 * Top to bottom: **Done** (green, oldest first, the latest finished last,
 * in the server's order: rag-t0029; until *Acknowledge all done*;
 * a done gate is the queue's marker line, in green: rag-t0021),
 * **Drafts** (a dashed edge: the owner's tickets not yet published, any type,
 * each with *Publish*; the feed leaves their changes out and nothing
 * dispatches them; a queue row's menu has *Make draft*: 2026-10-30),
 * **Requests** (the accent: the owner's ideas waiting for the manager to break
 * them into tickets, whatever their status; filed with *Add request* in the
 * header, never in the queue: rag-t0044),
 * **Review** (red, work waiting on the owner to confirm or review it, each
 * with *Confirm* and *Send back*; rag-t0024), **the queue** in list order (blue in progress, white pending, red failed;
 * gates as full-width markers), **Blocked** (amber, each with its reason,
 * its note and *Unblock*) and **Deferred** (teal, work put aside on purpose,
 * each with *Resume*; rag-t0017). A review, blocked or deferred item keeps its
 * place in the list and is drawn only in its own section, never in the queue
 * (R9); an item both blocked and deferred, or blocked and in review, is drawn
 * under its status's section, its block beside it.
 *
 * Every row is two lines (rag-t0026; see {@link FlatRow} and `QueueList`), and
 * an in-progress row is tinted blue (rag-t0023). The second line carries the
 * item's labels at its right end (rag-t0027, moved there by rag-t0031), each
 * a link to this page filtered to it. No row draws link chips (rag-t0031):
 * an item's links are on its page; a blocked row's *waits on* stays, as the
 * reason it is blocked.
 *
 * **Filters**: *Unratified only*, and a **label** (rag-t0027) held in the URL
 * (`?label=Physics`, matched case-insensitively), so a reload or a shared
 * link keeps it. A label filter keeps the queue's gates, so the reader still
 * sees which batch each labelled item sits in. Either filter turns reordering
 * off: the hidden rows are neighbours too.
 *
 * **Approval from the row** (rag-t0009): an *Agent-approved* badge, in any
 * section, is a button that asks to ratify it; an unapproved item in the queue
 * or under Review, Blocked or Deferred has an *Approve*. Each opens a confirmation (the note
 * optional) and the row re-reads after.
 *
 * It refreshes every 10 s while the tab is visible and at once after the
 * viewer's own write (`useQueue`). Writes re-read; nothing is patched in
 * place, except that a dropped row is shown where it was dropped until the
 * server has answered the move.
 */
function Dashboard({ project }: { project: string }) {
  const { state, refresh } = useQueue(project);
  // Back from an item lands where the reader left the queue (rag-t0040): put
  // back once the rows are drawn, and only once, so a refresh never moves it.
  useScrollMemory(`queue:${project}`, state.kind === 'ready');
  const gate = useTrackerGate();
  const format = useFormat();

  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [unratified, setUnratified] = useState(false);
  const [adding, setAdding] = useState<'item' | 'gate' | 'request' | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [unblocking, setUnblocking] = useState<Item | null>(null);
  const [deferring, setDeferring] = useState<Item | null>(null);
  const [resuming, setResuming] = useState<Item | null>(null);
  const [publishing, setPublishing] = useState<Item | null>(null);
  const [drafting, setDrafting] = useState<Item | null>(null);
  const [confirming, setConfirming] = useState<Item | null>(null);
  const [sendingBack, setSendingBack] = useState<Item | null>(null);
  const [approving, setApproving] = useState<{ item: Item; action: ApprovalAction } | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const [acking, setAcking] = useState(false);
  const [params, setParams] = useSearchParams();
  const label = normaliseLabel(params.get('label') ?? '');

  /** Set or clear the label filter in the URL, keeping any other parameter. */
  const setLabel = (value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === '') {
          next.delete('label');
        } else {
          next.set('label', value);
        }
        return next;
      },
      { replace: true },
    );
  };

  useEffect(() => storeLastProject(project), [project]);

  // After the approval dialog has closed: its own focus restore (an effect
  // cleanup) has run by now, so this lands last.
  useEffect(() => {
    if (refocus !== null) {
      refocusRow(refocus);
      setRefocus(null);
    }
  }, [refocus]);

  const move = useCallback(
    (item: Item, place: Place, order: string[]) => {
      if (gate.fields === null) {
        gate.prompt();
        return;
      }
      setNotice(null);
      setPendingOrder(order);
      moveItem(item.id, place, gate.fields)
        .then(() => refresh())
        .catch((cause: unknown) => {
          setNotice({
            tone: 'crit',
            text: `${item.id} was not moved: ${asApiError(cause).message} The list shows the server’s order.`,
          });
          return refresh();
        })
        .finally(() => setPendingOrder(null));
    },
    [gate, refresh],
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
      text: 'The queue changed while you were dragging, so nothing was moved. This is the server’s order now.',
    });
  }, []);

  const acknowledge = () => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    setAcking(true);
    setNotice(null);
    ackDone(project, gate.fields)
      .then(() => refresh())
      .catch((cause: unknown) => {
        setNotice({ tone: 'crit', text: `Not acknowledged: ${asApiError(cause).message}` });
      })
      .finally(() => setAcking(false));
  };

  const view = state.kind === 'ready' ? state.view : null;
  const keep = useCallback(
    (item: Item) => (!unratified || item.approval === 'agent') && hasLabel(item, label),
    [unratified, label],
  );
  // The queue's gates stay through a label filter: they say which batch the
  // labelled work is in. The unratified filter applies to them as before.
  const keepInQueue = useCallback(
    (item: Item) =>
      item.type === 'gate' && label !== '' ? !unratified || item.approval === 'agent' : keep(item),
    [keep, unratified, label],
  );
  const queue = useMemo(
    () => (view === null ? [] : inOrder(view.queue, pendingOrder).filter(keepInQueue)),
    [view, pendingOrder, keepInQueue],
  );
  const done = useMemo(() => (view === null ? [] : view.done.filter(keep)), [view, keep]);
  const blocked = useMemo(() => (view === null ? [] : view.blocked.filter(keep)), [view, keep]);
  const deferred = useMemo(
    () => (view === null ? [] : (view.deferred ?? []).filter(keep)),
    [view, keep],
  );
  const review = useMemo(
    () => (view === null ? [] : (view.review ?? []).filter(keep)),
    [view, keep],
  );
  const requests = useMemo(
    () => (view === null ? [] : (view.requests ?? []).filter(keep)),
    [view, keep],
  );
  const drafts = useMemo(
    () => (view === null ? [] : (view.drafts ?? []).filter(keep)),
    [view, keep],
  );

  if (state.kind === 'loading') {
    return (
      <div className={styles.loading}>
        <Spinner size={18} />
        <span>Loading {project}…</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <Card>
        <ErrorState
          message={`Could not load ${project}.`}
          detail={state.error.message}
          onRetry={() => void refresh()}
        />
      </Card>
    );
  }

  const full = state.view;
  const gates = queue.filter((item) => item.type === 'gate').length;
  const unratifiedCount = [
    ...full.done,
    ...(full.drafts ?? []),
    ...(full.requests ?? []),
    ...(full.review ?? []),
    ...full.queue,
    ...full.blocked,
    ...(full.deferred ?? []),
  ].filter((item) => item.approval === 'agent').length;
  const reorderHint =
    pendingOrder !== null
      ? 'A move is being saved.'
      : unratified || label !== ''
        ? 'Reordering is off while the list is filtered: the hidden rows are its neighbours too.'
        : undefined;
  const labelOptions = [
    { value: '', label: 'All labels' },
    ...labelsIn(
      [
        ...full.done,
        ...(full.drafts ?? []),
        ...(full.requests ?? []),
        ...(full.review ?? []),
        ...full.queue,
        ...full.blocked,
        ...(full.deferred ?? []),
      ],
      label,
    ).map((value) => ({ value, label: value })),
  ];
  const queueEmpty =
    label !== ''
      ? `No ticket labelled ${label} in the queue`
      : unratified
        ? 'No unratified approvals in the queue'
        : 'The queue is empty';

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div className={styles.headTitle}>
          <Icon name="list-todo" size={18} />
          <h1 className={styles.title}>{project}</h1>
        </div>
        <div className={styles.headControls}>
          <ProjectTabs project={project} active="queue" />
          <span className={styles.picker}>
            <ProjectPicker current={project} />
          </span>
          <Toggle
            checked={unratified}
            onChange={setUnratified}
            label={`Unratified only (${unratifiedCount})`}
          />
          {labelOptions.length > 1 && (
            <span className={styles.labelFilter}>
              <Select
                value={
                  labelOptions.find((o) => o.value.toLowerCase() === label.toLowerCase())?.value ??
                  ''
                }
                onChange={setLabel}
                options={labelOptions}
                aria-label="Label"
              />
            </span>
          )}
          <Button size="sm" variant="accent" onClick={() => setAdding('request')}>
            <Icon name="message-square" size={14} />
            Add request
          </Button>
        </div>
      </header>

      {state.error !== null && (
        <p className={cx(styles.notice, styles.notice_warn)} role="status">
          <Icon name="triangle-alert" size={14} />
          <span>Could not refresh: {state.error.message} Showing the last good view.</span>
        </p>
      )}
      {notice !== null && (
        <p className={cx(styles.notice, styles[`notice_${notice.tone}`])} role="alert">
          <Icon name={notice.tone === 'crit' ? 'octagon-alert' : 'info'} size={14} />
          <span>{notice.text}</span>
          <button
            type="button"
            className={styles.noticeClose}
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <Icon name="x" size={12} />
          </button>
        </p>
      )}
      {!full.exists && (
        <p className={styles.notice}>
          <Icon name="info" size={14} />
          <span>
            Nothing has been written to <code>{project}</code> yet. Its first ticket creates it.
          </span>
        </p>
      )}

      {done.length > 0 && (
        <section className={cx(styles.section, styles.section_done)} aria-label="Done">
          <header className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Done <span className={styles.count}>{done.length}</span>
            </h2>
            <Button size="sm" onClick={acknowledge} loading={acking}>
              <Icon name="check-check" size={14} />
              {gate.ready ? 'Acknowledge all done' : 'Set your email to acknowledge'}
            </Button>
          </header>
          <ul className={styles.flat}>
            {done.map((item) =>
              item.type === 'gate' ? (
                <li
                  key={item.id}
                  className={cx(styles.marker, styles.markerDone)}
                  data-id={item.id}
                  aria-label={`Gate ${item.id}: ${item.title}`}
                >
                  <GateMarker project={project} item={item} variant="done" />
                </li>
              ) : (
                <FlatRow
                  key={item.id}
                  project={project}
                  item={item}
                  state="done"
                  actions={
                    <>
                      <ApprovalControl
                        id={item.id}
                        approval={item.approval}
                        onRatify={() => approve(item, 'ratify')}
                      />
                      {item.done_at !== null && (
                        <time className={styles.when} dateTime={item.done_at}>
                          {format.stamp(item.done_at)}
                        </time>
                      )}
                    </>
                  }
                />
              ),
            )}
          </ul>
        </section>
      )}

      {drafts.length > 0 && (
        <section className={cx(styles.section, styles.section_drafts)} aria-label="Drafts">
          <header className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Drafts <span className={styles.count}>{drafts.length}</span>
            </h2>
          </header>
          <ul className={styles.flat}>
            {drafts.map((item) => (
              <FlatRow
                key={item.id}
                project={project}
                item={item}
                state={dotState(item)}
                actions={
                  <>
                    <ApprovalControl
                      id={item.id}
                      approval={item.approval}
                      onRatify={() => approve(item, 'ratify')}
                      onApprove={() => approve(item, 'approve')}
                    />
                    <Button
                      size="sm"
                      aria-label={`Publish ${item.id}`}
                      onClick={() => setPublishing(item)}
                    >
                      <Icon name="eye" size={14} />
                      Publish
                    </Button>
                  </>
                }
                detail={
                  <>
                    <DraftBadge />
                    <BlockDetail project={project} item={item} />
                  </>
                }
                note={item.blocked ? item.block_note : null}
              />
            ))}
          </ul>
        </section>
      )}

      {requests.length > 0 && (
        <section className={cx(styles.section, styles.section_requests)} aria-label="Requests">
          <header className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Requests <span className={styles.count}>{requests.length}</span>
            </h2>
          </header>
          <ul className={styles.flat}>
            {requests.map((item) => (
              <FlatRow
                key={item.id}
                project={project}
                item={item}
                state={dotState(item)}
                actions={
                  <ApprovalControl
                    id={item.id}
                    approval={item.approval}
                    onRatify={() => approve(item, 'ratify')}
                    onApprove={() => approve(item, 'approve')}
                  />
                }
                detail={<BlockDetail project={project} item={item} />}
                note={item.blocked ? item.block_note : null}
              />
            ))}
          </ul>
        </section>
      )}

      {review.length > 0 && (
        <section className={cx(styles.section, styles.section_review)} aria-label="Review">
          <header className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Review <span className={styles.count}>{review.length}</span>
            </h2>
          </header>
          <ul className={styles.flat}>
            {review.map((item) => (
              <FlatRow
                key={item.id}
                project={project}
                item={item}
                state={dotState(item)}
                actions={
                  <>
                    <ApprovalControl
                      id={item.id}
                      approval={item.approval}
                      onRatify={() => approve(item, 'ratify')}
                      onApprove={() => approve(item, 'approve')}
                    />
                    <Button
                      size="sm"
                      variant="good"
                      aria-label={`Confirm ${item.id}`}
                      onClick={() => setConfirming(item)}
                    >
                      <Icon name="check" size={14} />
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="caution"
                      aria-label={`Send back ${item.id}`}
                      onClick={() => setSendingBack(item)}
                    >
                      <Icon name="rotate-ccw" size={14} />
                      Send back
                    </Button>
                  </>
                }
                detail={<BlockDetail project={project} item={item} />}
                note={item.blocked ? item.block_note : null}
              />
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section} aria-label="Queue">
        <header className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            Queue{' '}
            <span className={styles.count}>
              {queue.length - gates} {queue.length - gates === 1 ? 'ticket' : 'tickets'}
              {gates > 0 && ` · ${gates} ${gates === 1 ? 'gate' : 'gates'}`}
            </span>
          </h2>
          <div className={styles.sectionActions}>
            <Button size="sm" onClick={() => setAdding('item')}>
              <Icon name="plus" size={14} />
              Add ticket
            </Button>
            <Button size="sm" onClick={() => setAdding('gate')}>
              <Icon name="flag" size={14} />
              Add gate
            </Button>
          </div>
        </header>
        {queue.length === 0 || (label !== '' && queue.length === gates) ? (
          <EmptyState
            icon="list-todo"
            title={queueEmpty}
            message={
              unratified || label !== ''
                ? undefined
                : 'Add ticket and Add gate put work at the bottom.'
            }
          />
        ) : (
          <QueueList
            project={project}
            items={queue}
            reorderable={reorderHint === undefined}
            {...(reorderHint === undefined ? {} : { reorderHint })}
            revision={state.revision}
            onMove={move}
            onRemove={setRemoving}
            onDefer={setDeferring}
            onDraft={setDrafting}
            onApproval={approve}
            onInterrupted={interrupted}
          />
        )}
        {!gate.ready && <p className={styles.gateNote}>{TRACKER_IDENTITY_NEEDED}</p>}
      </section>

      {blocked.length > 0 && (
        <section className={cx(styles.section, styles.section_blocked)} aria-label="Blocked">
          <header className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Blocked <span className={styles.count}>{blocked.length}</span>
            </h2>
          </header>
          <ul className={styles.flat}>
            {blocked.map((item) => (
              <FlatRow
                key={item.id}
                project={project}
                item={item}
                state="blocked"
                actions={
                  <>
                    <ApprovalControl
                      id={item.id}
                      approval={item.approval}
                      onRatify={() => approve(item, 'ratify')}
                      onApprove={() => approve(item, 'approve')}
                    />
                    <Button size="sm" onClick={() => setUnblocking(item)}>
                      <Icon name="lock-open" size={14} />
                      Unblock
                    </Button>
                  </>
                }
                detail={<BlockDetail project={project} item={item} />}
                note={item.block_note}
              />
            ))}
          </ul>
        </section>
      )}

      {deferred.length > 0 && (
        <section className={cx(styles.section, styles.section_deferred)} aria-label="Deferred">
          <header className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Deferred <span className={styles.count}>{deferred.length}</span>
            </h2>
          </header>
          <ul className={styles.flat}>
            {deferred.map((item) => (
              <FlatRow
                key={item.id}
                project={project}
                item={item}
                state={dotState(item)}
                actions={
                  <>
                    <ApprovalControl
                      id={item.id}
                      approval={item.approval}
                      onRatify={() => approve(item, 'ratify')}
                      onApprove={() => approve(item, 'approve')}
                    />
                    <Button size="sm" onClick={() => setResuming(item)}>
                      <Icon name="circle-play" size={14} />
                      Resume
                    </Button>
                  </>
                }
                detail={<BlockDetail project={project} item={item} />}
                note={item.blocked ? item.block_note : null}
              />
            ))}
          </ul>
        </section>
      )}

      <AddItemDialog
        open={adding === 'item'}
        project={project}
        onCancel={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          void refresh();
        }}
      />
      <AddRequestDialog
        open={adding === 'request'}
        project={project}
        onCancel={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          void refresh();
        }}
      />
      <AddGateDialog
        open={adding === 'gate'}
        project={project}
        onCancel={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          void refresh();
        }}
      />
      <NoteDialog
        project={project}
        open={removing !== null}
        title={removing?.type === 'gate' ? 'Remove this gate?' : 'Remove this ticket?'}
        {...(removing === null ? {} : { subject: removing })}
        message={
          <p>
            It is cancelled: it leaves the queue and the dashboard, and stays in its history.
            Reopening it later puts it back at the top.
          </p>
        }
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onSubmit={(note, fields) => updateItem(removing!.id, { status: 'cancelled', note }, fields)}
        onDone={() => {
          setRemoving(null);
          void refresh();
        }}
      />
      <ApprovalDialog
        project={project}
        action={approving?.action ?? null}
        subject={approving?.item ?? null}
        onCancel={() => setApproving(null)}
        onDone={() => {
          setRefocus(approving?.item.id ?? null);
          setApproving(null);
          void refresh();
        }}
      />
      <NoteDialog
        project={project}
        open={unblocking !== null}
        title="Unblock this ticket?"
        {...(unblocking === null ? {} : { subject: unblocking })}
        message={<p>It goes back into the queue at the place it kept while blocked.</p>}
        confirmLabel="Unblock"
        onCancel={() => setUnblocking(null)}
        onSubmit={(note, fields) => updateItem(unblocking!.id, { blocked: false, note }, fields)}
        onDone={() => {
          setUnblocking(null);
          void refresh();
        }}
      />
      <NoteDialog
        project={project}
        open={deferring !== null}
        title={deferring?.type === 'gate' ? 'Defer this gate?' : 'Defer this ticket?'}
        {...(deferring === null ? {} : { subject: deferring })}
        message={
          <p>
            It moves to Deferred and keeps its place in the queue, so resuming puts it back where it
            was. Nothing picks it up while it is deferred.
          </p>
        }
        confirmLabel="Defer"
        onCancel={() => setDeferring(null)}
        onSubmit={(note, fields) => updateItem(deferring!.id, { status: 'deferred', note }, fields)}
        onDone={() => {
          setDeferring(null);
          void refresh();
        }}
      />
      <NoteDialog
        project={project}
        open={confirming !== null}
        title={confirming?.type === 'gate' ? 'Confirm this gate?' : 'Confirm this ticket?'}
        {...(confirming === null ? {} : { subject: confirming })}
        message={
          <p>It is done: it leaves the queue and shows under Done until you acknowledge it.</p>
        }
        confirmLabel="Confirm"
        onCancel={() => setConfirming(null)}
        onSubmit={(note, fields) => updateItem(confirming!.id, { status: 'done', note }, fields)}
        onDone={() => {
          setConfirming(null);
          void refresh();
        }}
      />
      <NoteDialog
        project={project}
        open={sendingBack !== null}
        title={sendingBack?.type === 'gate' ? 'Send this gate back?' : 'Send this ticket back?'}
        {...(sendingBack === null ? {} : { subject: sendingBack })}
        message={<p>It goes back to in progress at the place it kept while in review.</p>}
        noteRows={SEND_BACK_NOTE_ROWS}
        confirmLabel="Send back"
        onCancel={() => setSendingBack(null)}
        onSubmit={(note, fields) =>
          updateItem(sendingBack!.id, { status: 'in_progress', note }, fields)
        }
        onDone={() => {
          setSendingBack(null);
          void refresh();
        }}
      />
      <PublishDialog
        project={project}
        item={publishing}
        onCancel={() => setPublishing(null)}
        onDone={() => {
          setPublishing(null);
          void refresh();
        }}
      />
      <MakeDraftDialog
        project={project}
        item={drafting}
        onCancel={() => setDrafting(null)}
        onDone={() => {
          setDrafting(null);
          void refresh();
        }}
      />
      <NoteDialog
        project={project}
        open={resuming !== null}
        title={resuming?.type === 'gate' ? 'Resume this gate?' : 'Resume this ticket?'}
        {...(resuming === null ? {} : { subject: resuming })}
        message={<p>It goes back to pending at the place it kept while deferred.</p>}
        confirmLabel="Resume"
        onCancel={() => setResuming(null)}
        onSubmit={(note, fields) => updateItem(resuming!.id, { status: 'pending', note }, fields)}
        onDone={() => {
          setResuming(null);
          void refresh();
        }}
      />
    </div>
  );
}
