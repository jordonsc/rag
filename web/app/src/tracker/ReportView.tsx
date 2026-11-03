import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Card, ErrorState, Icon, Panel, Segmented, Spinner } from '@rag/ui';
import { Link, useParams, useSearchParams } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { cx } from '../util';
import { getReport, getVelocity, isProjectName, PROJECT_NAME_ERROR } from './api';
import { BurnDown, RangeBars, type BurnPoint, type RangeRow } from './charts';
import { projectPath, storeLastProject } from './paths';
import styles from './report.module.css';
import { dayLabels, hourLabels, localDays } from './reportMath';
import { RETURN_STATE } from './scrollMemory';
import { SplitStat, Stat } from './Stat';
import stat from './stat.module.css';
import frame from './tracker.module.css';
import {
  REPORT_STATES,
  type Report as ReportRecord,
  type ReportState,
  type Velocity,
  type VelocityWindow,
} from './types';
import {
  durationParts,
  etaParts,
  formatElapsed,
  isVelocityWindow,
  readVelocityWindow,
  storeVelocityWindow,
  velocityParts,
  velocityTooltips,
  WINDOW_OPTIONS,
} from './velocity';

/** The states' names on the page, in the report's order (D17). */
const STATE_LABEL: Record<ReportState, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  review: 'Review',
  deferred: 'Deferred',
  blocked: 'Blocked',
};

