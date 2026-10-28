import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './overlays.module.css';
import { Button } from './Button';
import { IconButton } from './Button';
import { useT } from '../i18n';
import { cx } from '../util';

interface ScrimLayerProps {
  onDismiss: () => void;
  children: ReactNode;
  align: 'center' | 'end';
  /**
   * A lighter scrim, for a dialog: one can be dragged aside to read the page
   * under it (rag-t0045), and a page under a near-black wash is not read.
   */
  light?: boolean;
}

function ScrimLayer({ onDismiss, children, align, light = false }: ScrimLayerProps) {
  return createPortal(
    <div
      className={cx(styles.scrim, align === 'end' && styles.scrimEnd, light && styles.scrimLight)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Footer content, typically action buttons. */
  footer?: ReactNode;
  width?: number;
}

/**
 * Everything inside `root` that a keyboard can reach, in document order.
 *
 * Read fresh on every Tab rather than cached at open: a dialog's body is
 * declared content that can arrive after the dialog does (a modal whose
 * widgets are still fetching their view), and a trap built from the controls
 * that existed at mount would send focus past the ones that arrived later.
 */
function focusable(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return [...candidates].filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

/**
 * Keep Tab inside an overlay, and give focus back when it closes.
 *
 * **The trap is what makes `aria-modal` true rather than merely declared.** A
 * dialog that says it is modal while Tab walks off into the page behind it is
 * telling assistive technology one thing and doing another, and the page
 * behind a confirmation is the page whose controls the reader has just been
 * asked *not* to use yet.
 *
 * **Focus returns to whatever opened it.** Otherwise closing a dialog drops
 * focus onto `<body>`, and a keyboard user who dismisses a dialog has to tab
 * from the top of the page to get back to the button they pressed.
 */
function useFocusTrap(open: boolean, ref: RefObject<HTMLDivElement | null>) {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    restoreTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      restoreTo.current?.focus();
    };
  }, [open, ref]);

  return (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') {
      return;
    }
    const root = ref.current;
    if (root === null) {
      return;
    }
    const stops = focusable(root);
    if (stops.length === 0) {
      // Nothing to move to: the dialog itself holds focus and keeps it.
      event.preventDefault();
      return;
    }
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

/** Clearance kept between a dragged dialog and the viewport edge, in px. */
const DIALOG_MARGIN = 8;

/** Where a dialog has been dragged to: a translation from where it is laid out. */
export interface DialogOffset {
  x: number;
  y: number;
}

/**
 * The offset a dialog may take so that all of it stays on screen.
 *
 * `home` is the dialog's box where layout puts it (centred, offset zero);
 * `wanted` is the translation the pointer asks for. Each axis is clamped so
 * the box keeps `DIALOG_MARGIN` from every viewport edge. A box larger than
 * the viewport on an axis is pinned to its leading margin there, so its title
 * bar, the handle that moves it, is never the part pushed off screen.
 *
 * Exported because it is the part of dragging a headless test can prove:
 * jsdom has no layout, so the arithmetic is tested directly.
 */
export function clampDialogOffset(
  home: { left: number; top: number; width: number; height: number },
  wanted: DialogOffset,
  viewportWidth: number,
  viewportHeight: number,
): DialogOffset {
  const axis = (start: number, extent: number, want: number, available: number) => {
    const least = DIALOG_MARGIN - start;
    const most = available - DIALOG_MARGIN - extent - start;
    return most < least ? least : Math.min(Math.max(want, least), most);
  };
  return {
    x: axis(home.left, home.width, wanted.x, viewportWidth),
    y: axis(home.top, home.height, wanted.y, viewportHeight),
  };
}

const ORIGIN: DialogOffset = { x: 0, y: 0 };

/**
 * Drag a dialog by its title bar (rag-t0045), so it can be moved aside to
 * read the page under it.
 *
 * Pointer events, so a mouse, a pen and a finger all move it; the header sets
 * `touch-action: none`, so a finger on it drags the dialog rather than
 * scrolling the page. The pointer is captured, so a fast drag that outruns the
 * header keeps moving it. A press on a control in the header (the close
 * button) is the control's, not a drag.
 *
 * The position is a translation, reset to zero each time the dialog opens, so
 * every opening starts centred. It is clamped to the viewport as it moves, and
 * again when the window or the dialog changes size (an error line arriving
 * grows it about its centre), so a dragged dialog is never left off screen.
 * The keyboard is untouched: there is nothing to drag with it, and the focus
 * trap and Escape are the dialog's, not the header's.
 */
function useDialogDrag(open: boolean, ref: RefObject<HTMLDivElement | null>) {
  const [offset, setOffset] = useState<DialogOffset>(ORIGIN);
  const [dragging, setDragging] = useState(false);
  const live = useRef<DialogOffset>(ORIGIN);
  const drag = useRef<{ pointer: number; x: number; y: number; from: DialogOffset } | null>(null);

  const move = useCallback(
    (wanted: DialogOffset) => {
      const box = ref.current?.getBoundingClientRect();
      const now = live.current;
      const next =
        box === undefined
          ? wanted
          : clampDialogOffset(
              {
                left: box.left - now.x,
                top: box.top - now.y,
                width: box.width,
                height: box.height,
              },
              wanted,
              window.innerWidth,
              window.innerHeight,
            );
      if (next.x !== now.x || next.y !== now.y) {
        live.current = next;
        setOffset(next);
      }
    },
    [ref],
  );

  // Each opening starts where layout puts it.
  useLayoutEffect(() => {
    if (open) {
      live.current = ORIGIN;
      drag.current = null;
      setOffset(ORIGIN);
      setDragging(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const keep = () => move(live.current);
    window.addEventListener('resize', keep);
    const node = ref.current;
    const observer =
      typeof ResizeObserver === 'undefined' || node === null ? null : new ResizeObserver(keep);
    if (observer !== null && node !== null) {
      observer.observe(node);
    }
    return () => {
      window.removeEventListener('resize', keep);
      observer?.disconnect();
    };
  }, [open, move, ref]);

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) {
      return;
    }
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handle = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || drag.current !== null) {
        return;
      }
      if (event.target instanceof Element && event.target.closest('button, a, input') !== null) {
        return;
      }
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        from: live.current,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const at = drag.current;
      if (at === null || at.pointer !== event.pointerId) {
        return;
      }
      move({ x: at.from.x + event.clientX - at.x, y: at.from.y + event.clientY - at.y });
    },
    onPointerUp: end,
    onPointerCancel: end,
  };

  return { offset, dragging, handle };
}

