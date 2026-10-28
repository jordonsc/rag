import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  ErrorState,
  Icon,
  Input,
  Panel,
  Segmented,
  Select,
  Spinner,
  Table,
  useFormat,
  type Column,
} from '@rag/ui';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { isProjectName, listItems, PROJECT_NAME_ERROR } from './api';
import { ProjectTabs } from './docParts';
import styles from './history.module.css';
import { hasLabel, labelsIn, normaliseLabel } from './labels';
import { LabelChips, labelQuery, StatusDot, TypeBadge } from './parts';
import { itemPath, storeLastProject } from './paths';
import { ProjectPicker } from './ProjectPicker';
import { useScrollMemory } from './scrollMemory';
import frame from './tracker.module.css';
import { ITEM_TYPES, type Item, type ItemType } from './types';
import { itemStatusLabel, itemTypeLabel } from './vocab';

/**
 * The statuses this page lists, in the order its filter offers them.
 *
 * `failed` is still in the queue (it is drawn on the dashboard too), but it is
 * an end of the work as much as `done` and `cancelled` are, so it is listed
 * here beside them.
 */
export const HISTORY_STATUSES = ['done', 'cancelled', 'failed'] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

function isHistoryStatus(value: string | null): value is HistoryStatus {
  return (HISTORY_STATUSES as readonly string[]).includes(value ?? '');
}

function isItemType(value: string | null): value is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(value ?? '');
}

/**
 * When an item finished, and which field says so.
 *
 * **Only `done` has a time of its own** (`done_at`, api.md § Ticket). The
 * tracker records no cancel or fail time on the item, so a cancelled or failed
 * item is placed by `updated_at`, its last change: that is the cancel itself
 * unless something was written to the item afterwards (a note, an edit). The
 * page says so in its note and on each such stamp, rather than presenting a
 * last change as a cancel time. A `done` item without `done_at` cannot happen
 * on the wire; it falls back the same way rather than sorting as the epoch.
 */
export function finishedAt(item: Item): { at: string; field: 'done_at' | 'updated_at' } {
  if (item.status === 'done' && item.done_at !== null) {
    return { at: item.done_at, field: 'done_at' };
  }
  return { at: item.updated_at, field: 'updated_at' };
}

/**
 * Newest first by `finishedAt`, then by id descending (a later id was minted
 * later). RFC 3339 UTC stamps compare as strings.
 */
export function byFinishedDesc(a: Item, b: Item): number {
  const at = finishedAt(b).at.localeCompare(finishedAt(a).at);
  return at !== 0 ? at : b.id.localeCompare(a.id);
}

