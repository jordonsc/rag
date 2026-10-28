import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Panel,
  RowIdentity,
  Select,
  Spinner,
  StateDot,
  Table,
  type Column,
} from '@rag/ui';
import { Link, useNavigate, useSearchParams } from 'react-router';

import {
  asApiError,
  isAbort,
  searchLedger,
  type LedgerApiError,
  type LiveSearchResponse,
  type RankedHit,
  type TopicStatus,
  type TopicType,
} from '../api';
import { isTopicId, topicPath } from '../ledger/ids';
import {
  statusLabel,
  statusOptions,
  statusTone,
  typeIcon,
  typeLabel,
  typeOptions,
} from '../ledger/vocab';
import { searchTracker } from '../tracker/api';
import { docPath, itemPath } from '../tracker/paths';
import type { TrackerHit, TrackerSearchResponse } from '../tracker/types';
import { docKindIcon, docKindLabel, itemTypeIcon } from '../tracker/vocab';
import { snippet } from '../util';
import styles from './search.module.css';

type Result =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; response: LiveSearchResponse }
  | { kind: 'tracker'; response: TrackerSearchResponse }
  | { kind: 'error'; error: LedgerApiError };

/**
 * What is searched: the ledger (the default, `POST /ledger/search`) or the
 * tracker's documents and items (`POST /search` with `corpus: "tracker"`,
 * specs/tracker D13). In the URL as `corpus=tracker`.
 */
const CORPUS_OPTIONS = [
  { value: '', label: 'Ledger' },
  { value: 'tracker', label: 'Tracker' },
];

/** Where a tracker hit opens: its item, or its document. */
function trackerHref(hit: TrackerHit): string | null {
  if (hit.repo === '') {
    return null;
  }
  if (hit.kind === 'item') {
    const id = hit.tracker_id ?? hit.rel_path;
    return id === '' ? null : itemPath(hit.repo, id);
  }
  return hit.rel_path === '' ? null : docPath(hit.repo, hit.rel_path);
}

function trackerMatch(hit: TrackerHit): string {
  const { title, text } = hit;
  const body = title !== undefined && text.startsWith(title) ? text.slice(title.length) : text;
  return snippet(body);
}

/** The part of a hit's chunk worth showing beside a title that already says it. */
function matchText(hit: RankedHit): string {
  const { title, text } = hit;
  // A *topic* point's text is title + summary + state, so the first line
  // repeats the row heading; an *event* point's text is mid-monologue prose
  // with no title in it. Trimming the one that leads with the title is what
  // makes the two read alike in a column.
  const body = title !== undefined && text.startsWith(title) ? text.slice(title.length) : text;
  return snippet(body);
}

/**
 * Search over live topics.
 *
 * **The query is not optional and the view says so.** `POST /ledger/search`
 * rejects a blank query for the live set, because retrieval is an embedding
 * against a vector index rather than a table scan. There is consequently no
 * "show me everything" landing page, and pretending otherwise — an empty table,
 * a permanent spinner — would read as breakage. The empty state is a prompt,
 * and it names the one listing that *does* work without a query: the archive.
 *
 * The query and filters live in the **URL**, which makes a result set something
 * a person can send to somebody else, and makes the back button do what the
 * reader means by it.
 */