export function Dialog({ open, onClose, title, children, footer, width = 440 }: DialogProps) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onTab = useFocusTrap(open, ref);
  const { offset, dragging, handle } = useDialogDrag(open, ref);

  if (!open) {
    return null;
  }

  const moved = offset.x !== 0 || offset.y !== 0;

  return (
    <ScrimLayer onDismiss={onClose} align="center" light>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(styles.dialog, dragging && styles.dragging)}
        style={{
          width,
          ...(moved ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : {}),
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
          }
          onTab(event);
        }}
      >
        <header className={cx(styles.header, styles.dragHandle)} {...handle}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconButton icon="x" label={t('dialog.close')} variant="ghost" onClick={onClose} />
        </header>
        <div className={styles.body}>{children}</div>
        {footer !== undefined && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </ScrimLayer>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** The consequence being confirmed — name it plainly. */
  message: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm action as destructive. */
  danger?: boolean;
  /** Confirm in flight: spinner on the confirm button. */
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('action.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel ?? t('action.confirm')}
          </Button>
        </>
      }
    >
      {message}
    </Dialog>
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}

/** A right-anchored overlay panel. */
export function Drawer({ open, onClose, title, children, width = 400 }: DrawerProps) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      ref.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <ScrimLayer onDismiss={onClose} align="end">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.drawer}
        style={{ width }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconButton icon="x" label={t('drawer.close')} variant="ghost" onClick={onClose} />
        </header>
        <div className={styles.drawerBody}>{children}</div>
      </div>
    </ScrimLayer>
  );
}

/**
 * Which side of its trigger a tooltip opens on. `bottom` suits a horizontal
 * strip such as the top nav; `right` suits a vertical one pinned to the left
 * edge, where a centred tooltip would hang off the viewport.
 */
export type TooltipPlacement = 'bottom' | 'right';

/** Clearance kept between a tooltip and the viewport edge, in px. */
const TIP_MARGIN = 8;
/** Gap between a tooltip and its trigger, in px (matches --rag-space-1). */
const TIP_GAP = 4;

export interface TipPosition {
  top: number;
  left: number;
}

/**
 * Viewport coordinates for a tooltip of `tip` size anchored to `trigger`.
 *
 * Exported because it is the only part of tooltip placement a headless test
 * can prove: jsdom has no layout engine, so the arithmetic is tested directly
 * and the geometry it is fed is a browser's business.
 *
 * The preferred side is tried first and flipped to the opposite one when it
 * would leave the viewport; whatever survives is then clamped, so a tooltip
 * that fits nowhere is still readable rather than half off-screen.
 */
