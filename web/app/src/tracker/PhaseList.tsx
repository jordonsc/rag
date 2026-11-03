import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Icon } from '@rag/ui';
import { Link, useNavigate } from 'react-router';

import { cx } from '../util';
import { phasePath } from './paths';
import { placeFor } from './QueueList';
import styles from './roadmap.module.css';
import stat from './stat.module.css';
import frame from './tracker.module.css';
import type { PhaseFigures, Place } from './types';
import { etaParts, ETA_TOOLTIP, joinParts } from './velocity';

export interface PhaseListProps {
  project: string;
  /** The planned phases as they are to be drawn, the roadmap's first first. */
  phases: readonly PhaseFigures[];
  /** Drag and Alt+arrows on. Off while a move is in flight. */
  reorderable: boolean;
  /** Why it is off, when it is: the grip's hint says so. */
  reorderHint?: string;
  /**
   * The server's order, as a key: a change mid-drag cancels the drag. Only the
   * order: the figures move every read, and a drag must survive those.
   */
  revision: string;
  /** One move: the place to send, and the order to show until the server answers. */
  onMove: (phase: PhaseFigures, place: Place, order: string[]) => void;
  /** A drag was cancelled because the server's order changed under it. */
  onInterrupted: () => void;
}

interface DragState {
  id: string;
  index: number;
  dy: number;
  target: number;
}

interface DragGeometry {
  pointerId: number;
  startY: number;
  /** Page coordinates, measured when the drag began. */
  rects: Array<{ top: number; height: number }>;
  shift: number;
}

function reordered(phases: readonly PhaseFigures[], from: number, to: number): string[] {
  const ids = phases.map((phase) => phase.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved!);
  return ids;
}

/** How near the viewport's edge a drag scrolls the page, and by how much. */
const EDGE = 56;
const SCROLL_STEP = 14;

/** "ETA 6 days", the unknown "—" read aloud as a word. */
export function PhaseEta({ days }: { days: number | null }) {
  const parts = etaParts(days);
  return (
    <span className={styles.eta} title={ETA_TOOLTIP}>
      {'ETA '}
      {parts.spoken === undefined ? (
        joinParts(parts)
      ) : (
        <>
          <span aria-hidden="true">{parts.value}</span>
          <span className={stat.hidden}>{parts.spoken}</span>
        </>
      )}
    </span>
  );
}

/**
 * The planned phases, in the roadmap's order (spec:roadmap RM-44): the title, how
 * many tickets are frozen in each (and its drafts, when any) and its cumulative
 * ETA.
 *
 * The queue's reordering, over phases: **drag** by the grip with a mouse, a pen
 * or a finger (pointer events), the rows it passes stepping aside, Escape
 * cancelling; **Alt+↑ / Alt+↓** on a focused row; each one `move`. A drop lands
 * `before` the first row at the top and `after` the row above elsewhere, shown in
 * its new place until the server answers. If the server's order changes during a
 * drag, the drag is cancelled rather than dropped against neighbours that may
 * have moved.
 *
 * Its own component rather than a generalised `QueueList`: that one is bound to
 * tickets through its row, its menu and its approval.
 */
