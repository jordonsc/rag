import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Card, ErrorState, Icon, Panel, Spinner, useFormat } from '@rag/ui';
import { Link, useParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { useIdentity } from '../identity';
import { Markdown } from '../markdown/Markdown';
import timeline from '../views/topic.module.css';
import { getItem } from './api';
import { CopyButton } from './CopyButton';
import { ItemActions } from './ItemActions';
import { LinkTitleText, linkKey, useLinkTitles } from './linkTitles';
import {
  ApprovalBadge,
  DraftBadge,
  LabelChips,
  ParallelBadge,
  StatusDot,
  TypeBadge,
  WaitsOn,
} from './parts';
import { itemPath, linkHref, projectPath } from './paths';
import { RETURN_STATE } from './scrollMemory';
import styles from './item.module.css';
import type { FeedEvent, Item, Link as ItemLink, TrackerEvent } from './types';
import { useProjectFeed } from './useFeed';
import {
  approvalLabel,
  blockReasonLabel,
  dotState,
  eventKindIcon,
  eventKindLabel,
  intensityLabel,
  itemStatusLabel,
  itemTypeHint,
  linkKindIcon,
  linkKindLabel,
  surfaceLabel,
} from './vocab';

type Loaded =
  { kind: 'loading' } | { kind: 'ready'; item: Item } | { kind: 'error'; error: LedgerApiError };

/**
 * How long the page waits after a feed event before re-reading, so that a
 * burst (a drag reorder, an agent's run of writes) costs one read.
 */
export const LIVE_SETTLE_MS = 250;

/** Whether two reads of an item say the same thing (so the page need not re-render). */
function sameItem(a: Item, b: Item): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A `place` field as a sentence: `top`, `bottom`, `{before: id}`, `{after: id}`. */
function placeText(place: unknown): string | null {
  if (place === 'top') {
    return 'to the top';
  }
  if (place === 'bottom') {
    return 'to the bottom';
  }
  if (typeof place === 'object' && place !== null) {
    const record = place as Record<string, unknown>;
    if (typeof record.before === 'string') {
      return `before ${record.before}`;
    }
    if (typeof record.after === 'string') {
      return `after ${record.after}`;
    }
  }
  return null;
}

function linksText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  return value
    .map((link: unknown) => {
      const record = link as Partial<ItemLink>;
      return `${linkKindLabel(String(record.kind))} ${String(record.target)}`;
    })
    .join(', ');
}

