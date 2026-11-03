import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  ErrorState,
  Icon,
  Segmented,
  Spinner,
} from '@rag/ui';
import { Link, useNavigate, useParams } from 'react-router';

import { asApiError } from '../api';
import { cx } from '../util';
import { isProjectName, movePhase, PROJECT_NAME_ERROR, unarchivePhase } from './api';
import { NewPhaseDialog, NoteDialog } from './dialogs';
import { ProjectTabs } from './docParts';
import { TRACKER_IDENTITY_NEEDED, useTrackerGate } from './gate';
import { PageNotice } from './parts';
import { phasePath, storeLastProject } from './paths';
import { PhaseEta, PhaseList } from './PhaseList';
import { ProjectPicker } from './ProjectPicker';
import styles from './roadmap.module.css';
import { useScrollMemory } from './scrollMemory';
import { Stat } from './Stat';
import stat from './stat.module.css';
import frame from './tracker.module.css';
import type { PhaseFigures, Place, Roadmap as RoadmapRecord, VelocityWindow } from './types';
import { useFeedRefresh } from './useFeed';
import { useRoadmap } from './useRoadmap';
import {
  ETA_TOOLTIP,
  etaParts,
  isVelocityWindow,
  readVelocityWindow,
  storeVelocityWindow,
  velocityParts,
  WINDOW_OPTIONS,
} from './velocity';

type Notice = { tone: 'warn' | 'crit'; text: string };

/** The planned phases in `order`, any id the order does not name kept at the end. */
function inOrder(phases: readonly PhaseFigures[], order: readonly string[] | null): PhaseFigures[] {
  if (order === null) {
    return [...phases];
  }
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const placed = order.flatMap((id) => {
    const phase = byId.get(id);
    return phase === undefined ? [] : [phase];
  });
  const named = new Set(order);
  return [...placed, ...phases.filter((phase) => !named.has(phase.id))];
}

