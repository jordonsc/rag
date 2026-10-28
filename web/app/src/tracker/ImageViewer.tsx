/**
 * The image viewer (rag-t0055): a click on an attached image (a ticket's body,
 * a note in its history, a document, the Attachments list) opens it over the
 * whole window.
 *
 * * It opens at the image's own size (100 %), or narrower to fit the width.
 * * The **wheel** zooms about the cursor, between a quarter of the opening
 *   scale and 800 %; `+`, `-` and `0` zoom about the middle and reset.
 * * A **left-button drag** pans; on a touch screen one finger pans and two
 *   pinch. The picture never leaves the window (`viewerMath.ts`).
 * * **Esc**, the **X** top right, or a click on the backdrop (not a drag)
 *   closes it. Focus stays inside while it is open and goes back where it was.
 *
 * One component, opened through `useImageViewer`, which every surface that
 * shows attachments calls; the viewer itself is portalled to `document.body`.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@rag/ui';

import { cx } from '../util';
import styles from './imageViewer.module.css';
import {
  clampPan,
  initialView,
  wheelFactor,
  zoomAt,
  zoomLimits,
  type Point,
  type Size,
  type View,
} from './viewerMath';

export interface ViewedImage {
  src: string;
  alt: string;
}

/** A press that moves less than this, in px, is a click, not a drag. */
const CLICK_SLOP = 4;
/** What `+` and `-` zoom by. */
const KEY_ZOOM = 1.25;

/** The route an attached image is served from (`markdown/render.ts`). */
const ATTACHMENT_SRC = /^\/tracker\/attachments\/[0-9a-f]{12,64}$/;

/** Whether `src` (an `img`'s attribute, not its resolved URL) is an attachment. */
export function isAttachmentSrc(src: string | null): boolean {
  return src !== null && ATTACHMENT_SRC.test(src);
}

interface Press {
  start: Point;
  from: View;
  moved: boolean;
  /** Pressed on the backdrop rather than the picture: a click there closes. */
  backdrop: boolean;
}

