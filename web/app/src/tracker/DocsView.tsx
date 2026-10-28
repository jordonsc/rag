/**
 * A project's documents page (m04, TC-01; D16, R13), `/projects/<project>/docs`.
 *
 * Tabs, in the address (`?tab=specs`):
 *
 * * **Concepts**, by state (open, refining, refined, archived; the archived
 *   folded away), with **New concept**;
 * * **Specs**, each with its state and approval and its milestones (code,
 *   title, state, approval), each opening its document; **Edit title…** on a
 *   spec or milestone and **Move up** / **Move down** on a milestone
 *   (rag-t0003);
 * * **Other documents**, the free-standing ones (kind `doc`) an agent may have
 *   created, which belong to no spec or concept;
 * * **Attachments** (TC-05).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Spinner,
  Tabs,
  useFormat,
} from '@rag/ui';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { cx } from '../util';
import {
  isProjectName,
  listConcepts,
  listDocs,
  listSpecs,
  PROJECT_NAME_ERROR,
  updateMilestone,
} from './api';
import { Attachments } from './Attachments';
import { ProjectTabs, StateBadge } from './docParts';
import styles from './docs.module.css';
import { draftKey, hasDraft } from './drafts';
import { useTrackerGate } from './gate';
import { planMove, type Direction } from './milestoneOrder';
import { ApprovalBadge, LinkChips } from './parts';
import { docPath, newConceptPath, storeLastProject } from './paths';
import { ProjectPicker } from './ProjectPicker';
import { TitleDialog, type TitleTarget } from './RenameDialogs';
import { useScrollMemory } from './scrollMemory';
import frame from './tracker.module.css';
import {
  CONCEPT_STATES,
  type Concept,
  type ConceptState,
  type Spec,
  type TrackerDocument,
} from './types';
import { recordStateLabel } from './vocab';

const TABS = [
  { id: 'concepts', label: 'Concepts' },
  { id: 'specs', label: 'Specs' },
  { id: 'other', label: 'Other' },
  { id: 'attachments', label: 'Attachments' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function tabOf(value: string | null): Tab {
  return TABS.find((tab) => tab.id === value)?.id ?? 'concepts';
}

interface Lists {
  concepts: Concept[];
  specs: Spec[];
  other: TrackerDocument[];
}

type Loaded =
  { kind: 'loading' } | { kind: 'ready'; lists: Lists } | { kind: 'error'; error: LedgerApiError };

/** The route: a project name the server would refuse never becomes a request. */
export function DocsView() {
  const { project = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <Documents key={project} project={project} />;
}

function Documents({ project }: { project: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Back from a document lands where the reader left this tab's list
  // (rag-t0040). Attachments loads on its own, so it is not remembered.
  useScrollMemory(tab === 'attachments' ? null : `docs:${project}:${tab}`, loaded.kind === 'ready');

  useEffect(() => storeLastProject(project), [project]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    Promise.all([
      listConcepts(project, undefined, signal),
      listSpecs(project, signal),
      listDocs(project, { kind: 'doc' }, signal),
    ])
      .then(([concepts, specs, docs]) =>
        setLoaded({
          kind: 'ready',
          lists: { concepts: concepts.concepts, specs: specs.specs, other: docs.documents },
        }),
      )
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [project, attempt]);

  const counts =
    loaded.kind === 'ready'
      ? {
          concepts: loaded.lists.concepts.length,
          specs: loaded.lists.specs.length,
          other: loaded.lists.other.length,
        }
      : null;

  return (
    <div className={frame.view}>
      <header className={frame.head}>
        <div className={frame.headTitle}>
          <Icon name="file-text" size={18} />
          <h1 className={frame.title}>{project} documents</h1>
        </div>
        <div className={frame.headControls}>
          <ProjectTabs project={project} active="docs" />
          <span className={frame.picker}>
            <ProjectPicker current={project} />
          </span>
        </div>
      </header>

      <Tabs
        tabs={TABS.map((item) => ({
          id: item.id,
          label:
            counts !== null && item.id !== 'attachments'
              ? `${item.label} · ${counts[item.id]}`
              : item.label,
        }))}
        active={tab}
        onChange={(id) => setParams(id === 'concepts' ? {} : { tab: id })}
        label="Documents"
      />

      {tab === 'attachments' ? (
        <Attachments project={project} />
      ) : loaded.kind === 'loading' ? (
        <div className={frame.loading}>
          <Spinner size={18} />
          <span>Loading {project}’s documents…</span>
        </div>
      ) : loaded.kind === 'error' ? (
        <Card>
          <ErrorState
            message={`Could not load ${project}’s documents.`}
            detail={loaded.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </Card>
      ) : tab === 'concepts' ? (
        <ConceptsTab
          project={project}
          concepts={loaded.lists.concepts}
          onNew={() => navigate(newConceptPath(project))}
        />
      ) : tab === 'specs' ? (
        <SpecsTab
          project={project}
          specs={loaded.lists.specs}
          onChanged={() => setAttempt((n) => n + 1)}
        />
      ) : (
        <OtherTab project={project} docs={loaded.lists.other} />
      )}
    </div>
  );
}

// ---- Concepts ---------------------------------------------------------------

function ConceptsTab({
  project,
  concepts,
  onNew,
}: {
  project: string;
  concepts: readonly Concept[];
  onNew: () => void;
}) {
  const format = useFormat();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const pending = hasDraft(draftKey(project, 'new-concept'));
  const by = (state: ConceptState) => concepts.filter((concept) => concept.state === state);

  const rows = (list: readonly Concept[]) => (
    <ul className={styles.rows}>
      {list.map((concept) => (
        <li key={concept.slug} className={styles.docRow} data-slug={concept.slug}>
          <Link to={docPath(project, concept.path)} className={styles.docTitle}>
            {concept.title}
          </Link>
          <code className={styles.docPath}>{concept.path}</code>
          <span className={styles.docMeta}>
            <ApprovalBadge approval={concept.approval} />
            <LinkChips project={project} links={concept.links} />
            <time dateTime={concept.updated_at}>{format.stamp(concept.updated_at)}</time>
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={styles.tabBody}>
      <div className={styles.toolbar}>
        <p className={styles.toolbarNote}>
          Musings to be refined into specs. Archiving is a state: an archived concept keeps its path
          and history.
        </p>
        <Button size="sm" variant="primary" onClick={onNew}>
          <Icon name="file-plus" size={14} />
          {pending ? 'New concept (draft)' : 'New concept'}
        </Button>
      </div>
      {concepts.length === 0 ? (
        <Card>
          <EmptyState
            icon="sparkles"
            title="No concepts yet"
            message="New concept starts one: a title, a slug and its first text."
          />
        </Card>
      ) : (
        CONCEPT_STATES.map((state) => {
          const list = by(state);
          if (state === 'archived') {
            return list.length === 0 ? null : (
              <Disclosure
                key={state}
                title={`${recordStateLabel(state)} · ${list.length}`}
                open={archivedOpen}
                onToggle={setArchivedOpen}
              >
                {rows(list)}
              </Disclosure>
            );
          }
          return (
            <section
              key={state}
              className={frame.section}
              aria-label={recordStateLabel(state)}
              data-state={state}
            >
              <header className={frame.sectionHead}>
                <h2 className={frame.sectionTitle}>
                  <StateBadge state={state} /> <span className={frame.count}>{list.length}</span>
                </h2>
              </header>
              {list.length === 0 ? <p className={styles.empty}>None.</p> : rows(list)}
            </section>
          );
        })
      )}
    </div>
  );
}

// ---- Specs ------------------------------------------------------------------

/** A move under way, or just made: which button to give focus back to. */
interface Moving {
  slug: string;
  code: string;
  direction: Direction;
}

function moveKey(slug: string, code: string, direction: Direction): string {
  return `${slug}/${code}/${direction}`;
}

function SpecsTab({
  project,
  specs,
  onChanged,
}: {
  project: string;
  specs: readonly Spec[];
  /** A write landed: re-read the lists. */
  onChanged: () => void;
}) {
  const gate = useTrackerGate();
  const [editing, setEditing] = useState<TitleTarget | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const refocus = useRef<Moving | null>(null);

  // The lists were re-read: a move is over.
  useEffect(() => setMoving(null), [specs]);

  // Once the buttons are enabled again, the one pressed gets the focus back
  // (or its twin, when the milestone reached an end).
  useEffect(() => {
    if (moving !== null) {
      return;
    }
    const last = refocus.current;
    refocus.current = null;
    if (last === null || body.current === null) {
      return;
    }
    const button = (direction: Direction) =>
      body.current?.querySelector<HTMLButtonElement>(
        // Slugs and codes are `[a-z0-9-]`: nothing in the key needs escaping.
        `[data-move="${moveKey(last.slug, last.code, direction)}"]`,
      );
    const same = button(last.direction);
    const other = button(last.direction === 'up' ? 'down' : 'up');
    (same !== null && same !== undefined && !same.disabled ? same : other)?.focus();
  }, [moving]);

  const edit = (target: TitleTarget) => {
    if (!gate.ready) {
      gate.prompt();
      return;
    }
    setProblem(null);
    setEditing(target);
  };

  const move = (spec: Spec, code: string, direction: Direction) => {
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (moving !== null) {
      return;
    }
    const writes = planMove(spec.milestones, code, direction);
    if (writes === null || writes.length === 0) {
      return;
    }
    const fields = gate.fields;
    const at: Moving = { slug: spec.slug, code, direction };
    setMoving(at);
    setProblem(null);
    // One write per milestone whose order changes, in turn: each is its own
    // event in that milestone's history. A refusal stops the rest, and the
    // re-read shows the server's order either way.
    let landed = 0;
    writes
      .reduce<Promise<unknown>>(
        (previous, write) =>
          previous.then(() =>
            updateMilestone(
              project,
              spec.slug,
              write.code,
              { order: write.order, note: write.note },
              fields,
            ).then(() => {
              landed += 1;
            }),
          ),
        Promise.resolve(),
      )
      .catch((cause: unknown) => {
        const part = landed > 0 ? ' (part of it landed: the list shows the server’s order)' : '';
        setProblem(
          `Could not move ${spec.slug}/${code} ${direction}${part}: ${asApiError(cause).message}`,
        );
      })
      .finally(() => {
        refocus.current = at;
        onChanged();
      });
  };

  if (specs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="file-text"
          title="No specs yet"
          message="Specs and their milestones are created by the project’s manager through the MCP tools."
        />
      </Card>
    );
  }
  return (
    <div className={styles.tabBody} ref={body}>
      {problem !== null && (
        <p className={cx(frame.notice, frame.notice_warn)} role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{problem}</span>
        </p>
      )}
      {specs.map((spec) => (
        <section
          key={spec.slug}
          className={frame.section}
          aria-label={spec.title}
          data-slug={spec.slug}
        >
          <div className={cx(styles.docRow)}>
            <Link to={docPath(project, spec.path)} className={styles.docTitle}>
              {spec.title}
            </Link>
            <code className={styles.docPath}>{spec.path}</code>
            <span className={styles.docMeta}>
              <StateBadge state={spec.state} />
              <ApprovalBadge approval={spec.approval} />
            </span>
            <span className={styles.rowActions}>
              <IconButton
                icon="pencil"
                label={`Edit the title of ${spec.slug}`}
                variant="ghost"
                size={14}
                onClick={() => edit({ kind: 'spec', record: spec })}
              />
            </span>
          </div>
          {spec.milestones.length > 0 && (
            <ul className={styles.milestones} aria-label={`${spec.title} milestones`}>
              {spec.milestones.map((milestone, index) => (
                <li key={milestone.code} className={styles.docRow} data-code={milestone.code}>
                  <code className={styles.code}>{milestone.code}</code>
                  <Link to={docPath(project, milestone.path)} className={styles.docTitle}>
                    {milestone.title}
                  </Link>
                  <span className={styles.docMeta}>
                    <StateBadge state={milestone.state} />
                    <ApprovalBadge approval={milestone.approval} always />
                  </span>
                  <span className={styles.rowActions}>
                    <IconButton
                      icon="pencil"
                      label={`Edit the title of ${spec.slug}/${milestone.code}`}
                      variant="ghost"
                      size={14}
                      onClick={() => edit({ kind: 'milestone', record: milestone })}
                    />
                    <IconButton
                      icon="chevron-up"
                      label={`Move ${spec.slug}/${milestone.code} up`}
                      variant="ghost"
                      size={14}
                      disabled={index === 0 || moving !== null}
                      data-move={moveKey(spec.slug, milestone.code, 'up')}
                      onClick={() => move(spec, milestone.code, 'up')}
                    />
                    <IconButton
                      icon="chevron-down"
                      label={`Move ${spec.slug}/${milestone.code} down`}
                      variant="ghost"
                      size={14}
                      disabled={index === spec.milestones.length - 1 || moving !== null}
                      data-move={moveKey(spec.slug, milestone.code, 'down')}
                      onClick={() => move(spec, milestone.code, 'down')}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {editing !== null && (
        <TitleDialog
          key={`${editing.kind}:${editing.record.path}`}
          target={editing}
          onCancel={() => setEditing(null)}
          onDone={(left) => {
            setEditing(null);
            setProblem(left);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// ---- Free-standing documents ------------------------------------------------

function OtherTab({ project, docs }: { project: string; docs: readonly TrackerDocument[] }) {
  const format = useFormat();
  if (docs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="file-text"
          title="No other documents"
          message="Documents that belong to no spec or concept are created through the MCP tools."
        />
      </Card>
    );
  }
  return (
    <section className={frame.section} aria-label="Other documents">
      <ul className={styles.rows}>
        {docs.map((doc) => (
          <li key={doc.id} className={styles.docRow}>
            <Link to={docPath(project, doc.path)} className={styles.docTitle}>
              {doc.title}
            </Link>
            <code className={styles.docPath}>{doc.path}</code>
            <span className={styles.docMeta}>
              revision {doc.revision}
              <time dateTime={doc.updated_at}>{format.stamp(doc.updated_at)}</time>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
