/**
 * A document's page (m04, TC-02), `/projects/<project>/doc/<path>`: the
 * document rendered (`att:` images resolved, a link to another document's
 * path opening that document here), the record it belongs to with its writes,
 * and three tabs: **View**, **Edit** (the editor, TC-03) and **History**
 * (TC-04). The tab is in the address (`?tab=edit`), so a reload in the editor
 * comes back to the editor, where the unsaved text is restored.
 *
 * An old path left by a rename **redirects**: the page moves to the current
 * path (replacing the address, so Back does not bounce) and says it did.
 *
 * **Rename…** (rag-t0003) changes the document's path, its title, or both,
 * and offers to retitle its spec, milestone or concept too
 * (`RenameDialogs.tsx`). A new path moves the page there the way a redirect
 * does, and the old one keeps opening the document.
 *
 * **Drafts** (2026-10-30): a draft document shows a Draft badge and
 * **Publish**; a published one offers **Make draft**. A draft's writes, and
 * its concept's, stay out of the feed. Only a concept's or a free document can
 * be one: a spec has its own draft state. Text typed and
 * not yet saved is called *unsaved* here, never a draft.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorState, Icon, Panel, Spinner, Tabs } from '@rag/ui';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { cx } from '../util';
import writeStyles from '../writes/writes.module.css';
import {
  getConcept,
  getDocByPath,
  getMilestone,
  getSpec,
  isProjectName,
  PROJECT_NAME_ERROR,
  setDocDraft,
  writeDoc,
} from './api';
import { DocEditor } from './DocEditor';
import { DocHistory } from './DocHistory';
import { NoteDialog } from './dialogs';
import { DocMarkdown, StateBadge } from './docParts';
import styles from './docs.module.css';
import { draftKey, hasDraft } from './drafts';
import { useTrackerGate } from './gate';
import { DraftBadge } from './parts';
import { docPath, docsPath } from './paths';
import { RecordPanel, type DocRecord } from './RecordPanel';
import { DocRenameDialog, type Renamed } from './RenameDialogs';
import { RETURN_STATE } from './scrollMemory';
import frame from './tracker.module.css';
import type { DocumentView } from './types';
import { docKindIcon, docKindLabel } from './vocab';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: DocumentView }
  | { kind: 'error'; error: LedgerApiError };

const TABS = ['view', 'edit', 'history'] as const;
type Tab = (typeof TABS)[number];

function tabOf(value: string | null): Tab {
  return TABS.find((tab) => tab === value) ?? 'view';
}

/** What a rename's redirect, or a rename made here, left in the navigation state. */
interface Moved {
  redirectedFrom?: string;
  /** A rename made here whose second write (the record's title) was refused. */
  problem?: string;
}

/** The route: a project name the server would refuse never becomes a request. */
export function DocView() {
  const params = useParams();
  const project = params.project ?? '';
  const path = params['*'] ?? '';
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <DocumentPage key={`${project}/${path}`} project={project} path={path} />;
}