/** The route: a project name the server would refuse never becomes a request. */
export function RoadmapView() {
  const { project = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <RoadmapPage key={project} project={project} />;
}

/**
 * A project's roadmap (spec:roadmap D29, RM-43): how far out development is
 * planned, and the phases that plan it.
 *
 * * **The figures** as tiles: the queue's ETA, how many tickets are frozen, how
 *   far out it is planned, the velocity. Durations of active work, never dates
 *   (D24). The window pill is the velocity widget's own choice (spec:velocity
 *   D13): the same key in this browser, for every project.
 * * **Released**, soonest first: how much of each is done, what is open, its ETA.
 * * **Planned**, in the roadmap's order and drag-sortable (`PhaseList`).
 * * **Complete** and **Archived**, folded, an archived row with **Unarchive**.
 *
 * It re-reads on any event in the project's feed (roadmap events included:
 * `useFeed.ts`), settled so a burst costs one read, and every 60 s while visible.
 * Nothing here dispatches work: a frozen ticket is frozen, never queued.
 */
function RoadmapPage({ project }: { project: string }) {
  const [window, setWindow] = useState<VelocityWindow>(readVelocityWindow);
  const { roadmap, error, refresh } = useRoadmap(project, window, null);
  useFeedRefresh(project, () => void refresh());
  useScrollMemory(`roadmap:${project}`, roadmap !== null);
  const gate = useTrackerGate();
  const navigate = useNavigate();

  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [unarchiving, setUnarchiving] = useState<PhaseFigures | null>(null);

  useEffect(() => storeLastProject(project), [project]);

  const choose = (value: string) => {
    if (isVelocityWindow(value)) {
      setWindow(value);
      storeVelocityWindow(value);
    }
  };

  const move = useCallback(
    (phase: PhaseFigures, place: Place, order: string[]) => {
      if (gate.fields === null) {
        gate.prompt();
        return;
      }
      setNotice(null);
      setPendingOrder(order);
      movePhase(project, phase.id, place, gate.fields)
        .then(() => refresh())
        .catch((cause: unknown) => {
          setNotice({
            tone: 'crit',
            text: `${phase.title} was not moved: ${asApiError(cause).message} The list shows the server’s order.`,
          });
          return refresh();
        })
        .finally(() => setPendingOrder(null));
    },
    [gate, project, refresh],
  );

  const interrupted = useCallback(() => {
    setNotice({
      tone: 'warn',
      text: 'The roadmap changed while you were dragging, so nothing was moved. This is the server’s order now.',
    });
  }, []);

  const serverOrder = useMemo(
    () => (roadmap === null ? '' : roadmap.planned.map((phase) => phase.id).join(' ')),
    [roadmap],
  );
  const planned = useMemo(
    () => (roadmap === null ? [] : inOrder(roadmap.planned, pendingOrder)),
    [roadmap, pendingOrder],
  );

  const head = (
    <header className={frame.head}>
      <div className={frame.headTitle}>
        <Icon name="map" size={18} />
        <h1 className={frame.title}>{project}</h1>
      </div>
      <div className={frame.headControls}>
        <ProjectTabs project={project} active="roadmap" />
        <span className={frame.picker}>
          <ProjectPicker current={project} />
        </span>
        <Button size="sm" variant="accent" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} />
          New phase
        </Button>
      </div>
    </header>
  );

  const newPhase = (
    <NewPhaseDialog
      open={adding}
      project={project}
      onCancel={() => setAdding(false)}
      onDone={(phase) => {
        setAdding(false);
        navigate(phasePath(project, phase.id));
      }}
    />
  );

  if (roadmap === null) {
    return (
      <div className={frame.view}>
        {head}
        {error === null ? (
          <div className={frame.loading}>
            <Spinner size={18} />
            <span>Loading {project}’s roadmap…</span>
          </div>
        ) : (
          <Card>
            <ErrorState
              message={`Could not load ${project}’s roadmap.`}
              detail={error.message}
              onRetry={() => void refresh()}
            />
          </Card>
        )}
        {newPhase}
      </div>
    );
  }

  return (
    <div className={frame.view}>
      {head}

      <div className={styles.figures}>
        <Figures roadmap={roadmap} />
        <Segmented
          value={window}
          onChange={choose}
          options={WINDOW_OPTIONS}
          label="Velocity window"
        />
      </div>

      {error !== null && (
        <PageNotice tone="warn">
          Could not refresh: {error.message} Showing the last good figures.
        </PageNotice>
      )}
      {notice !== null && (
        <PageNotice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </PageNotice>
      )}

      {roadmap.released.length > 0 && (
        <section className={cx(frame.section, frame.section_done)} aria-label="Released">
          <header className={frame.sectionHead}>
            <h2 className={frame.sectionTitle}>
              Released <span className={frame.count}>{roadmap.released.length}</span>
            </h2>
          </header>
          <ul className={styles.list}>
            {roadmap.released.map((phase) => (
              <ReleasedRow key={phase.id} project={project} phase={phase} />
            ))}
          </ul>
        </section>
      )}

      <section className={frame.section} aria-label="Planned">
        <header className={frame.sectionHead}>
          <h2 className={frame.sectionTitle}>
            Planned <span className={frame.count}>{planned.length}</span>
          </h2>
        </header>
        {planned.length === 0 ? (
          <>
            <EmptyState
              icon="map"
              title="No planned phases"
              message="A phase is planned work written up and ordered out of the queue: its tickets are frozen, so no agent sees them and no monitor is woken, until it is released."
            />
            <div className={styles.emptyAction}>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                New phase
              </Button>
            </div>
          </>
        ) : (
          <PhaseList
            project={project}
            phases={planned}
            reorderable={pendingOrder === null}
            {...(pendingOrder === null ? {} : { reorderHint: 'A move is being saved.' })}
            revision={serverOrder}
            onMove={move}
            onInterrupted={interrupted}
          />
        )}
        {!gate.ready && <p className={frame.gateNote}>{TRACKER_IDENTITY_NEEDED}</p>}
      </section>

      {roadmap.complete.length > 0 && (
        <Disclosure
          title={`Complete (${roadmap.complete.length})`}
          open={completeOpen}
          onToggle={setCompleteOpen}
        >
          <ul className={styles.list} aria-label="Complete">
            {roadmap.complete.map((phase) => (
              <FoldedRow key={phase.id} project={project} phase={phase} />
            ))}
          </ul>
        </Disclosure>
      )}

      {roadmap.archived.length > 0 && (
        <Disclosure
          title={`Archived (${roadmap.archived.length})`}
          open={archivedOpen}
          onToggle={setArchivedOpen}
        >
          <ul className={styles.list} aria-label="Archived">
            {roadmap.archived.map((phase) => (
              <FoldedRow
                key={phase.id}
                project={project}
                phase={phase}
                onUnarchive={() => {
                  if (gate.ready) {
                    setUnarchiving(phase);
                  } else {
                    gate.prompt();
                  }
                }}
              />
            ))}
          </ul>
        </Disclosure>
      )}

      {newPhase}
      <NoteDialog
        project={project}
        open={unarchiving !== null}
        title="Unarchive this phase?"
        {...(unarchiving === null ? {} : { subject: unarchiving })}
        message={
          <p>
            {unarchiving?.released_at === null
              ? 'It goes back on the roadmap, at the bottom, as a planned phase.'
              : 'It goes back to being a released phase.'}
          </p>
        }
        noteHelp="Why, when it is not obvious. It is kept in the phase’s history."
        confirmLabel="Unarchive"
        onCancel={() => setUnarchiving(null)}
        onSubmit={(note, fields) => unarchivePhase(project, unarchiving!.id, { note }, fields)}
        onDone={() => {
          setUnarchiving(null);
          void refresh();
        }}
      />
    </div>
  );
}