export function SearchView() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const query = params.get('q') ?? '';
  const corpus = params.get('corpus') === 'tracker' ? 'tracker' : '';
  const repo = params.get('repo') ?? '';
  const type = params.get('type') ?? '';
  const status = params.get('status') ?? '';

  // The controls hold a draft; only submitting writes it to the URL, and only
  // the URL starts a search. A search costs an embed, a vector lookup and a
  // rerank — roughly a second — so firing one per keystroke would be several
  // seconds of wasted work per query and a results list that flickers through
  // answers to half-typed questions.
  const [draft, setDraft] = useState({ query, corpus, repo, type, status });
  useEffect(() => {
    setDraft({ query, corpus, repo, type, status });
  }, [query, corpus, repo, type, status]);

  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  useEffect(() => {
    if (query.trim() === '') {
      setResult({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    setResult({ kind: 'loading' });
    if (corpus === 'tracker') {
      searchTracker({ query, project: repo }, controller.signal)
        .then((response) => setResult({ kind: 'tracker', response }))
        .catch((error: unknown) => {
          if (!isAbort(error)) {
            setResult({ kind: 'error', error: asApiError(error) });
          }
        });
      return () => controller.abort();
    }
    searchLedger(
      {
        query,
        ...(repo === '' ? {} : { repo }),
        ...(type === '' ? {} : { type: type as TopicType }),
        ...(status === '' ? {} : { status: status as TopicStatus }),
      },
      controller.signal,
    )
      .then((response) => setResult({ kind: 'ready', response }))
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setResult({ kind: 'error', error: asApiError(error) });
      });
    return () => controller.abort();
  }, [query, corpus, repo, type, status, attempt]);

  /**
   * The typed query, when what was typed is an id rather than a question.
   *
   * **Read off the draft, not the submitted query**, so it appears the moment
   * an id is pasted — before the reader presses Enter and waits a second for a
   * semantic search over a string that has no meaning to embed.
   *
   * **It does not take Enter.** Submitting still searches, because the reader
   * may well have meant to: an id is quoted in other topics' prose and in
   * `supersedes` links, so "find what mentions demo-0001" is a real question.
   * Silently navigating away from a search someone deliberately started is the
   * one behaviour here that would be worse than not offering the shortcut at
   * all. The direct route is an explicit second control instead.
   */
  const directId = draft.corpus === '' && isTopicId(draft.query.trim()) ? draft.query.trim() : null;

  const submit = () => {
    const next = new URLSearchParams();
    if (draft.query.trim() !== '') {
      next.set('q', draft.query.trim());
    }
    if (draft.corpus !== '') {
      next.set('corpus', draft.corpus);
    }
    if (draft.repo.trim() !== '') {
      next.set('repo', draft.repo.trim());
    }
    // The type and status filters are the ledger's vocabulary; the tracker
    // search takes neither, and a filter that is sent but ignored would read
    // as a narrower result than it is.
    if (draft.corpus === '' && draft.type !== '') {
      next.set('type', draft.type);
    }
    if (draft.corpus === '' && draft.status !== '') {
      next.set('status', draft.status);
    }
    setParams(next);
    // Same query, same filters, pressed again: the URL does not change, so the
    // effect above does not re-run. Nudging the attempt counter is what makes
    // "search again" mean something after an index reconcile.
    setAttempt((n) => n + 1);
  };

  const columns: Array<Column<RankedHit>> = [
    {
      key: 'title',
      header: 'Topic',
      identity: true,
      prose: true,
      sortable: true,
      value: (hit) => hit.title ?? hit.topic_id ?? '',
      render: (hit) => (
        <RowIdentity
          icon={typeIcon(hit.type)}
          iconLabel={hit.type === undefined ? undefined : typeLabel(hit.type)}
          name={hit.title ?? hit.topic_id ?? 'Untitled topic'}
          secondary={hit.topic_id}
        />
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      value: (hit) => hit.type ?? '',
      // Neutral, always. Colour on this page means *status*; a type drawn in a
      // second colour vocabulary would make the two compete for the same
      // reading.
      render: (hit) =>
        hit.type === undefined ? null : <Badge tone="neutral">{typeLabel(hit.type)}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      value: (hit) => hit.status ?? '',
      render: (hit) =>
        hit.status === undefined ? null : (
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
      key: 'match',
      header: 'Match',
      prose: true,
      render: (hit) => <span className={styles.match}>{matchText(hit)}</span>,
    },
  ];

  const trackerColumns: Array<Column<TrackerHit>> = [
    {
      key: 'title',
      header: 'Document or ticket',
      identity: true,
      prose: true,
      sortable: true,
      value: (hit) => hit.title ?? hit.rel_path,
      render: (hit) => (
        <RowIdentity
          icon={hit.kind === 'item' ? itemTypeIcon(hit.type ?? '') : docKindIcon(hit.kind ?? '')}
          iconLabel={hit.kind === undefined ? undefined : docKindLabel(hit.kind)}
          name={hit.title ?? hit.rel_path}
          secondary={hit.citation ?? hit.rel_path}
        />
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      sortable: true,
      value: (hit) => hit.kind ?? '',
      render: (hit) =>
        hit.kind === undefined ? null : (
          <Badge tone="neutral">{hit.kind === 'item' ? 'Ticket' : docKindLabel(hit.kind)}</Badge>
        ),
    },
    {
      key: 'repo',
      header: 'Project',
      sortable: true,
      value: (hit) => hit.repo,
    },
    {
      key: 'match',
      header: 'Match',
      prose: true,
      render: (hit) => <span className={styles.match}>{trackerMatch(hit)}</span>,
    },
  ];

  return (
    <div className={styles.view}>
      <form
        className={styles.bar}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className={styles.queryField}>
          <Input
            value={draft.query}
            onChange={(value) => setDraft((current) => ({ ...current, query: value }))}
            placeholder="What are you looking for?"
            aria-label={draft.corpus === 'tracker' ? 'Search the tracker' : 'Search the ledger'}
            type="search"
            autoFocus
          />
        </div>
        <div className={styles.filter}>
          <Select
            value={draft.corpus}
            onChange={(value) => setDraft((current) => ({ ...current, corpus: value }))}
            options={CORPUS_OPTIONS}
            aria-label="Corpus"
          />
        </div>
        <div className={styles.filter}>
          <Input
            value={draft.repo}
            onChange={(value) => setDraft((current) => ({ ...current, repo: value }))}
            placeholder="Any project"
            aria-label="Project"
          />
        </div>
        {draft.corpus === '' && (
          <div className={styles.filter}>
            <Select
              value={draft.type}
              onChange={(value) => setDraft((current) => ({ ...current, type: value }))}
              options={[{ value: '', label: 'Any type' }, ...typeOptions()]}
              aria-label="Topic type"
            />
          </div>
        )}
        {draft.corpus === '' && (
          <div className={styles.filter}>
            <Select
              value={draft.status}
              onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
              options={[{ value: '', label: 'Any status' }, ...statusOptions()]}
              aria-label="Status"
            />
          </div>
        )}
        <Button type="submit" variant="primary" loading={result.kind === 'loading'}>
          Search
        </Button>
      </form>

      {directId !== null && (
        <div className={styles.direct}>
          <Icon name="arrow-right" size={16} />
          <p className={styles.directText}>
            <code>{directId}</code> is a topic id. Open it directly, or search for what mentions it.
          </p>
          <Button variant="primary" onClick={() => navigate(topicPath(directId))}>
            Open {directId}
          </Button>
        </div>
      )}

      {/* The project filter is an exact match on the indexed field, not a
          substring — worth saying, because a half-remembered project name
          silently returns nothing rather than narrowing. */}
      <p className={styles.hint}>
        Project is matched exactly. Leave it empty to search everything.
      </p>

      {result.kind === 'idle' && (
        <Panel>
          <EmptyState
            icon="search"
            title={corpus === 'tracker' ? 'Search the tracker' : 'Search the ledger'}
            message={
              corpus === 'tracker' ? (
                'The tracker’s specs, concepts and tickets are retrieved by meaning, as the ledger’s topics are. Name a project to search only its documents.'
              ) : (
                <>
                  Live topics are retrieved by meaning, so a search needs something to match — there
                  is no browse-everything list. <Link to="/archived">Archived topics</Link> are the
                  exception: they list without a query.
                </>
              )
            }
          />
        </Panel>
      )}

      {result.kind === 'loading' && (
        <Panel>
          <div className={styles.loading}>
            <Spinner size={18} />
            <span>Embedding, retrieving and reranking — about a second.</span>
          </div>
        </Panel>
      )}

      {result.kind === 'error' && (
        <Panel>
          <ErrorState
            message="The search did not run."
            detail={result.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </Panel>
      )}

      {result.kind === 'tracker' && (
        <Panel
          header={`${result.response.results.length} ${result.response.results.length === 1 ? 'result' : 'results'} in the tracker`}
          actions={
            <span className={styles.meta}>
              {result.response.reranked ? 'reranked · ' : ''}
              {result.response.candidates} candidates · {result.response.timings.total_ms} ms
            </span>
          }
          padded={false}
        >
          <Table
            columns={trackerColumns}
            rows={result.response.results}
            rowKey={(hit) =>
              `${hit.citation ?? hit.rel_path}:${hit.start_line}:${hit.end_line}:${hit.ann_score}`
            }
            empty="Nothing matched in the tracker. Try different words, or no project — this is a semantic search, so a phrase works better than a keyword."
            onRowClick={(hit) => {
              const href = trackerHref(hit);
              if (href !== null) {
                navigate(href);
              }
            }}
          />
        </Panel>
      )}

      {result.kind === 'ready' && (
        <Panel
          header={`${result.response.results.length} ${result.response.results.length === 1 ? 'topic' : 'topics'}`}
          actions={
            <span className={styles.meta}>
              {result.response.reranked ? 'reranked · ' : ''}
              {result.response.candidates} candidates · {result.response.timings.total_ms} ms
            </span>
          }
          padded={false}
        >
          <Table
            columns={columns}
            rows={result.response.results}
            rowKey={(hit) => hit.topic_id ?? `${hit.repo}:${hit.ann_score}`}
            empty="Nothing matched. Try fewer filters, or different words — this is a semantic search, so a phrase works better than a keyword."
            onRowClick={(hit) => {
              if (hit.topic_id !== undefined) {
                navigate(topicPath(hit.topic_id));
              }
            }}
          />
        </Panel>
      )}
    </div>
  );
}
