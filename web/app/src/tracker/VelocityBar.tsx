/**
 * The velocity widget (spec:velocity D11–D14): one row under the queue page's
 * header, `Velocity 8/day · In progress 3 · Pending 48 · ETA 7 days`, the
 * window pill (`7 d` | `24 h`) and **Report**. Each figure is a `Stat`
 * (`Stat.tsx`, owner request rag-t0062): the label muted and the value
 * emphasised, as the report's tiles set them, and read as "Velocity: 8/day".
 *
 * The pill moves Velocity and ETA only; the counts are what is open now,
 * whatever the window (D13, C5). The choice is kept per browser for every
 * project (`velocity.ts`). Each figure explains itself on hover (D14). On a
 * phone the row wraps between figures, never inside one.
 *
 * It draws what it is given: the read and its refresh are `useVelocity`'s,
 * and whether the row shows at all is the queue page's (D11).
 */

import { useState } from 'react';
import { Button, Segmented } from '@rag/ui';
import { useNavigate } from 'react-router';

import { reportPath } from './paths';
import { Stat } from './Stat';
import styles from './tracker.module.css';
import type { Velocity, VelocityWindow } from './types';
import {
  etaParts,
  isVelocityWindow,
  readVelocityWindow,
  storeVelocityWindow,
  velocityParts,
  velocityTooltips,
  WINDOW_OPTIONS,
} from './velocity';

/**
 * Whether the report page exists: it does since m03 (`ReportView.tsx`). Kept
 * as a switch so the button can be hidden again without touching the row.
 */
const REPORT_READY = true;

export function VelocityBar({ project, velocity }: { project: string; velocity: Velocity }) {
  const navigate = useNavigate();
  const [choice, setChoice] = useState<VelocityWindow>(readVelocityWindow);
  const figures = velocity.windows[choice];
  const tips = velocityTooltips(velocity);

  const choose = (value: string) => {
    if (isVelocityWindow(value)) {
      setChoice(value);
      storeVelocityWindow(value);
    }
  };

  return (
    <div className={styles.velocity} role="group" aria-label="Velocity">
      <ul className={styles.velocityFigures} aria-label="Figures">
        <Stat
          variant="inline"
          label="Velocity"
          {...velocityParts(figures.velocity_per_day)}
          title={tips.velocity}
        />
        <Stat
          variant="inline"
          label="In progress"
          value={String(velocity.in_progress)}
          unit=""
          title={tips.inProgress}
        />
        <Stat
          variant="inline"
          label="Pending"
          value={String(velocity.pending)}
          unit=""
          title={tips.pending}
        />
        <Stat variant="inline" label="ETA" {...etaParts(figures.eta_days)} title={tips.eta} />
      </ul>
      <Segmented
        value={choice}
        onChange={choose}
        options={WINDOW_OPTIONS}
        label="Velocity window"
      />
      {REPORT_READY && (
        <Button size="sm" onClick={() => void navigate(reportPath(project, choice))}>
          Report
        </Button>
      )}
    </div>
  );
}