/** "1 ticket", "3 tickets". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "ticket" or "tickets", for a tile's unit. */
function noun(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The window in words, for the notes: "the last 7 days". */
function windowWords(choice: VelocityWindow): string {
  return choice === '7d' ? 'the last 7 days' : 'the last 24 hours';
}

/**
 * The burn-down's periods (D16): local days for 7 days (the server's hourly
 * UTC buckets summed at the reader's midnights), the hours themselves for 24.
 */
export function burnPoints(report: ReportRecord): BurnPoint[] {
  if (report.window === '7d') {
    return localDays(report.buckets).map((d) => ({
      key: d.day,
      ...dayLabels(d.day),
      remaining: d.remaining,
      added: d.added,
      done: d.done,
    }));
  }
  return report.buckets.map((b) => ({
    key: b.start,
    ...hourLabels(b.start),
    remaining: b.remaining,
    added: b.added,
    done: b.done,
  }));
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; report: ReportRecord; velocity: Velocity }
  | { kind: 'error'; error: LedgerApiError };

/** The route: a project name the server would refuse never becomes a request. */
export function ReportView() {
  const { project = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <Report key={project} project={project} />;
}

/**
 * A project's velocity report (spec:velocity D19): reached from the queue
 * widget's **Report**, not a project tab, with a link back to the queue.
 *
 * The window is the widget's (`7 d` | `24 h`): `?window=` when the address
 * names one, else the choice this browser keeps (`velocity.ts`), and the pill
 * writes both. Every block follows it (R10), each with its counts, so a small
 * sample is plain.
 *
 * * **The figures** across the top as tiles (`Stat.tsx`, rag-t0062), worded
 *   as the widget words them: velocity and ETA over the window, the counts
 *   now, and the window's done.
 * * **Burn-down**: remaining at the end of each local day (or hour), over
 *   bars of tickets added and done in it.
 * * **Time in each state**: the mean, median and 90th percentile of the
 *   stretches that ended in the window, and those still open, as chips.
 * * **Completion and resolution**: MTTC, those done without being in
 *   progress, MTTR, and confirmed against sent back, as tiles.
 *
 * One read of the report and one of the velocity (for the counts now), in
 * parallel, on open and on each change of window. Not polled: it is a
 * report, and switching the window or reloading reads it afresh.
 */
function Report({ project }: { project: string }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('window');
  const choice: VelocityWindow = isVelocityWindow(asked) ? asked : readVelocityWindow();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => storeLastProject(project), [project]);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ kind: 'loading' });
    Promise.all([
      getReport(project, choice, controller.signal),
      getVelocity(project, controller.signal),
    ])
      .then(([report, velocity]) => setLoaded({ kind: 'ready', report, velocity }))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [project, choice, attempt]);

  const choose = (value: string) => {
    if (!isVelocityWindow(value)) {
      return;
    }
    storeVelocityWindow(value);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('window', value);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className={frame.view}>
      <header className={frame.head}>
        <div className={frame.headTitle}>
          <Icon name="clock" size={18} />
          <h1 className={frame.title}>{project} report</h1>
        </div>
        <div className={frame.headControls}>
          {/* A way back: the queue returns to where it was left (rag-t0040). */}
          <Link to={projectPath(project)} state={RETURN_STATE} className={styles.back}>
            <Icon name="arrow-left" size={14} />
            Back to the queue
          </Link>
          <Segmented
            value={choice}
            onChange={choose}
            options={WINDOW_OPTIONS}
            label="Report window"
          />
        </div>
      </header>

      {loaded.kind === 'loading' && (
        <div className={frame.loading}>
          <Spinner size={18} />
          <span>Loading {project}’s report…</span>
        </div>
      )}

      {loaded.kind === 'error' && (
        <Card>
          <ErrorState
            message={`Could not load ${project}’s report.`}
            detail={loaded.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </Card>
      )}

      {loaded.kind === 'ready' && (
        <Blocks report={loaded.report} velocity={loaded.velocity} choice={choice} />
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel header={<h2 className={styles.blockTitle}>{title}</h2>}>
      <div className={styles.block}>{children}</div>
    </Panel>
  );
}

function Blocks({
  report,
  velocity,
  choice,
}: {
  report: ReportRecord;
  velocity: Velocity;
  choice: VelocityWindow;
}) {
  const points = useMemo(() => burnPoints(report), [report]);
  const tips = velocityTooltips(velocity);
  const figures = report.velocity;
  const span = windowWords(choice);
  const rows: RangeRow[] = REPORT_STATES.map((state) => {
    const s = report.states[state];
    return {
      key: state,
      label: STATE_LABEL[state],
      count: s.count,
      mean: s.mean_seconds,
      median: s.median_seconds,
      p90: s.p90_seconds,
    };
  });
  const { mttc, mttr } = report;
  const openId = useId();

  return (
    <>
      <ul className={stat.tiles} aria-label="Figures">
        <Stat label="Velocity" {...velocityParts(figures.velocity_per_day)} title={tips.velocity} />
        <Stat
          label="In progress"
          value={String(velocity.in_progress)}
          unit=""
          title={tips.inProgress}
        />
        <Stat label="Pending" value={String(velocity.pending)} unit="" title={tips.pending} />
        <Stat label="ETA" {...etaParts(figures.eta_days)} title={tips.eta} />
        <Stat
          label="Done"
          value={String(figures.done)}
          unit={noun(figures.done, 'ticket', 'tickets')}
          title={`Over ${formatElapsed(figures.active_seconds)} of active time in ${span}.`}
        />
      </ul>

      <Block title="Burn-down">
        <p className={styles.note}>
          {choice === '7d'
            ? 'Tickets remaining at the end of each day, in your time zone, and the tickets added and done that day. Today is so far.'
            : 'Tickets remaining at the end of each hour, and the tickets added and done in it. This hour is so far.'}
        </p>
        <BurnDown
          points={points}
          caption={`Burn-down over ${span}`}
          period={choice === '7d' ? 'Day' : 'Hour'}
        />
        {figures.done === 0 && <p className={styles.empty}>No tickets were done in this window.</p>}
      </Block>

      <Block title="Time in each state">
        <p className={styles.note}>
          {`How long tickets spent in each state, over the stretches that ended in ${span}. `}A
          blocked ticket is also in its status for that time.
        </p>
        <RangeBars rows={rows} caption={`Time in each state over ${span}`} format={formatElapsed} />
        <div className={styles.openRow}>
          <span id={openId} className={styles.openTitle}>
            Still open
          </span>
          <ul className={styles.open} aria-labelledby={openId}>
            {REPORT_STATES.map((state) => {
              const s = report.states[state];
              const none = s.open === 0 || s.oldest_open_seconds === null;
              const oldest = none ? '' : formatElapsed(s.oldest_open_seconds ?? 0);
              return (
                <li
                  key={state}
                  className={cx(styles.chip, none && styles.chipNone)}
                  aria-label={
                    none
                      ? `${STATE_LABEL[state]}: none still open`
                      : `${STATE_LABEL[state]}: ${s.open} still open, the oldest ${oldest}`
                  }
                >
                  <span className={styles.chipState}>{STATE_LABEL[state]}</span>
                  {none ? (
                    <span>none</span>
                  ) : (
                    <>
                      <span className={styles.chipCount}>{s.open}</span>
                      <span>{`oldest ${oldest}`}</span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Block>

      <Block title="Completion and resolution">
        <ul className={cx(stat.tiles, stat.tilesWide)} aria-label="Completion and resolution">
          <Stat
            inset
            label="Mean time to completion"
            {...(mttc.mean_seconds === null
              ? { value: '—', unit: '', spoken: 'none' }
              : durationParts(mttc.mean_seconds))}
            detail={
              mttc.mean_seconds === null || mttc.median_seconds === null
                ? ['no ticket done in this window was in progress']
                : [
                    `median ${formatElapsed(mttc.median_seconds)}`,
                    `over ${count(mttc.count, 'ticket', 'tickets')}`,
                  ]
            }
            title={`Time in progress, since each was last reopened, of the tickets done in ${span}.`}
          />
          <Stat
            inset
            label="Done without being in progress"
            value={String(mttc.never_in_progress)}
            unit={noun(mttc.never_in_progress, 'ticket', 'tickets')}
            detail={['left out of the mean']}
          />
          <Stat
            inset
            label="Mean time to resolution"
            {...(mttr.mean_seconds === null
              ? { value: '—', unit: '', spoken: 'none' }
              : durationParts(mttr.mean_seconds))}
            detail={
              mttr.mean_seconds === null || mttr.median_seconds === null
                ? ['no review ended in this window']
                : [
                    `median ${formatElapsed(mttr.median_seconds)}`,
                    `over ${count(mttr.count, 'review', 'reviews')}`,
                  ]
            }
            title={`Time in review, until confirmed or sent back, of the reviews that ended in ${span}.`}
          />
          <SplitStat
            inset
            label="Reviews ended"
            parts={[
              { count: mttr.confirmed, label: 'confirmed', tone: 'good' },
              { count: mttr.sent_back, label: 'sent back', tone: 'warn' },
            ]}
            title={`Of the reviews that ended in ${span}: confirmed done, or sent back to work.`}
          />
        </ul>
      </Block>
    </>
  );
}
