import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Card,
  ErrorState,
  Icon,
  Panel,
  Spinner,
  StateDot,
  useFormat,
  type Tone,
} from '@rag/ui';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import {
  asApiError,
  getTopic,
  isAbort,
  type LedgerApiError,
  type LedgerEvent,
  type TopicRecord,
} from '../api';
import { useIdentity } from '../identity';
import { topicPath } from '../ledger/ids';
import {
  REL_ORDER,
  kindIcon,
  kindLabel,
  relIcon,
  relLabel,
  statusLabel,
  statusTone,
  typeHint,
  typeIcon,
  typeLabel,
} from '../ledger/vocab';
import { Markdown } from '../markdown/Markdown';
import { SummarisePanel } from '../summarise';
import { AppendPanel, TopicActions } from '../writes';
import styles from './topic.module.css';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; record: TopicRecord }
  | { kind: 'error'; error: LedgerApiError };

/** Navigation state carried across a move redirect, so the notice survives it. */
interface MovedState {
  movedFrom?: string;
}

/**
 * Who wrote an event, and what kind of thing they are.
 *
 * The distinction the ledger actually stores is **agent or not**: `author_agent`
 * is null for a person and carries the model's name for an agent. So a null
 * agent is reported as a person rather than left blank — a blank there reads as
 * missing data, when it is in fact the most informative value the field has.
 */
function author(event: { author_email: string; author_agent: string | null }, self: string | null) {
  if (event.author_agent !== null) {
    return { icon: 'bot', qualifier: event.author_agent };
  }
  return {
    icon: 'user',
    qualifier: self !== null && self === event.author_email ? 'you' : 'a person',
  };
}

/** What an event changed, drawn beside the prose that explains it. */
function EventChanges({ event }: { event: LedgerEvent }) {
  const changed =
    event.new_status !== null ||
    event.new_title !== null ||
    event.new_tags !== null ||
    event.new_state !== null;
  if (!changed) {
    return null;
  }
  return (
    <div className={styles.changes}>
      {event.new_status !== null && (
        <div className={styles.change}>
          <span className={styles.changeLabel}>Status</span>
          <StateDot
            label={statusLabel(event.new_status)}
            tone={statusTone(event.new_status)}
            state={event.new_status}
          />
        </div>
      )}
      {event.new_title !== null && (
        <div className={styles.change}>
          <span className={styles.changeLabel}>Retitled</span>
          <span className={styles.changeValue}>{event.new_title}</span>
        </div>
      )}
      {event.new_tags !== null && (
        <div className={styles.change}>
          <span className={styles.changeLabel}>Tags</span>
          <span className={styles.tags}>
            {event.new_tags.length === 0 ? (
              <span className={styles.changeValue}>cleared</span>
            ) : (
              event.new_tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))
            )}
          </span>
        </div>
      )}
      {event.new_state !== null && (
        <div className={styles.stateChange}>
          <span className={styles.changeLabel}>State set to</span>
          <Markdown source={event.new_state} className={styles.stateBody} />
        </div>
      )}
    </div>
  );
}

/**
 * One topic, whole.
 *
 * The three things it has to keep visibly apart, because the ledger's value
 * depends on the difference:
 *
 * * **`summary`** — the original framing, fixed at creation. Drawn as a quoted
 *   block with the immutability stated, because a reader who mistakes it for
 *   current thinking has read the topic backwards.
 * * **`current_state`** — where it stands now. One paragraph, replaced over
 *   time, and the only thing safe to act on.
 * * **the events** — how it got from one to the other. A timeline, oldest
 *   first, each carrying who wrote it and what it changed.
 */