interface Pinch {
  distance: number;
  middle: Point;
  from: View;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function middle(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface ImageViewerProps {
  image: ViewedImage;
  onClose: () => void;
}

export function ImageViewer({ image, onClose }: ImageViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [failed, setFailed] = useState(false);
  const [panning, setPanning] = useState(false);
  const live = useRef(view);
  live.current = view;
  const pointers = useRef(new Map<number, Point>());
  const press = useRef<Press | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const opening = useRef(1);

  const viewport = useCallback((): Size => {
    const node = root.current;
    return {
      width: node !== null && node.clientWidth > 0 ? node.clientWidth : window.innerWidth,
      height: node !== null && node.clientHeight > 0 ? node.clientHeight : window.innerHeight,
    };
  }, []);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = root.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  // Focus comes in on opening and goes back on closing; the page under it
  // does not scroll meanwhile.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, []);

  // The wheel, natively: React's wheel listener is passive and cannot stop
  // the page scrolling.
  useEffect(() => {
    const node = root.current;
    if (node === null || natural === null) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      setView((now) =>
        zoomAt(
          now,
          wheelFactor(event.deltaY, event.deltaMode),
          { x: event.clientX - box.left, y: event.clientY - box.top },
          zoomLimits(opening.current),
          natural,
          viewport(),
        ),
      );
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [natural, viewport]);

  // A resized window keeps the picture in it.
  useEffect(() => {
    if (natural === null) {
      return undefined;
    }
    const keep = () => setView((now) => clampPan(now, natural, viewport()));
    window.addEventListener('resize', keep);
    return () => window.removeEventListener('resize', keep);
  }, [natural, viewport]);

  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const size = {
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    };
    const first = initialView(size, viewport());
    opening.current = first.scale;
    setNatural(size);
    setView(first);
  };

  const zoomKey = (factor: number | null) => {
    if (natural === null) {
      return;
    }
    const room = viewport();
    if (factor === null) {
      setView(initialView(natural, room));
      return;
    }
    setView((now) =>
      zoomAt(
        now,
        factor,
        { x: room.width / 2, y: room.height / 2 },
        zoomLimits(opening.current),
        natural,
        room,
      ),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      // The close button is the one stop: Tab never leaves the viewer.
      event.preventDefault();
      root.current?.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomKey(KEY_ZOOM);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomKey(1 / KEY_ZOOM);
    } else if (event.key === '0') {
      event.preventDefault();
      zoomKey(null);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('button') !== null) {
      return;
    }
    event.preventDefault();
    const at = local(event);
    pointers.current.set(event.pointerId, at);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const held = [...pointers.current.values()];
    if (held.length === 2) {
      press.current = null;
      pinch.current = {
        distance: distance(held[0]!, held[1]!),
        middle: middle(held[0]!, held[1]!),
        from: live.current,
      };
      return;
    }
    if (held.length === 1) {
      press.current = {
        start: at,
        from: live.current,
        moved: false,
        backdrop: !(event.target instanceof HTMLImageElement),
      };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || natural === null) {
      return;
    }
    const at = local(event);
    pointers.current.set(event.pointerId, at);
    const room = viewport();
    const twoFingers = pinch.current;
    if (twoFingers !== null) {
      const held = [...pointers.current.values()];
      if (held.length < 2 || twoFingers.distance === 0) {
        return;
      }
      const now = middle(held[0]!, held[1]!);
      const zoomed = zoomAt(
        twoFingers.from,
        distance(held[0]!, held[1]!) / twoFingers.distance,
        twoFingers.middle,
        zoomLimits(opening.current),
        natural,
        room,
      );
      setView(
        clampPan(
          {
            scale: zoomed.scale,
            x: zoomed.x + now.x - twoFingers.middle.x,
            y: zoomed.y + now.y - twoFingers.middle.y,
          },
          natural,
          room,
        ),
      );
      return;
    }
    const one = press.current;
    if (one === null) {
      return;
    }
    const dx = at.x - one.start.x;
    const dy = at.y - one.start.y;
    if (!one.moved && Math.hypot(dx, dy) < CLICK_SLOP) {
      return;
    }
    one.moved = true;
    setPanning(true);
    setView(clampPan({ ...one.from, x: one.from.x + dx, y: one.from.y + dy }, natural, room));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) {
      return;
    }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const one = press.current;
    press.current = null;
    setPanning(false);
    if (pinch.current !== null) {
      // The pinch ends with its first finger; a finger left down starts nothing.
      pinch.current = null;
      return;
    }
    if (one !== null && !one.moved && one.backdrop && event.type === 'pointerup') {
      onClose();
    }
  };

  const percent = Math.round(view.scale * 100);

  return createPortal(
    <div
      ref={root}
      className={cx(styles.viewer, panning && styles.panning)}
      role="dialog"
      aria-modal="true"
      aria-label={image.alt.trim() === '' ? 'Image' : `Image: ${image.alt}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        className={cx(styles.image, natural === null && styles.loading)}
        src={image.src}
        alt={image.alt}
        draggable={false}
        onLoad={onLoad}
        onError={() => setFailed(true)}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
      {natural === null && (
        <p className={styles.status} role="status">
          {failed ? 'The image could not be loaded.' : 'Loading the image…'}
        </p>
      )}
      <div className={styles.bar}>
        <span className={styles.caption} aria-live="polite">
          {natural === null ? image.alt : `${image.alt === '' ? 'Image' : image.alt} · ${percent}%`}
        </span>
        <span className={styles.close}>
          <IconButton icon="x" label="Close the image" variant="ghost" onClick={onClose} />
        </span>
      </div>
    </div>,
    document.body,
  );
}

export interface ImageViewerHandle {
  /** Open `image` over the window. */
  open: (image: ViewedImage) => void;
  /** The viewer while one is open, else nothing: render it anywhere. */
  element: ReactNode;
}

/** One viewer for a surface: `open` it from a click, render `element`. */
export function useImageViewer(): ImageViewerHandle {
  const [image, setImage] = useState<ViewedImage | null>(null);
  const open = useCallback((next: ViewedImage) => setImage(next), []);
  const element =
    image === null ? null : <ImageViewer image={image} onClose={() => setImage(null)} />;
  return { open, element };
}

/**
 * A click on rendered prose that should open the viewer: on an attached
 * image, or on a link that holds one (Enter on the link is such a click). A
 * click with a modifier key, or not the main button, is left to the browser,
 * so the link still opens the file in a new tab when asked to.
 */
export function attachedImageClicked(event: {
  target: EventTarget | null;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): ViewedImage | null {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return null;
  }
  if (!(event.target instanceof Element)) {
    return null;
  }
  const direct = event.target.closest('img');
  const image =
    direct ?? event.target.closest('a')?.querySelector<HTMLImageElement>(':scope > img') ?? null;
  if (image === null) {
    return null;
  }
  const src = image.getAttribute('src');
  if (!isAttachmentSrc(src)) {
    return null;
  }
  return { src: src!, alt: image.getAttribute('alt') ?? '' };
}