function DocumentPage({ project, path }: { project: string; path: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const gate = useTrackerGate();
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [record, setRecord] = useState<DocRecord | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recordAttempt, setRecordAttempt] = useState(0);
  const navState = location.state as Moved | null;
  const moved = navState?.redirectedFrom;
  const [renaming, setRenaming] = useState(false);
  const [drafting, setDrafting] = useState<'publish' | 'draft' | null>(null);
  const [problem, setProblem] = useState<string | null>(navState?.problem ?? null);
  // Carried through a redirect, so `?tab=edit` on an old path still edits.
  const search = location.search;

  const refetch = useCallback(() => {
    setAttempt((n) => n + 1);
    setRecordAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getDocByPath(project, path, {}, controller.signal)
      .then((doc) => {
        if (doc.redirected_from !== null && doc.path !== path) {
          navigate(
            { pathname: docPath(project, doc.path), search },
            { replace: true, state: { redirectedFrom: doc.redirected_from } satisfies Moved },
          );
          return;
        }
        setLoaded({ kind: 'ready', doc });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [project, path, attempt, navigate, search]);

  const doc = loaded.kind === 'ready' ? loaded.doc : null;
  const kind = doc?.kind;
  const spec = doc?.spec ?? null;
  const milestone = doc?.milestone ?? null;
  const concept = doc?.concept ?? null;
  useEffect(() => {
    if (kind === undefined) {
      return undefined;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    let read: Promise<DocRecord> | null = null;
    if (kind === 'concept' && concept !== null) {
      read = getConcept(project, concept, signal).then((record) => ({ kind: 'concept', record }));
    } else if (kind === 'spec' && spec !== null) {
      read = getSpec(project, spec, signal).then((record) => ({ kind: 'spec', record }));
    } else if (kind === 'milestone' && spec !== null && milestone !== null) {
      read = getMilestone(project, spec, milestone, signal).then((record) => ({
        kind: 'milestone',
        record,
      }));
    }
    read?.then(setRecord).catch(() => {
      // The record is beside the document, not the document: without it the
      // page still reads and edits.
      if (!signal.aborted) {
        setRecord(null);
      }
    });
    return () => controller.abort();
  }, [project, kind, spec, milestone, concept, recordAttempt]);

  const goTo = (next: Tab) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'view') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', next);
    }
    setParams(nextParams, { state: null });
  };

  if (loaded.kind === 'loading') {
    return (
      <div className={frame.loading}>
        <Spinner size={18} />
        <span>Loading {path}…</span>
      </div>
    );
  }

  if (loaded.kind === 'error') {
    const missing = loaded.error.status === 404;
    return (
      <div className={frame.view}>
        <p className={styles.toolbarNote}>
          <Link to={docsPath(project)} state={RETURN_STATE}>
            <Icon name="arrow-left" size={13} /> {project} documents
          </Link>
        </p>
        <Card>
          <ErrorState
            message={
              missing ? `There is no document at ${path} in ${project}.` : `Could not load ${path}.`
            }
            detail={
              missing
                ? 'The tracker holds specs and concepts; a path in the repository (docs/…) is not here.'
                : loaded.error.message
            }
            {...(missing ? {} : { onRetry: refetch })}
          />
        </Card>
      </div>
    );
  }

  const current = loaded.doc;
  // A spec has its own draft state and is the agents' work: only a concept's
  // or a free document can be the owner's draft (2026-10-30).
  const draftable = current.kind === 'concept' || current.kind === 'doc';
  const storage = draftKey(project, current.id);

  const renamed = ({ doc: next, problem: left }: Renamed) => {
    setRenaming(false);
    if (next !== null && next.path !== current.path) {
      // The page is keyed on its path: the new one mounts and reads afresh.
      navigate(
        { pathname: docPath(project, next.path), search },
        {
          replace: true,
          state: {
            redirectedFrom: current.path,
            ...(left === null ? {} : { problem: left }),
          } satisfies Moved,
        },
      );
      return;
    }
    setProblem(left);
    refetch();
  };
  const drafted = tab !== 'edit' && hasDraft(storage);

  return (
    <article className={frame.view}>
      <p className={styles.toolbarNote}>
        <Link to={docsPath(project)} state={RETURN_STATE} className={styles.docMeta}>
          <Icon name="arrow-left" size={13} />
          {project} documents
        </Link>
      </p>

      <header className={styles.docHead}>
        <div className={styles.identity}>
          <span className={styles.kind}>
            <Icon name={docKindIcon(current.kind)} size={14} />
            {docKindLabel(current.kind)}
          </span>
          {record !== null && <StateBadge state={record.record.state} />}
          {current.draft === true && <DraftBadge />}
          <code className={styles.mono}>{current.path}</code>
          <code className={styles.mono}>{current.id}</code>
          <span>revision {current.revision}</span>
        </div>
        <h1 className={frame.title}>{current.title}</h1>
        <div className={writeStyles.actions}>
          {draftable && current.draft === true && (
            <Button
              size="sm"
              variant="accent"
              onClick={() => (gate.ready ? setDrafting('publish') : gate.prompt())}
            >
              <Icon name="eye" size={14} />
              Publish
            </Button>
          )}
          <Button size="sm" onClick={() => (gate.ready ? setRenaming(true) : gate.prompt())}>
            <Icon name="pencil" size={14} />
            Rename…
          </Button>
          {draftable && current.draft !== true && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (gate.ready ? setDrafting('draft') : gate.prompt())}
            >
              <Icon name="eye-off" size={14} />
              Make draft
            </Button>
          )}
        </div>
      </header>

      <NoteDialog
        project={project}
        open={drafting !== null}
        title={drafting === 'publish' ? 'Publish this document?' : 'Make this document a draft?'}
        subject={{ id: current.id, title: current.title }}
        message={
          drafting === 'publish' ? (
            <p>Agents watching the feed are told, once, with it as it now stands.</p>
          ) : (
            <p>
              Agents are told once; after that its edits, and its record’s, stay out of the feed
              until you publish it.
            </p>
          )
        }
        noteHelp="Why, when it is not obvious. It is kept in the document’s history."
        confirmLabel={drafting === 'publish' ? 'Publish' : 'Make draft'}
        onCancel={() => setDrafting(null)}
        onSubmit={(note, fields) =>
          setDocDraft(
            current.id,
            { draft: drafting !== 'publish', ...(note === '' ? {} : { note }) },
            fields,
          )
        }
        onDone={() => {
          setDrafting(null);
          refetch();
        }}
      />

      {renaming && (
        <DocRenameDialog
          doc={current}
          record={record}
          onCancel={() => setRenaming(false)}
          onDone={renamed}
        />
      )}
      {problem !== null && (
        <p className={cx(frame.notice, frame.notice_warn)} role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{problem}</span>
        </p>
      )}

      {moved !== undefined && (
        <p className={frame.notice} role="status">
          <Icon name="corner-down-right" size={14} />
          <span>
            <code>{moved}</code> was renamed: this is its current path.
          </span>
        </p>
      )}
      {drafted && (
        <p className={cx(frame.notice, frame.notice_warn)} role="status">
          <Icon name="pencil" size={14} />
          <span>You have unsaved changes to this document. Edit restores them.</span>
        </p>
      )}

      <Tabs
        tabs={[
          { id: 'view', label: 'View' },
          { id: 'edit', label: drafted ? 'Edit · unsaved' : 'Edit' },
          { id: 'history', label: 'History' },
        ]}
        active={tab}
        onChange={(id) => goTo(tabOf(id))}
        label="Document"
      />

      {tab === 'view' && (
        <>
          {record !== null && <RecordPanel target={record} onWritten={refetch} />}
          <Panel header="Document">
            {current.body.trim() === '' ? (
              <p className={styles.status}>This document is empty. Edit writes its first text.</p>
            ) : (
              <DocMarkdown project={project} path={current.path} source={current.body} />
            )}
          </Panel>
        </>
      )}

      {tab === 'edit' && (
        <DocEditor
          key={current.id}
          project={project}
          path={current.path}
          storageKey={storage}
          initial={current.body}
          revision={current.revision}
          docId={current.id}
          onSave={(body, base, message, fields) =>
            writeDoc(
              current.id,
              { base_revision: base, body, ...(message === '' ? {} : { message }) },
              fields,
            )
          }
          onSaved={() => {
            goTo('view');
            refetch();
          }}
          onClose={() => goTo('view')}
        />
      )}

      {tab === 'history' && (
        <DocHistory doc={current} recordEvents={record?.record.events ?? []} onRestored={refetch} />
      )}
    </article>
  );
}
