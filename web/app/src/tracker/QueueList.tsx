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
import { Badge, Icon } from '@rag/ui';
import { Link, useNavigate } from 'react-router';

import { cx } from '../util';
import type { ApprovalAction } from './dialogs';
import { ApprovalControl, ParallelBadge, SecondLine, StatusDot } from './parts';
import { itemPath } from './paths';
import { RowMenu, type RowMenuAction } from './RowMenu';
import styles from './tracker.module.css';
import type { Item, Place } from './types';
import { dotState, gateTitle, intensityLabel } from './vocab';

export interface QueueListProps {
  project: string;
  /** The queue as it is to be drawn, head first. */
  items: readonly Item[];
  /** Drag and Alt+arrows on. Off while filtered or while a move is in flight. */
  reorderable: boolean;
  /** Why it is off, when it is: the grip's hint says so. */
  reorderHint?: string;
  /** The server view's revision: a change mid-drag cancels the drag. */
  revision: number;
  /** One move: the place to send, and the order to show until the server answers. */
  onMove: (item: Item, place: Place, order: string[]) => void;
  onRemove: (item: Item) => void;
  /** Defer it (rag-t0017): it leaves the drawn queue for Deferred, keeping its place. */
  onDefer: (item: Item) => void;
  /** The owner's approval from the row: the Agent-approved badge, or Approve. */
  onApproval: (item: Item, action: ApprovalAction) => void;
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

/** Where a drop at `target` (an index in the list without the dragged row) goes. */
export function placeFor(others: readonly Item[], target: number): Place | null {
  if (others.length === 0) {
    return null;
  }
  return target <= 0 ? { before: others[0]!.id } : { after: others[target - 1]!.id };
}

function reordered(items: readonly Item[], from: number, to: number): string[] {
  const ids = items.map((item) => item.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved!);
  return ids;
}

/** A gate marker's name: `Standard gate`, or `Gate` with no intensity. */
function markerName(item: Item): string {
  return item.intensity === null ? 'Gate' : `${intensityLabel(item.intensity)} gate`;
}

/**
 * A gate's title when it says more than its marker does (rag-t0015): `null`
 * for the marker's own name and for the title Add gate writes by default
 * (`Standard gate and release`), which the name and Release badge already say.
 */
export function gateOwnTitle(item: Item): string | null {
  const title = item.title.trim();
  const said = [markerName(item)];
  if (item.intensity !== null) {
    said.push(gateTitle(item.intensity, item.release));
  }
  if (title === '' || said.some((name) => name.toLowerCase() === title.toLowerCase())) {
    return null;
  }
  return title;
}

export interface GateMarkerProps {
  project: string;
  /** The gate. */
  item: Item;
  /**
   * `queue` (the default) draws it in `--rag-extra`, the purple no status
   * uses; `done` draws the same line in the done status's green, for a
   * finished gate under Done (rag-t0021).
   */
  variant?: 'queue' | 'done';
}

/**
 * A gate's line across a list (D14): a dashed rule, its label, a dashed rule.
 * The label links to the item page and says the intensity, the gate's own
 * title (rag-t0015), Release, a state other than pending, and the id; on a
 * phone the title takes a line of its own (rag-t0019). Its container is the
 * caller's, an element with the `marker` class: the queue adds a grip and a
 * menu either side, Done adds nothing.
 */
export function GateMarker({ project, item, variant = 'queue' }: GateMarkerProps) {
  const tone = variant === 'done' ? styles.markerDone : undefined;
  return (
    <>
      <span className={cx(styles.rule, tone)} aria-hidden />
      <Link to={itemPath(project, item.id)} className={cx(styles.markerLabel, tone)}>
        <Icon name="flag" size={13} />
        <span className={styles.markerName}>{markerName(item)}</span>
        {gateOwnTitle(item) !== null && (
          <span className={styles.markerTitle} title={item.title}>
            {item.title}
          </span>
        )}
        {item.release && (
          <span className={styles.release}>
            <Badge tone="acc">Release</Badge>
          </span>
        )}
        {item.status !== 'pending' && <StatusDot state={dotState(item)} compact />}
        <code className={styles.markerId}>{item.id}</code>
      </Link>
      <span className={cx(styles.rule, tone)} aria-hidden />
    </>
  );
}

/** How near the viewport's edge a drag scrolls the page, and by how much. */
const EDGE = 56;
const SCROLL_STEP = 14;

/**
 * The queue, in list order, with its gates drawn as markers (D14, TD-03, TD-04).
 *
 * **Reordering, three ways, each one `move` call:**
 * * **Drag** a row or a marker by its grip, with a mouse, a pen or a finger
 *   (pointer events; the grip takes `touch-action: none` so a finger drags
 *   rather than scrolls). While it moves, the rows it passes step aside, so
 *   the gap is where it will land. A drop sends `before` the first row when it
 *   lands at the top and `after` the row above it otherwise. Escape cancels.
 * * **Alt+↑ / Alt+↓** on a focused row: `before` the row above, `after` the
 *   row below.
 * * **The row's menu**: Move to top, Move to bottom.
 *
 * **A row is two lines** (rag-t0026): the status, the id, the title (taking
 * the free width), the approval and the menu; then the type, the assignee and
 * the Parallel badge, with the labels at the right (rag-t0031: a row draws
 * no link chips, which are on the item's page). A gate marker stays
 * one line. An in-progress row is tinted blue across both (rag-t0023).
 *
 * A row's approval is {@link ApprovalControl}: the Agent-approved badge
 * ratifies and Approve approves, each through the caller's dialog. It keeps
 * the first line's right edge, left of the menu. The ledger chips, which sat
 * left of it on the one line (rag-t0016) and then at the second line's right
 * end (rag-t0026), are gone from the row (rag-t0031); the labels hold that end.
 * A marker names its gate's own title, cut to one line (rag-t0015); on a
 * phone the title takes a line of its own and the id stays (rag-t0019). A
 * row marked parallel carries a Parallel badge (rag-t0013).
 *
 * A drop is shown in its new place until the server answers; then the list
 * is the server's again, whatever it said. If the server's order changes
 * *during* a drag (a manager's write landing), the drag is cancelled rather
 * than dropped against neighbours that are no longer there.
 */
export function QueueList({
  project,
  items,
  reorderable,
  reorderHint,
  revision,
  onMove,
  onRemove,
  onDefer,
  onApproval,
  onInterrupted,
}: QueueListProps) {
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

  // A new server order mid-drag: the neighbours the drop would name may have
  // moved, so the drag ends and the reader is told why.
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
  }, [focusId, items]);

  const finish = useCallback(() => {
    const state = dragRef.current;
    geometry.current = null;
    setDrag(null);
    if (state === null || state.target === state.index) {
      return;
    }
    const item = items[state.index];
    if (item === undefined) {
      return;
    }
    const others = items.filter((_, at) => at !== state.index);
    const place = placeFor(others, state.target);
    if (place !== null) {
      onMove(item, place, reordered(items, state.index, state.target));
    }
  }, [items, onMove]);

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
    if (!reorderable || items.length < 2) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const rects = items.map((item) => {
      const rect = rows.current.get(item.id)?.getBoundingClientRect();
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
    setDrag({ id: items[index]!.id, index, dy: 0, target: index });
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
    if (event.target !== event.currentTarget && event.key === 'Enter') {
      return;
    }
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      navigate(itemPath(project, items[index]!.id));
      return;
    }
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    event.preventDefault();
    if (!reorderable) {
      return;
    }
    const item = items[index]!;
    if (event.key === 'ArrowUp' && index > 0) {
      setFocusId(item.id);
      onMove(item, { before: items[index - 1]!.id }, reordered(items, index, index - 1));
    } else if (event.key === 'ArrowDown' && index < items.length - 1) {
      setFocusId(item.id);
      onMove(item, { after: items[index + 1]!.id }, reordered(items, index, index + 1));
    }
  };

  const menu = (item: Item, index: number): RowMenuAction[] => [
    {
      id: 'open',
      label: 'Open',
      icon: 'arrow-right',
      onSelect: () => navigate(itemPath(project, item.id)),
    },
    {
      id: 'top',
      label: 'Move to top',
      icon: 'arrow-up-to-line',
      disabled: index === 0,
      onSelect: () => onMove(item, { top: true }, reordered(items, index, 0)),
    },
    {
      id: 'bottom',
      label: 'Move to bottom',
      icon: 'arrow-down-to-line',
      disabled: index === items.length - 1,
      onSelect: () => onMove(item, { bottom: true }, reordered(items, index, items.length - 1)),
    },
    {
      id: 'defer',
      label: item.type === 'gate' ? 'Defer gate' : 'Defer',
      icon: 'circle-pause',
      onSelect: () => onDefer(item),
    },
    {
      id: 'remove',
      label: item.type === 'gate' ? 'Remove gate' : 'Remove',
      icon: 'trash',
      danger: true,
      onSelect: () => onRemove(item),
    },
  ];

  return (
    <ol className={cx(styles.queue, drag !== null && styles.dragging)} aria-label="Queue">
      {items.map((item, index) => {
        const gate = item.type === 'gate';
        const dragged = drag?.id === item.id;
        const grip = (
          <button
            type="button"
            className={styles.grip}
            aria-label={`Drag ${item.id} to reorder`}
            title={reorderable ? 'Drag to reorder · Alt+↑ / Alt+↓' : reorderHint}
            disabled={!reorderable}
            onPointerDown={(event) => start(event, index)}
          >
            <Icon name="grip-vertical" size={14} />
          </button>
        );
        const actions = <RowMenu label={`Actions for ${item.id}`} actions={menu(item, index)} />;
        return (
          <li
            key={item.id}
            ref={(node) => {
              if (node === null) {
                rows.current.delete(item.id);
              } else {
                rows.current.set(item.id, node);
              }
            }}
            className={cx(
              gate ? styles.marker : styles.row,
              !gate && item.status === 'in_progress' && styles.rowInProgress,
              dragged && styles.lifted,
            )}
            style={offset(index)}
            tabIndex={0}
            data-id={item.id}
            data-index={index}
            aria-label={`${gate ? 'Gate' : 'Item'} ${item.id}: ${item.title}`}
            onKeyDown={(event) => keyMove(event, index)}
          >
            {gate ? (
              <>
                {grip}
                <GateMarker project={project} item={item} />
                {actions}
              </>
            ) : (
              <>
                {grip}
                <span className={styles.cellStatus}>
                  <StatusDot state={dotState(item)} />
                </span>
                <code className={styles.cellId}>{item.id}</code>
                <Link to={itemPath(project, item.id)} className={styles.cellTitle}>
                  {item.title}
                </Link>
                <span className={styles.cellMeta}>
                  <ApprovalControl
                    id={item.id}
                    approval={item.approval}
                    onRatify={() => onApproval(item, 'ratify')}
                    onApprove={() => onApproval(item, 'approve')}
                  />
                </span>
                {actions}
                <SecondLine project={project} item={item}>
                  {item.parallel === true && <ParallelBadge />}
                </SecondLine>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