export function TopicView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const format = useFormat();
  const { email } = useIdentity();

  const movedFrom = (location.state as MovedState | null)?.movedFrom;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });

  /**
   * Read the topic again, from the server.
   *
   * **The response to every write on this page**, in preference to patching the
   * record in hand. The server decides the event id and its timestamp, whether
   * a `set_status` was legal, what the topic's `updated_at` becomes and — for
   * `supersedes` — the pair of links it wrote and the status it changed on
   * *another* topic. A client that merged its own request body into local state
   * would be drawing a plausible fiction, and the one place it diverged is the
   * place nobody would think to check.
   */
  const refetch = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (id === undefined) {
      return;
    }
    const controller = new AbortController();
    setLoaded({ kind: 'loading' });
    getTopic(id, controller.signal)
      .then((fetched) => {
        if (fetched.kind === 'moved') {
          // The id was retired by a move and the server handed back a pointer
          // rather than a 404. Follow it, replacing the entry so the back
          // button does not bounce off the tombstone, and carry the old id
          // through so the destination can say what happened.
          navigate(topicPath(fetched.pointer.moved_to), {
            replace: true,
            state: { movedFrom: fetched.pointer.topic_id } satisfies MovedState,
          });
          return;
        }
        setLoaded({ kind: 'ready', record: fetched.record });
      })
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setLoaded({ kind: 'error', error: asApiError(error) });
      });
    return () => controller.abort();
  }, [id, attempt, navigate]);

  if (id === undefined) {
    return <ErrorState message="No topic id in the address." />;
  }

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
            loaded.error.status === 404 ? `There is no topic ${id}.` : `Could not load ${id}.`
          }
          detail={loaded.error.message}
          onRetry={refetch}
        />
      </Card>
    );
  }

  const topic = loaded.record;
  const created = author(
    { author_email: topic.creator_email, author_agent: topic.creator_agent },
    email,
  );
  const statusText = statusLabel(topic.status);
  const statusColour: Tone = statusTone(topic.status);
  const hint = typeHint(topic.type);

  return (
    <article className={styles.view}>
      {movedFrom !== undefined && (
        <p className={styles.notice}>
          <Icon name="arrow-right" size={14} />
          <span>
            <code>{movedFrom}</code> was moved and retired. This is where its content now lives.
          </span>
        </p>
      )}

      {topic.archived && (
        <p className={styles.notice}>
          <Icon name="archive" size={14} />
          <span>
            Archived{topic.archived_at === null ? '' : ` on ${format.stamp(topic.archived_at)}`}.
            Soft-deleted: kept here, dropped from the search index, and absent from an ordinary
            search.
          </span>
        </p>
      )}

      <header className={styles.header}>
        <div className={styles.identity}>
          <Icon name={typeIcon(topic.type)} size={16} label={typeLabel(topic.type)} />
          <Badge tone="neutral">{typeLabel(topic.type)}</Badge>
          <StateDot label={statusText} tone={statusColour} state={topic.status} />
          <code className={styles.topicId}>{topic.topic_id}</code>
        </div>
        <h1 className={styles.title}>{topic.title}</h1>
        {hint !== undefined && <p className={styles.hint}>{hint}</p>}
        <dl className={styles.meta}>
          <div>
            <dt>Project</dt>
            <dd>{topic.repo}</dd>
          </div>
          <div>
            <dt>Opened</dt>
            <dd>
              {format.stamp(topic.created_at)} by {topic.creator_email}
              <span className={styles.qualifier}> · {created.qualifier}</span>
            </dd>
          </div>
          <div>
            <dt>Last touched</dt>
            <dd>{format.stamp(topic.updated_at)}</dd>
          </div>
        </dl>
        {topic.tags.length > 0 && (
          <div className={styles.tags}>
            <Icon name="tag" size={13} label="Tags" />
            {topic.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </header>

      {/* The writes that act *on* the topic rather than adding to it. The
          append form is at the foot of the page, under the history it extends;
          amending happens there too, because an amendment is an event with a
          rationale and not a field edit. `refetch` re-reads by id — never a
          re-search, which the vector index will not have caught up with for
          another 30 s to 3 min. */}
      <TopicActions key={`actions:${topic.topic_id}`} topic={topic} onWritten={refetch} />

      <Panel
        header="Summary"
        actions={<span className={styles.immutable}>the original framing · never revised</span>}
        className={styles.summaryPanel}
      >
        <Markdown source={topic.summary} />
      </Panel>

      <Panel header="Current state">
        <Markdown source={topic.current_state} />
      </Panel>

      {topic.links.length > 0 && (
        <Panel header="Links">
          <ul className={styles.links}>
            {REL_ORDER.flatMap((rel) =>
              topic.links
                .filter((link) => link.rel === rel)
                .map((link) => (
                  <li key={`${rel}:${link.other_topic_id}`} className={styles.link}>
                    <Icon name={relIcon(rel)} size={14} />
                    <span className={styles.relLabel}>{relLabel(rel)}</span>
                    <Link to={topicPath(link.other_topic_id)} className={styles.topicLink}>
                      {link.other_topic_id}
                    </Link>
                  </li>
                )),
            )}
          </ul>
        </Panel>
      )}

      <Panel
        header={`History · ${topic.events.length} ${topic.events.length === 1 ? 'entry' : 'entries'}`}
      >
        {/* Oldest first, and never reordered. The point of an append-only log
            is that it reads as an argument developing; newest-first would make
            every correction arrive before the thing it corrects. */}
        <ol className={styles.timeline}>
          {topic.events.map((event) => {
            const who = author(event, email);
            return (
              <li key={event.event_id} className={styles.event}>
                <div className={styles.rail}>
                  <span className={styles.dot}>
                    <Icon name={kindIcon(event.kind)} size={13} />
                  </span>
                </div>
                <div className={styles.body}>
                  <div className={styles.eventHead}>
                    <span className={styles.kind}>{kindLabel(event.kind)}</span>
                    <span className={styles.who}>
                      <Icon name={who.icon} size={13} />
                      {event.author_email}
                      <span className={styles.qualifier}> · {who.qualifier}</span>
                    </span>
                    <time className={styles.when} dateTime={event.ts}>
                      {format.stamp(event.ts)}
                    </time>
                  </div>
                  <Markdown source={event.body} />
                  <EventChanges event={event} />
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>

      {/* Keyed by id so that navigating to another topic starts a fresh draft
          rather than carrying a half-written note across to something it was
          never about. The key is prefixed because `TopicActions` above is a
          sibling keyed off the same id, and React reconciles siblings by key:
          two identical ones let it drop or confuse them. */}
      <AppendPanel key={`append:${topic.topic_id}`} topic={topic} onWritten={refetch} />

      {/* The pull-out tab, and the only LLM call this application makes. Not
          keyed by id, unlike the two panels above: it clears its own summary
          when the topic changes but keeps the reader's model and prompt, which
          are settings rather than properties of the entry. */}
      <SummarisePanel topicId={topic.topic_id} />
    </article>
  );
}