/** The four figures across the top: durations of active work, never dates (D24). */
function Figures({ roadmap }: { roadmap: RoadmapRecord }) {
  return (
    <ul className={stat.tiles} aria-label="Figures">
      <Stat label="Queue ETA" {...etaParts(roadmap.queue.eta_days)} title={ETA_TOOLTIP} />
      <Stat
        label="Frozen"
        value={String(roadmap.frozen)}
        unit={roadmap.frozen === 1 ? 'ticket' : 'tickets'}
        title="Held in planned phases, drafts included: out of the queue and in no queue figure."
      />
      <Stat
        label="Planned out"
        {...etaParts(roadmap.planned_out_days)}
        title={`The queue and every planned phase. ${ETA_TOOLTIP}`}
      />
      <Stat
        label="Velocity"
        {...velocityParts(roadmap.velocity_per_day)}
        title="Tickets done per 24 hours of active time, over the window chosen."
      />
    </ul>
  );
}

/** "12 of 40 done", with a thin bar showing the same. */
function Progress({ phase }: { phase: PhaseFigures }) {
  const { done, total } = phase.size;
  const share = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <>
      <span className={styles.progress} aria-hidden="true">
        <span className={styles.progressDone} style={{ width: `${share}%` }} />
      </span>
      <span className={styles.facts}>
        <span>{`${done} of ${total} done`}</span>
        <span>{`${phase.size.open} open`}</span>
        <PhaseEta days={phase.eta_days} />
      </span>
    </>
  );
}

function ReleasedRow({ project, phase }: { project: string; phase: PhaseFigures }) {
  return (
    <li className={styles.phase} data-id={phase.id}>
      <Link to={phasePath(project, phase.id)} className={styles.phaseTitle}>
        {phase.title}
      </Link>
      <Progress phase={phase} />
    </li>
  );
}

/** A complete or an archived phase: its title, its size, and Unarchive on an archived one. */
function FoldedRow({
  project,
  phase,
  onUnarchive,
}: {
  project: string;
  phase: PhaseFigures;
  onUnarchive?: () => void;
}) {
  return (
    <li className={styles.phase} data-id={phase.id}>
      <Link to={phasePath(project, phase.id)} className={styles.phaseTitle}>
        {phase.title}
      </Link>
      <span className={styles.facts}>
        <span>{`${phase.size.done} of ${phase.size.total} done`}</span>
        {phase.size.cancelled > 0 && <span>{`${phase.size.cancelled} cancelled`}</span>}
      </span>
      {onUnarchive !== undefined && (
        <Button size="sm" aria-label={`Unarchive ${phase.title}`} onClick={onUnarchive}>
          <Icon name="archive-restore" size={14} />
          Unarchive
        </Button>
      )}
    </li>
  );
}