export function placeTooltip(
  trigger: {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  },
  tip: { width: number; height: number },
  placement: TooltipPlacement,
  viewportWidth: number,
  viewportHeight: number,
): TipPosition {
  let top: number;
  let left: number;

  if (placement === 'right') {
    left = trigger.right + TIP_GAP;
    top = trigger.top + trigger.height / 2 - tip.height / 2;
    if (left + tip.width > viewportWidth - TIP_MARGIN) {
      left = trigger.left - TIP_GAP - tip.width;
    }
  } else {
    left = trigger.left + trigger.width / 2 - tip.width / 2;
    top = trigger.bottom + TIP_GAP;
    if (top + tip.height > viewportHeight - TIP_MARGIN) {
      top = trigger.top - TIP_GAP - tip.height;
    }
  }

  const clamp = (value: number, extent: number, available: number) =>
    Math.min(Math.max(value, TIP_MARGIN), Math.max(TIP_MARGIN, available - TIP_MARGIN - extent));

  return {
    top: clamp(top, tip.height, viewportHeight),
    left: clamp(left, tip.width, viewportWidth),
  };
}

export interface TooltipProps {
  /** Tooltip text (plain string: it doubles as the accessible description). */
  text: string;
  /**
   * An optional emphasised first line, above `text`.
   *
   * It exists because a hint that explains a thing without naming it is only
   * half a hint: a tip describing what a page does, with nothing saying which
   * page it is, reads as an unattributed sentence over an unfamiliar icon.
   *
   * Deliberately a second string rather than `text` widening to `ReactNode`.
   * `text` doubles as the accessible description and must stay a string; and
   * the trigger's accessible *name* already carries the title, so a screen
   * reader hears the name then the description with or without this, which is
   * what keeps the emphasis presentational rather than load-bearing.
   */
  title?: string;
  /** Side the tooltip opens on. Defaults to `bottom`. */
  placement?: TooltipPlacement;
  /**
   * Extra class on the wrapper span.
   *
   * The wrapper stands *between* a layout and its child, so a caller whose
   * child was a flex item (a grid cell, a column) needs to give the wrapper
   * those properties back — otherwise the child is laid out against
   * an `inline-flex` span rather than against the box it was written for.
   */
  className?: string;
  children: ReactNode;
}

/**
 * A hover/focus tooltip.
 *
 * The bubble is rendered into `document.body` through a React portal and
 * positioned in viewport coordinates rather than laid out beside its trigger.
 * Anchored inside the trigger's box it becomes part of every ancestor's
 * scrollable overflow, which is what puts a permanent scrollbar on a
 * three-icon nav strip and then clips the tooltip that caused it. Rendered out
 * and fixed, no ancestor can clip it and none is inflated by it.
 */
/** A `DOMRect` as the plain shape [`placeTooltip`] takes, so it can be spread. */
function toRect(r: DOMRect) {
  return {
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

export function Tooltip({ text, title, placement = 'bottom', className, children }: TooltipProps) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<TipPosition>({ top: 0, left: 0 });

  // Measured on open rather than on render: the bubble's size depends on the
  // text, and the trigger moves with any scroll behind it.
  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }
    const reposition = () => {
      const measured = wrap.current?.getBoundingClientRect();
      const bubble = tip.current?.getBoundingClientRect();
      if (measured === undefined || bubble === undefined) {
        return;
      }
      // A `right` tooltip has to clear the *rail*, not merely the button it
      // hangs off. The rail is a fixed width and its buttons are narrower and
      // centred, so a tooltip gapped off the button's own edge lands back
      // inside the rail and sits on its surface and its right border. Widening
      // the anchor to the enclosing nav is what makes "beside the rail" mean
      // beside the rail; anywhere else there is no nav to find and this is the
      // trigger's own rect, unchanged.
      const rail =
        placement === 'right' ? wrap.current?.closest('nav')?.getBoundingClientRect() : undefined;
      const anchor =
        rail === undefined
          ? measured
          : { ...toRect(measured), right: Math.max(measured.right, rail.right) };
      setAt(placeTooltip(anchor, bubble, placement, window.innerWidth, window.innerHeight));
    };
    reposition();
    // Capture: the trigger may sit in a scrolling pane, not the document.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, placement, text, title]);

  return (
    <span
      ref={wrap}
      className={cx(styles.tipWrap, className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className={styles.tipTrigger} aria-describedby={id}>
        {children}
      </span>
      {createPortal(
        // Always mounted so `aria-describedby` always resolves; only shown,
        // and only positioned, while the trigger is hovered or focused.
        <span
          ref={tip}
          role="tooltip"
          id={id}
          data-placement={placement}
          className={cx(styles.tip, open && styles.tipOpen)}
          style={{ top: at.top, left: at.left }}
        >
          {title !== undefined && <span className={styles.tipTitle}>{title}</span>}
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