export function PhaseList({
  project,
  phases,
  reorderable,
  reorderHint,
  revision,
  onMove,
  onInterrupted,
}: PhaseListProps) {
  const navigate = useNavigate();
  const rows = useRef(new Map<string, HTMLLIElement>());
  const geometry = useRef<DragGeometry | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const [focusId, setFocusId] = useState<string | null>(null);

  const cancel = useCallback(() => {
    geometry.current = null;
    setDrag(null);
  }, []);

  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) {
      return;
    }
    seen.current = revision;
    if (dragRef.current !== null) {
      cancel();
      onInterrupted();
    }
  }, [revision, cancel, onInterrupted]);

  // Keyboard moves keep the focus on the row that moved.
  useLayoutEffect(() => {
    if (focusId !== null) {
      rows.current.get(focusId)?.focus();
      setFocusId(null);
    }
  }, [focusId, phases]);

  const finish = useCallback(() => {
    const state = dragRef.current;
    geometry.current = null;
    setDrag(null);
    if (state === null || state.target === state.index) {
      return;
    }
    const phase = phases[state.index];
    if (phase === undefined) {
      return;
    }
    const others = phases.filter((_, at) => at !== state.index);
    const place = placeFor(others, state.target);
    if (place !== null) {
      onMove(phase, place, reordered(phases, state.index, state.target));
    }
  }, [phases, onMove]);

  useEffect(() => {
    if (drag === null) {
      return undefined;
    }
    const onPointerMove = (event: PointerEvent) => {
      const geo = geometry.current;
      const state = dragRef.current;
      if (geo === null || state === null || event.pointerId !== geo.pointerId) {
        return;
      }
      if (event.clientY < EDGE) {
        window.scrollBy(0, -SCROLL_STEP);
      } else if (event.clientY > window.innerHeight - EDGE) {
        window.scrollBy(0, SCROLL_STEP);
      }
      const dy = event.clientY + window.scrollY - geo.startY;
      const own = geo.rects[state.index]!;
      const middle = own.top + dy + own.height / 2;
      let target = 0;
      geo.rects.forEach((rect, at) => {
        if (at !== state.index && rect.top + rect.height / 2 < middle) {
          target += 1;
        }
      });
      setDrag({ ...state, dy, target });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (geometry.current !== null && event.pointerId === geometry.current.pointerId) {
        finish();
      }
    };
    const onPointerCancel = () => cancel();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel();
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKey);
    };
    // Bound once per drag (keyed on its id), not once per pointer move: the
    // handlers read the moving state through refs.
  }, [drag?.id, finish, cancel]);

  const start = (event: ReactPointerEvent, index: number) => {
    if (!reorderable || phases.length < 2) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const rects = phases.map((phase) => {
      const rect = rows.current.get(phase.id)?.getBoundingClientRect();
      return { top: (rect?.top ?? 0) + window.scrollY, height: rect?.height ?? 0 };
    });
    const first = rects[0]!;
    const second = rects[1];
    const gap = second === undefined ? 0 : Math.max(0, second.top - (first.top + first.height));
    geometry.current = {
      pointerId: event.pointerId,
      startY: event.clientY + window.scrollY,
      rects,
      shift: rects[index]!.height + gap,
    };
    setDrag({ id: phases[index]!.id, index, dy: 0, target: index });
  };

  const offset = (at: number): CSSProperties | undefined => {
    if (drag === null || geometry.current === null) {
      return undefined;
    }
    if (at === drag.index) {
      return { transform: `translateY(${drag.dy}px)` };
    }
    const shift = geometry.current.shift;
    if (drag.index < drag.target && at > drag.index && at <= drag.target) {
      return { transform: `translateY(${-shift}px)` };
    }
    if (drag.target < drag.index && at >= drag.target && at < drag.index) {
      return { transform: `translateY(${shift}px)` };
    }
    return undefined;
  };

  const keyMove = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.key === 'Enter') {
      if (event.target === event.currentTarget) {
        navigate(phasePath(project, phases[index]!.id));
      }
      return;
    }
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    event.preventDefault();
    if (!reorderable) {
      return;
    }
    const phase = phases[index]!;
    if (event.key === 'ArrowUp' && index > 0) {
      setFocusId(phase.id);
      onMove(phase, { before: phases[index - 1]!.id }, reordered(phases, index, index - 1));
    } else if (event.key === 'ArrowDown' && index < phases.length - 1) {
      setFocusId(phase.id);
      onMove(phase, { after: phases[index + 1]!.id }, reordered(phases, index, index + 1));
    }
  };

  return (
    <ol className={cx(styles.list, drag !== null && frame.dragging)} aria-label="Planned phases">
      {phases.map((phase, index) => (
        <li
          key={phase.id}
          ref={(node) => {
            if (node === null) {
              rows.current.delete(phase.id);
            } else {
              rows.current.set(phase.id, node);
            }
          }}
          className={cx(styles.phase, styles.planned, drag?.id === phase.id && frame.lifted)}
          style={offset(index)}
          tabIndex={0}
          data-id={phase.id}
          data-index={index}
          aria-label={`Phase ${phase.id}: ${phase.title}`}
          onKeyDown={(event) => keyMove(event, index)}
        >
          <button
            type="button"
            className={frame.grip}
            aria-label={`Drag ${phase.id} to reorder`}
            title={reorderable ? 'Drag to reorder · Alt+↑ / Alt+↓' : reorderHint}
            disabled={!reorderable}
            onPointerDown={(event) => start(event, index)}
          >
            <Icon name="grip-vertical" size={14} />
          </button>
          <Link to={phasePath(project, phase.id)} className={styles.phaseTitle}>
            {phase.title}
          </Link>
          <span className={styles.facts}>
            <span>{`${phase.size.frozen} frozen`}</span>
            {phase.size.drafts > 0 && (
              <span>{`${phase.size.drafts} ${phase.size.drafts === 1 ? 'draft' : 'drafts'}`}</span>
            )}
            <PhaseEta days={phase.eta_days} />
          </span>
        </li>
      ))}
    </ol>
  );
}
