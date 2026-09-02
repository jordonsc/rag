import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ErrorState,
  Icon,
  Input,
  Panel,
  RowIdentity,
  Spinner,
  StateDot,
  Table,
  useFormat,
  type Column,
} from '@rag/ui';
import { useNavigate } from 'react-router';

import {
  asApiError,
  isAbort,
  searchArchived,
  type ArchivedHit,
  type ArchivedSearchResponse,
  type LedgerApiError,
} from '../api';
import { topicPath } from '../ledger/ids';
import { statusLabel, statusTone, typeIcon, typeLabel } from '../ledger/vocab';
import { ArchiveDialog, IDENTITY_NEEDED, useWriteGate } from '../writes';
import styles from './archived.module.css';

type Result =
  | { kind: 'loading' }
  | { kind: 'ready'; response: ArchivedSearchResponse }
  | { kind: 'error'; error: LedgerApiError };

/**
 * How many rows this view asks for — **stated, because the server has a default
 * and the default is a lie in waiting.**
 *
 * `POST /ledger/search` with `archived: true` applies `LIMIT 50` when no
 * `top_k` is sent, and the response's `count` is the length of the page rather
 * than the size of the archive. A caller that omits `top_k` therefore receives
 * a truncated list that describes itself as complete — the one failure this
 * view, the browse-everything affordance, cannot afford.
 *
 * The number is not the fix; saying so on screen when the page is full is. A
 * bigger limit would move the same lie further away rather than remove it, and
 * the narrowing box searches the whole archive regardless: the `LIKE` runs
 * before the `LIMIT`, server-side, so filtering reaches rows this page does not
 * hold.
 */
export const ARCHIVE_PAGE = 200;

/**
 * The archive: topics that were soft-deleted.
 *
 * **This is the one listing that works without a query**, and it works for a
 * structural reason rather than by exception. An archived topic is purged from
 * the vector index and kept in SQLite, so the server answers this from a `LIKE`
 * over a table — no embedding, no Voyage call, and an ordering (`updated_at
 * DESC`) that a vector search cannot offer at all. Hence a list with a narrowing
 * box rather than a search box with results under it.
 *
 * They remain readable by id: `GET /ledger/{id}` does not filter on the archive
 * flag, so every row here opens.
 */
export function ArchivedView() {
  const navigate = useNavigate();
  const format = useFormat();

  const gate = useWriteGate();

  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>({ kind: 'loading' });
  /** The row a restore has been asked about, or `null`. */
  const [restoring, setRestoring] = useState<ArchivedHit | null>(null);

  // A short settle before asking. The query is a SQL substring match and costs
  // almost nothing, so this is about the *list* rather than the server: results
  // that rearrange under a reader's fingers are harder to read than results
  // that arrive a moment late.
  useEffect(() => {
    const timer = setTimeout(() => setApplied(filter.trim()), 250);
    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    setResult({ kind: 'loading' });
    searchArchived({ query: applied, top_k: ARCHIVE_PAGE }, controller.signal)
      .then((response) => setResult({ kind: 'ready', response }))
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setResult({ kind: 'error', error: asApiError(error) });
      });
    return () => controller.abort();
  }, [applied, attempt]);

  const columns: Array<Column<ArchivedHit>> = [
    {
      key: 'title',
      header: 'Topic',
      identity: true,
      prose: true,
      sortable: true,
      value: (hit) => hit.title,
      render: (hit) => (
        <RowIdentity
          icon={typeIcon(hit.type)}
          iconLabel={typeLabel(hit.type)}
          name={hit.title}
          secondary={hit.topic_id}
        />
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      value: (hit) => hit.type,
      render: (hit) => <Badge tone="neutral">{typeLabel(hit.type)}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      value: (hit) => hit.status,
      render: (hit) => (
        <StateDot
          label={statusLabel(hit.status)}
          tone={statusTone(hit.status)}
          state={hit.status}
        />
      ),
    },
    {
      key: 'repo',
      header: 'Project',
      sortable: true,
      value: (hit) => hit.repo,
    },
    {
      key: 'archived_at',
      header: 'Archived',
      sortable: true,
      // Sorted on the raw RFC3339 string, which orders lexicographically
      // because it is zero-padded and UTC — the formatted value would sort by
      // day-of-month.
      value: (hit) => hit.archived_at ?? '',
      render: (hit) => (
        <span className={styles.stamp}>
          {hit.archived_at === null ? '—' : format.stamp(hit.archived_at)}
        </span>
      ),
    },
    {
      key: 'restore',
      header: 'Restore',
      controls: true,
      // The row itself opens the topic, so the button has to stop the click
      // before it becomes a navigation: a reader who asked to restore a topic
      // and was taken somewhere else instead cannot tell what happened.
      render: (hit) => (
        <Button
          size="sm"
          variant="accent"
          onClick={(event) => {
            event.stopPropagation();
            if (!gate.ready) {
              gate.prompt();
              return;
            }
            setRestoring(hit);
          }}
        >
          Restore…
        </Button>
      ),
    },
  ];

  return (
    <div className={styles.view}>
      <Panel
        header={
          result.kind === 'ready'
            ? `Archived topics · ${result.response.results.length}${
                result.response.results.length >= ARCHIVE_PAGE ? '+' : ''
              }`
            : 'Archived topics'
        }
        actions={
          <div className={styles.filterField}>
            <Input
              value={filter}
              onChange={setFilter}
              placeholder="Narrow by title, summary or state"
              aria-label="Narrow the archive"
              type="search"
            />
          </div>
        }
        padded={false}
      >
        <p className={styles.note}>
          These are soft-deleted: kept in the ledger, dropped from the search index, and absent from
          every ordinary search. They open and read normally, and restoring one puts it back in the
          index — which takes about 30 seconds to 3 minutes to take effect, so a search for it
          immediately afterwards may still come up empty. Narrowing is a plain substring match over
          the title, summary and current state — not the semantic search the live view uses.
          {!gate.ready && <span className={styles.gate}> {IDENTITY_NEEDED}</span>}
        </p>

        {result.kind === 'loading' && (
          <div className={styles.loading}>
            <Spinner size={18} />
            <span>Loading the archive…</span>
          </div>
        )}

        {result.kind === 'error' && (
          <ErrorState
            message="The archive could not be listed."
            detail={result.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}

        {result.kind === 'ready' && result.response.results.length >= ARCHIVE_PAGE && (
          <p className={styles.truncated} role="status">
            <Icon name="triangle-alert" size={14} />
            <span>
              Showing the <strong>{ARCHIVE_PAGE}</strong> most recently archived topics. There are
              more than that, and the rest are not on this page. Narrowing searches the{' '}
              <strong>whole</strong> archive rather than this list, so a topic that is missing here
              can still be found by typing part of its title.
            </span>
          </p>
        )}

        {result.kind === 'ready' && (
          <Table
            columns={columns}
            rows={result.response.results}
            rowKey={(hit) => hit.topic_id}
            empty={
              applied === ''
                ? 'Nothing has been archived.'
                : 'No archived topic contains that text.'
            }
            defaultSort={{ key: 'archived_at', dir: 'desc' }}
            onRowClick={(hit) => navigate(topicPath(hit.topic_id))}
          />
        )}
      </Panel>

      {restoring !== null && (
        <ArchiveDialog
          open
          topicId={restoring.topic_id}
          title={restoring.title}
          archived={false}
          onCancel={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            // The row has to go, and only the server knows the list it leaves
            // behind — so the list is re-read rather than spliced.
            setAttempt((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
