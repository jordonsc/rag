/**
 * The image viewer's arithmetic (rag-t0055), kept apart from the DOM so it can
 * be tested on its own.
 *
 * A view is where the image's top-left corner sits in the viewport (`x`, `y`,
 * in CSS px) and how much it is scaled (`scale`, 1 = the image's own pixels).
 * The image is drawn with `transform: translate(x, y) scale(scale)` from a
 * top-left origin, so a point `p` of the image lands at `x + p × scale`.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

/** The furthest in a reader can zoom: eight times the image's own pixels. */
export const MAX_ZOOM = 8;
/** The furthest out: a quarter of the opening scale, never under 5 %. */
export const MIN_ZOOM_SHARE = 0.25;
const MIN_ZOOM_FLOOR = 0.05;
/** One wheel notch (100 px of `deltaY`) zooms by about 16 %. */
const WHEEL_RATE = 0.0015;
/** A `deltaMode` of lines or pages, in px: what one of them scrolls. */
const LINE_PX = 16;
const PAGE_PX = 800;

/** The opening scale: the image's own size, or narrower to fit the width. */
export function fitScale(image: Size, viewport: Size): number {
  if (image.width <= 0 || viewport.width <= 0) {
    return 1;
  }
  return Math.min(1, viewport.width / image.width);
}

export function zoomLimits(opening: number): ZoomLimits {
  return {
    min: Math.max(MIN_ZOOM_FLOOR, Math.min(1, opening) * MIN_ZOOM_SHARE),
    max: MAX_ZOOM,
  };
}

/**
 * Keep the image where the reader can see it. Along an axis where it is
 * smaller than the viewport it stays wholly inside; where it is larger, no
 * empty band opens at either edge (it can be moved until its edge meets the
 * viewport's, no further).
 */
export function clampPan(view: View, image: Size, viewport: Size): View {
  const clampAxis = (at: number, length: number, room: number): number => {
    const scaled = length * view.scale;
    const low = Math.min(0, room - scaled);
    const high = Math.max(0, room - scaled);
    return Math.min(high, Math.max(low, at));
  };
  return {
    scale: view.scale,
    x: clampAxis(view.x, image.width, viewport.width),
    y: clampAxis(view.y, image.height, viewport.height),
  };
}

/**
 * The opening view: at `fitScale`, centred across; centred down when it fits
 * the height, else from its top (the start of a tall screenshot, not its
 * middle).
 */
export function initialView(image: Size, viewport: Size): View {
  const scale = fitScale(image, viewport);
  const height = image.height * scale;
  return {
    scale,
    x: (viewport.width - image.width * scale) / 2,
    y: height <= viewport.height ? (viewport.height - height) / 2 : 0,
  };
}

/**
 * Zoom by `factor` about `point` (a viewport point, usually the cursor): the
 * image pixel under it stays under it. The scale is held within `limits`, and
 * the result is clamped as a pan is.
 */
export function zoomAt(
  view: View,
  factor: number,
  point: Point,
  limits: ZoomLimits,
  image: Size,
  viewport: Size,
): View {
  const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor));
  const ratio = scale / view.scale;
  return clampPan(
    {
      scale,
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
    },
    image,
    viewport,
  );
}

/** A wheel event's zoom factor: down (positive `deltaY`) zooms out. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
  return Math.exp(-px * WHEEL_RATE);
}