/** Whether an item holds `text`: its id, title, body or assignee, ignoring case. */
export function matchesText(item: Item, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return [item.id, item.title, item.body, item.assignee ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

type Loaded =
  { kind: 'loading' } | { kind: 'ready'; items: Item[] } | { kind: 'error'; error: LedgerApiError };

/** The route: a project name the server would refuse never becomes a request. */
export function HistoryView() {
  const { project = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <History key={project} project={project} />;
}

/**
 * A project's history (rag-t0008): its **done** (acknowledged or not),
 * **cancelled** and **failed** items, newest first by when they finished.
 *
 * Nothing in the tracker is deleted — Remove cancels — but once an item is
 * cancelled, or done and acknowledged, the dashboard no longer draws it. This
 * is the way back to it: every row opens the item page, which has Reopen.
 *
 * One `GET /tracker/{project}/items?status=…` per status, in parallel; the
 * filters (status, type, label, text) narrow on the client and live in the URL
 * (`?status=`, `?type=`, `?label=`, `?q=`), so a reload or a shared link keeps
 * them. The label filter (rag-t0027) offers the labels the finished items
 * carry and matches case-insensitively; each item's labels are drawn under
 * its title. The
 * list is not polled: it is a record, not a work surface, and the item page
 * is where anything is changed.
 */
function History({ project }: { project: string }) {
  const navigate = useNavigate();
  const format = useFormat();
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const rawType = params.get('type');
  const status: HistoryStatus | '' = isHistoryStatus(rawStatus) ? rawStatus : '';
  const type: ItemType | '' = isItemType(rawType) ? rawType : '';
  const label = normaliseLabel(params.get('label') ?? '');
  const [text, setText] = useState(params.get('q') ?? '');
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Back from an item lands where the reader left the list (rag-t0040).
  useScrollMemory(`history:${project}`, loaded.kind === 'ready');

  useEffect(() => storeLastProject(project), [project]);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ kind: 'loading' });
    Promise.all(HISTORY_STATUSES.map((s) => listItems(project, s, controller.signal)))
      .then((responses) =>
        setLoaded({ kind: 'ready', items: responses.flatMap((response) => response.items) }),
      )
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [project, attempt]);

  /** Set or clear one filter in the URL, keeping the others. */
  const setParam = (key: 'status' | 'type' | 'label' | 'q', value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === '') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const all = useMemo(
    () => (loaded.kind === 'ready' ? [...loaded.items].sort(byFinishedDesc) : []),
    [loaded],
  );
  // The status counts follow the type and text filters but not the status
  // filter itself, so each segment says what choosing it would show.
  const narrowed = useMemo(
    () =>
      all.filter(
        (item) =>
          (type === '' || item.type === type) && hasLabel(item, label) && matchesText(item, text),
      ),
    [all, type, label, text],
  );
  const rows = useMemo(
    () => (status === '' ? narrowed : narrowed.filter((item) => item.status === status)),
    [narrowed, status],
  );
  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const item of narrowed) {
      by[item.status] = (by[item.status] ?? 0) + 1;
    }
    return by;
  }, [narrowed]);

  const columns: Array<Column<Item>> = [
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      value: (item) => item.status,
      render: (item) => <StatusDot state={item.status} />,
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      value: (item) => item.type,
      render: (item) => <TypeBadge type={item.type} />,
    },
    {
      key: 'title',
      header: 'Ticket',
      identity: true,
      prose: true,
      sortable: true,
      value: (item) => item.title,
      render: (item) => (
        <span className={styles.identity}>
          {/* A link as well as a clickable row: the row is the mouse's, the
              link the keyboard's and the middle button's. It stops its click
              so the row does not navigate a second time. */}
          <Link
            to={itemPath(project, item.id)}
            className={styles.itemTitle}
            onClick={(event) => event.stopPropagation()}
          >
            {item.title}
          </Link>
          <code className={styles.itemId}>{item.id}</code>
          <LabelChips project={project} labels={item.labels ?? []} to={labelQuery} />
        </span>
      ),
    },
    {
      key: 'finished',
      header: 'Finished',
      sortable: true,
      // The raw RFC 3339 string: zero-padded UTC sorts as text; the formatted
      // value would sort by day-of-month.
      value: (item) => finishedAt(item).at,
      render: (item) => {
        const { at, field } = finishedAt(item);
        return (
          <span
            className={styles.stamp}
            data-field={field}
            title={
              field === 'updated_at'
                ? 'Last change: the tracker records no cancel or fail time'
                : undefined
            }
          >
            {format.stamp(at)}
            {field === 'updated_at' && <span className={styles.stampNote}> (last change)</span>}
          </span>
        );
      },
    },
    {
      key: 'acknowledged',
      header: 'Acknowledged',
      sortable: true,
      value: (item) => item.acknowledged_at ?? '',
      render: (item) =>
        item.status !== 'done' ? (
          <span className={styles.stamp}>—</span>
        ) : item.acknowledged_at === null ? (
          <span className={styles.unacked}>Not yet</span>
        ) : (
          <span className={styles.stamp}>{format.stamp(item.acknowledged_at)}</span>
        ),
    },
  ];

  const statusOptions = [
    {
      value: '',
      label: loaded.kind === 'ready' ? `All · ${narrowed.length}` : 'All',
    },
    ...HISTORY_STATUSES.map((s) => ({
      value: s,
      label:
        loaded.kind === 'ready' ? `${itemStatusLabel(s)} · ${counts[s] ?? 0}` : itemStatusLabel(s),
    })),
  ];
  const typeOptions = [
    { value: '', label: 'All types' },
    ...ITEM_TYPES.map((t) => ({ value: t, label: itemTypeLabel(t) })),
  ];
  const labelOptions = [
    { value: '', label: 'All labels' },
    ...labelsIn(all, label).map((value) => ({ value, label: value })),
  ];
  const filtered = status !== '' || type !== '' || label !== '' || text.trim() !== '';

  return (
    <div className={frame.view}>
      <header className={frame.head}>
        <div className={frame.headTitle}>
          <Icon name="history" size={18} />
          <h1 className={frame.title}>{project} history</h1>
        </div>
        <div className={frame.headControls}>
          <ProjectTabs project={project} active="history" />
          <span className={frame.picker}>
            <ProjectPicker current={project} />
          </span>
        </div>
      </header>

      <Panel
        header={loaded.kind === 'ready' ? `Finished tickets · ${rows.length}` : 'Finished tickets'}
        actions={
          <div className={styles.filterField}>
            <Input
              value={text}
              onChange={(value) => {
                setText(value);
                setParam('q', value.trim());
              }}
              placeholder="Narrow by id, title or text"
              aria-label="Narrow the history"
              type="search"
            />
          </div>
        }
        padded={false}
      >
        <p className={styles.note}>
          Done, cancelled and failed tickets, newest first. Nothing in the tracker is deleted:
          Remove cancels a ticket, and it is kept here. Open a ticket to read its history or reopen
          it. Done tickets are placed by when they were done; cancelled and failed tickets by their
          last change, because the tracker records no cancel or fail time, so a note written
          afterwards moves one up.
        </p>

        <div className={styles.filters}>
          <Segmented
            value={status}
            onChange={(value) => setParam('status', value)}
            options={statusOptions}
            label="Status"
          />
          <span className={styles.typeField}>
            <Select
              value={type}
              onChange={(value) => setParam('type', value)}
              options={typeOptions}
              aria-label="Type"
            />
          </span>
          {labelOptions.length > 1 && (
            <span className={styles.typeField}>
              <Select
                value={
                  labelOptions.find((o) => o.value.toLowerCase() === label.toLowerCase())?.value ??
                  ''
                }
                onChange={(value) => setParam('label', value)}
                options={labelOptions}
                aria-label="Label"
              />
            </span>
          )}
        </div>

        {loaded.kind === 'loading' && (
          <div className={styles.loading}>
            <Spinner size={18} />
            <span>Loading {project}’s history…</span>
          </div>
        )}

        {loaded.kind === 'error' && (
          <ErrorState
            message={`Could not load ${project}’s history.`}
            detail={loaded.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}

        {loaded.kind === 'ready' && (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(item) => item.id}
            empty={
              filtered
                ? 'No finished ticket matches these filters.'
                : 'Nothing has been done, cancelled or failed yet.'
            }
            defaultSort={{ key: 'finished', dir: 'desc' }}
            onRowClick={(item) => navigate(itemPath(project, item.id))}
          />
        )}
      </Panel>
    </div>
  );
}