/** What an event set, drawn beside the prose that explains it. */
function EventFields({ event }: { event: TrackerEvent }) {
  const f = event.fields;
  const rows: Array<[string, ReactNode]> = [];
  if (typeof f.status === 'string') {
    rows.push(['Status', <StatusDot key="s" state={f.status as Item['status']} />]);
  }
  if (f.blocked === true) {
    rows.push([
      'Blocked',
      typeof f.block_reason === 'string' ? blockReasonLabel(f.block_reason) : 'yes',
    ]);
  } else if (f.blocked === false) {
    rows.push(['Blocked', 'no']);
  } else if (typeof f.block_reason === 'string') {
    rows.push(['Reason', blockReasonLabel(f.block_reason)]);
  }
  // A create records every field, defaults included; only what it chose is news.
  const created = event.kind === 'create';
  if (typeof f.approval === 'string' && !(created && f.approval === 'unapproved')) {
    rows.push(['Approval', approvalLabel(f.approval)]);
  }
  if (
    (typeof f.assignee === 'string' || f.assignee === null) &&
    !(created && (f.assignee === null || f.assignee === ''))
  ) {
    rows.push(['Assignee', f.assignee === null || f.assignee === '' ? 'cleared' : f.assignee]);
  }
  if (typeof f.title === 'string' && !created) {
    rows.push(['Title', f.title]);
  }
  if (typeof f.body === 'string' && !created) {
    rows.push(['Body', 'edited']);
  }
  if (typeof f.intensity === 'string') {
    rows.push(['Intensity', intensityLabel(f.intensity)]);
  }
  if (typeof f.release === 'boolean' && (!created || f.release)) {
    rows.push(['Release', f.release ? 'yes' : 'no']);
  }
  if (typeof f.parallel === 'boolean' && (!created || f.parallel)) {
    rows.push(['Parallel', f.parallel ? 'yes' : 'no']);
  }
  // Drafts (2026-10-30): published, or made a draft again; a create only when it was one.
  if (typeof f.draft === 'boolean' && (!created || f.draft)) {
    rows.push(['Draft', f.draft ? 'yes' : 'no (published)']);
  }
  // Labels (rag-t0027): every change says the whole set; a create only when it had some.
  if (Array.isArray(f.labels) && (!created || f.labels.length > 0)) {
    rows.push(['Labels', f.labels.length === 0 ? 'none' : f.labels.map(String).join(', ')]);
  }
  if (Array.isArray(f.depends_on) && f.depends_on.length > 0) {
    rows.push(['Waits on', f.depends_on.map(String).join(', ')]);
  }
  if (typeof f.unblocked_by === 'string') {
    rows.push(['Done', f.unblocked_by]);
  }
  const place = placeText(f.place);
  if (place !== null) {
    rows.push(['Placed', place]);
  }
  for (const [key, label] of [
    ['links_added', 'Linked'],
    ['links_removed', 'Unlinked'],
  ] as const) {
    const text = linksText(f[key]);
    if (text !== null) {
      rows.push([label, text]);
    }
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className={timeline.changes}>
      {rows.map(([label, value]) => (
        <div key={label} className={timeline.change}>
          <span className={timeline.changeLabel}>{label}</span>
          <span className={timeline.changeValue}>{value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Who wrote an event: the address, and whether it came through the web (the
 * owner at the keyboard) or MCP (an agent, named). D10's whole record of who
 * did what, on every entry.
 */
function EventAuthor({ event, self }: { event: TrackerEvent; self: string | null }) {
  const web = event.surface === 'web';
  const qualifier = web
    ? self !== null && self === event.author_email
      ? 'you, on the web'
      : 'on the web'
    : event.agent;
  return (
    <span className={timeline.who} data-surface={event.surface}>
      <Icon name={web ? 'user' : 'bot'} size={13} />
      {event.author_email}
      <span className={timeline.qualifier}> · {qualifier}</span>
      <span className={styles.surface}>{surfaceLabel(event.surface)}</span>
    </span>
  );
}

type Became = { id: string; item: Item | null };

/**
 * What a request became (rag-t0044): each ticket its manager created from it,
 * by id, with its title and status once read. A ticket that cannot be read
 * (gone, or the read failed) stays as its id, still a link.
 */
function BecameList({
  project,
  ids,
  tick,
}: {
  project: string;
  ids: readonly string[];
  /** Bumped when the feed says one of these tickets changed: read them again. */
  tick: number;
}) {
  const [rows, setRows] = useState<Became[]>(ids.map((id) => ({ id, item: null })));
  const key = ids.join(' ');
  useEffect(() => {
    const controller = new AbortController();
    const wanted = key === '' ? [] : key.split(' ');
    // A row already read stays on screen while it is read again.
    setRows((known) =>
      wanted.map((id) => known.find((row) => row.id === id) ?? { id, item: null }),
    );
    for (const id of wanted) {
      getItem(id, { history: false }, controller.signal)
        .then((item) =>
          setRows((known) => known.map((row) => (row.id === id ? { id, item } : row))),
        )
        .catch(() => {
          // Unread: the row stays its id, which is still a link.
        });
    }
    return () => controller.abort();
  }, [key, tick]);
  return (
    <ul className={styles.became}>
      {rows.map(({ id, item }) => (
        <li key={id} className={styles.becameRow}>
          {item !== null && <StatusDot state={dotState(item)} compact />}
          <Link to={itemPath(project, id)}>
            <code>{id}</code>
          </Link>
          {item !== null && (
            <>
              <TypeBadge type={item.type} />
              <span className={styles.becameTitle}>{item.title}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One item, whole (D15): its record, its body rendered, its links, its history
 * and the writes that act on it. A ticket broken out of a request names it
 * (*From request*), and a request lists what it became (rag-t0044); those
 * two kinds are not repeated under Links.
 *
 * Live: the page follows its project's event feed (`useProjectFeed`) and
 * re-reads the item after any item event there, since an agent's write to
 * this ticket and a move of its neighbours both change what it shows. A read
 * that says nothing new does not re-render, and a failed one keeps the page.
 */
export function ItemView() {
  const { id = '' } = useParams();
  const format = useFormat();
  const { email } = useIdentity();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [becameTick, setBecameTick] = useState(0);
  // Only the newest read may land: one that set out before a write must not
  // paint the ticket from before it over the ticket after it.
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Read the item. `quiet` is a live re-read: when it fails, what is on
   * screen stays (the next event or resync tries again).
   */
  const load = useCallback(
    async (quiet: boolean) => {
      const seq = ++latest.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      try {
        const item = await getItem(id, {}, abort.signal);
        if (seq !== latest.current) {
          return;
        }
        setLoaded((prev) =>
          prev.kind === 'ready' && sameItem(prev.item, item) ? prev : { kind: 'ready', item },
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
    [id],
  );

  /** The response to every write here: read the item again, by id. */
  const refetch = useCallback(() => void load(false), [load]);

  useEffect(() => {
    // A re-read keeps the page on screen; another item does not.
    setLoaded((prev) =>
      prev.kind === 'ready' && prev.item.id === id ? prev : { kind: 'loading' },
    );
    void load(false);
    return () => {
      latest.current += 1;
      controller.current?.abort();
      if (settle.current !== null) {
        clearTimeout(settle.current);
        settle.current = null;
      }
    };
  }, [id, load]);

  // Every link's target is read for its title (rag-t0046); a milestone's
  // read also gives its document's path, which holds the milestone's name and
  // which only its record knows. *Became* reads its own rows (`BecameList`).
  const item = loaded.kind === 'ready' ? loaded.item : null;

  const becameIds = useRef<readonly string[]>([]);
  becameIds.current = (item?.links ?? [])
    .filter((link) => link.kind === 'became')
    .map((link) => link.target);
  const resync = useCallback(() => {
    if (settle.current !== null) {
      clearTimeout(settle.current);
      settle.current = null;
    }
    void load(true);
    setBecameTick((n) => n + 1);
  }, [load]);
  const onFeedEvent = useCallback(
    (event: FeedEvent) => {
      if (event.target_kind !== 'item') {
        return;
      }
      if (becameIds.current.includes(event.target_id)) {
        setBecameTick((n) => n + 1);
      }
      if (settle.current === null) {
        settle.current = setTimeout(() => {
          settle.current = null;
          void load(true);
        }, LIVE_SETTLE_MS);
      }
    },
    [load],
  );
  useProjectFeed(item?.project ?? null, onFeedEvent, resync);
  const titles = useLinkTitles(
    item?.project ?? '',
    (item?.links ?? []).filter((link) => link.kind !== 'became'),
  );
  const milestonePath = (link: ItemLink): string | undefined => {
    const title = titles[linkKey(link)];
    return title?.state === 'ready' ? title.path : undefined;
  };

  if (loaded.kind === 'loading') {
    return (
      <div className={styles.loading}>
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
            loaded.error.status === 404 ? `There is no ticket ${id}.` : `Could not load ${id}.`
          }
          detail={loaded.error.message}
          onRetry={refetch}
        />
      </Card>
    );
  }

  const record = loaded.item;
  const events = record.events ?? [];
  const project = record.project;
  const fromRequests = record.links.filter((link) => link.kind === 'from');
  const became = record.links.filter((link) => link.kind === 'became').map((link) => link.target);
  const otherLinks = record.links.filter((link) => link.kind !== 'from' && link.kind !== 'became');

  return (
    <article className={styles.view}>
      <p className={styles.crumbs}>
        <Link to={projectPath(project)} state={RETURN_STATE}>
          <Icon name="arrow-left" size={13} />
          {project}
        </Link>
      </p>

      <header className={styles.header}>
        <div className={styles.identity}>
          <TypeBadge type={record.type} />
          <StatusDot state={dotState(record)} />
          {dotState(record) === 'blocked' && (
            <span className={styles.underlying}>({itemStatusLabel(record.status)})</span>
          )}
          <code className={styles.id}>{record.id}</code>
          <CopyButton text={record.id} />
          <ApprovalBadge approval={record.approval} always />
          {record.type === 'gate' && record.intensity !== null && (
            <Badge tone="neutral">{intensityLabel(record.intensity)} gate</Badge>
          )}
          {record.release && <Badge tone="acc">Release</Badge>}
          {record.parallel === true && <ParallelBadge />}
          {record.draft === true && <DraftBadge />}
        </div>
        <h1 className={styles.title}>{record.title}</h1>
        {itemTypeHint(record.type) !== undefined && (
          <p className={styles.hint}>{itemTypeHint(record.type)}</p>
        )}
        <dl className={styles.meta}>
          <div>
            <dt>Project</dt>
            <dd>
              <Link to={projectPath(project)} state={RETURN_STATE}>
                {project}
              </Link>
            </dd>
          </div>
          {fromRequests.length > 0 && (
            <div>
              <dt>From request</dt>
              <dd className={styles.neighbours}>
                {fromRequests.map((link) => (
                  <span key={link.target} className={styles.fromRequest}>
                    <Link to={itemPath(project, link.target)}>
                      <code>{link.target}</code>
                    </Link>
                    <LinkTitleText title={titles[linkKey(link)]} />
                  </span>
                ))}
              </dd>
            </div>
          )}
          <div>
            <dt>Assignee</dt>
            <dd>{record.assignee === null || record.assignee === '' ? '—' : record.assignee}</dd>
          </div>
          <div>
            <dt>Labels</dt>
            <dd>
              {(record.labels ?? []).length === 0 ? (
                '—'
              ) : (
                <LabelChips project={project} labels={record.labels ?? []} />
              )}
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{format.stamp(record.created_at)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{format.stamp(record.updated_at)}</dd>
          </div>
          {record.done_at !== null && (
            <div>
              <dt>Done</dt>
              <dd>{format.stamp(record.done_at)}</dd>
            </div>
          )}
          {record.acknowledged_at !== null && (
            <div>
              <dt>Acknowledged</dt>
              <dd>{format.stamp(record.acknowledged_at)}</dd>
            </div>
          )}
          {record.queued && (
            <div>
              <dt>In the queue</dt>
              <dd className={styles.neighbours}>
                {record.prev_id === null ? (
                  'first'
                ) : (
                  <>
                    after{' '}
                    <Link to={itemPath(project, record.prev_id)}>
                      <code>{record.prev_id}</code>
                    </Link>
                  </>
                )}
                {record.next_id !== null && (
                  <>
                    {', before '}
                    <Link to={itemPath(project, record.next_id)}>
                      <code>{record.next_id}</code>
                    </Link>
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>
      </header>

      {record.blocked && (
        <p className={styles.blocked}>
          <Icon name="lock" size={14} />
          <span>
            <strong>
              {record.block_reason === null ? 'Blocked' : blockReasonLabel(record.block_reason)}
            </strong>
            {record.block_note !== null && record.block_note !== '' && <> — {record.block_note}</>}
          </span>
          <WaitsOn project={project} ids={record.depends_on ?? []} />
        </p>
      )}

      <ItemActions key={`actions:${record.id}`} item={record} onWritten={refetch} />

      <Panel header="Body">
        {record.body.trim() === '' ? (
          <p className={styles.empty}>No body.</p>
        ) : (
          <Markdown source={record.body} attachments />
        )}
      </Panel>

      {record.type === 'request' && (
        <Panel header={`Became · ${became.length} ${became.length === 1 ? 'ticket' : 'tickets'}`}>
          {became.length === 0 ? (
            <p className={styles.empty}>Not broken down yet.</p>
          ) : (
            <BecameList project={project} ids={became} tick={becameTick} />
          )}
        </Panel>
      )}

      {otherLinks.length > 0 && (
        <Panel header="Links">
          <ul className={styles.links}>
            {otherLinks.map((link) => {
              const href = linkHref(project, link, milestonePath(link));
              return (
                <li key={`${link.kind}:${link.target}`} className={styles.link}>
                  <Icon name={linkKindIcon(link.kind)} size={14} />
                  <span className={styles.linkKind}>{linkKindLabel(link.kind)}</span>
                  {href === null ? (
                    <code>{link.target}</code>
                  ) : (
                    <Link to={href} className={styles.linkTarget}>
                      {link.target}
                    </Link>
                  )}
                  <LinkTitleText title={titles[linkKey(link)]} />
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <Panel header={`History · ${events.length} ${events.length === 1 ? 'entry' : 'entries'}`}>
        <ol className={timeline.timeline}>
          {events.map((event) => (
            <li key={event.event_id} className={timeline.event} data-kind={event.kind}>
              <div className={timeline.rail}>
                <span className={timeline.dot}>
                  <Icon name={eventKindIcon(event.kind)} size={13} />
                </span>
              </div>
              <div className={timeline.body}>
                <div className={timeline.eventHead}>
                  <span className={timeline.kind}>{eventKindLabel(event.kind)}</span>
                  <EventAuthor event={event} self={email} />
                  {/* Written while a draft (2026-10-30): the feed left it out. */}
                  {event.draft === true && (
                    <span
                      className={styles.draftMark}
                      title="Written while a draft: left out of the feed"
                    >
                      draft
                    </span>
                  )}
                  <time className={timeline.when} dateTime={event.ts}>
                    {format.stamp(event.ts)}
                  </time>
                </div>
                {/* A note is Markdown, `att:` resolved and sanitised as the body is;
                    an attached image shows small and opens whole (rag-t0053). */}
                {event.body.trim() !== '' && (
                  <Markdown source={event.body} attachments className={styles.note} />
                )}
                <EventFields event={event} />
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </article>
  );
}
