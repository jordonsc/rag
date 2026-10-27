import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge, Card, ErrorState, Icon, Panel, Spinner, useFormat } from '@rag/ui';
import { Link, useParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { useIdentity } from '../identity';
import { Markdown } from '../markdown/Markdown';
import timeline from '../views/topic.module.css';
import { getItem, getMilestone } from './api';
import { ItemActions } from './ItemActions';
import { ApprovalBadge, LabelChips, ParallelBadge, StatusDot, TypeBadge, WaitsOn } from './parts';
import { itemPath, linkHref, projectPath } from './paths';
import styles from './item.module.css';
import type { Item, Link as ItemLink, TrackerEvent } from './types';
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

/**
 * One item, whole (D15): its record, its body rendered, its links, its history
 * and the writes that act on it.
 */
export function ItemView() {
  const { id = '' } = useParams();
  const format = useFormat();
  const { email } = useIdentity();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [milestones, setMilestones] = useState<Record<string, string>>({});

  /** The response to every write here: read the item again, by id. */
  const refetch = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    // A re-read after a write keeps the page on screen; another item does not.
    setLoaded((prev) =>
      prev.kind === 'ready' && prev.item.id === id ? prev : { kind: 'loading' },
    );
    getItem(id, {}, controller.signal)
      .then((item) => setLoaded({ kind: 'ready', item }))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [id, attempt]);

  // A milestone link names `spec/code`; its document's path also holds the
  // milestone's name, which only its record knows.
  const item = loaded.kind === 'ready' ? loaded.item : null;
  useEffect(() => {
    if (item === null) {
      return undefined;
    }
    const controller = new AbortController();
    for (const link of item.links) {
      const [spec, code] = link.target.split('/');
      if (link.kind !== 'milestone' || spec === undefined || code === undefined) {
        continue;
      }
      getMilestone(item.project, spec, code, controller.signal)
        .then((milestone) =>
          setMilestones((known) => ({ ...known, [link.target]: milestone.path })),
        )
        .catch(() => {
          // Unresolved: the chip stays text. Nothing else depends on it.
        });
    }
    return () => controller.abort();
  }, [item]);

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
            loaded.error.status === 404 ? `There is no item ${id}.` : `Could not load ${id}.`
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

  return (
    <article className={styles.view}>
      <p className={styles.crumbs}>
        <Link to={projectPath(project)}>
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
          <ApprovalBadge approval={record.approval} always />
          {record.type === 'gate' && record.intensity !== null && (
            <Badge tone="neutral">{intensityLabel(record.intensity)} gate</Badge>
          )}
          {record.release && <Badge tone="acc">Release</Badge>}
          {record.parallel === true && <ParallelBadge />}
        </div>
        <h1 className={styles.title}>{record.title}</h1>
        {itemTypeHint(record.type) !== undefined && (
          <p className={styles.hint}>{itemTypeHint(record.type)}</p>
        )}
        <dl className={styles.meta}>
          <div>
            <dt>Project</dt>
            <dd>
              <Link to={projectPath(project)}>{project}</Link>
            </dd>
          </div>
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

      {record.links.length > 0 && (
        <Panel header="Links">
          <ul className={styles.links}>
            {record.links.map((link) => {
              const href = linkHref(project, link, milestones[link.target]);
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
                  <time className={timeline.when} dateTime={event.ts}>
                    {format.stamp(event.ts)}
                  </time>
                </div>
                {event.body.trim() !== '' && <Markdown source={event.body} attachments />}
                <EventFields event={event} />
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </article>
  );
}
