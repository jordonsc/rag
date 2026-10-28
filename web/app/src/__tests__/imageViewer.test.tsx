/**
 * The image viewer (rag-t0055): its arithmetic (the opening fit, zoom about a
 * point, its limits, pan clamping, the wheel), and the viewer itself opened
 * from rendered Markdown: open and close (Esc, the X, the backdrop, not a
 * drag), focus kept and returned, the wheel zooming and a drag panning.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Markdown } from '../markdown/Markdown';
import { Attachments } from '../tracker/Attachments';
import type { Attachment } from '../tracker/types';
import { attachedImageClicked } from '../tracker/ImageViewer';
import {
  MAX_ZOOM,
  clampPan,
  fitScale,
  initialView,
  wheelFactor,
  zoomAt,
  zoomLimits,
} from '../tracker/viewerMath';
import { mountAt } from './harness';
import { STAMP, TrackerServer } from './trackerFixtures';

const ROOM = { width: 1000, height: 800 };
const WIDE = { width: 2000, height: 1000 };
const SMALL = { width: 400, height: 300 };

describe('the viewer’s arithmetic', () => {
  it('opens at 100 %, or narrower to fit the width', () => {
    expect(fitScale(SMALL, ROOM)).toBe(1);
    expect(fitScale(WIDE, ROOM)).toBe(0.5);
    // Taller than the window but no wider: still its own size.
    expect(fitScale({ width: 800, height: 4000 }, ROOM)).toBe(1);
  });

  it('centres what fits and starts a tall image at its top', () => {
    expect(initialView(SMALL, ROOM)).toEqual({ scale: 1, x: 300, y: 250 });
    expect(initialView(WIDE, ROOM)).toEqual({ scale: 0.5, x: 0, y: 150 });
    expect(initialView({ width: 800, height: 4000 }, ROOM)).toEqual({ scale: 1, x: 100, y: 0 });
  });

  it('zooms about a point: the pixel under it stays under it', () => {
    const view = { scale: 1, x: -500, y: -100 };
    const point = { x: 400, y: 300 };
    const zoomed = zoomAt(view, 2, point, { min: 0.1, max: 8 }, WIDE, ROOM);
    expect(zoomed.scale).toBe(2);
    // Image pixel under the point before: (400 + 500) / 1 = 900; after: same.
    expect((point.x - zoomed.x) / zoomed.scale).toBeCloseTo(900);
    expect((point.y - zoomed.y) / zoomed.scale).toBeCloseTo(400);
  });

  it('holds the zoom within its limits', () => {
    const limits = zoomLimits(0.5);
    expect(limits).toEqual({ min: 0.125, max: MAX_ZOOM });
    expect(zoomLimits(1).min).toBe(0.25);
    expect(zoomLimits(0.01).min).toBe(0.05);
    const start = initialView(WIDE, ROOM);
    expect(zoomAt(start, 1000, { x: 0, y: 0 }, limits, WIDE, ROOM).scale).toBe(MAX_ZOOM);
    expect(zoomAt(start, 0.0001, { x: 0, y: 0 }, limits, WIDE, ROOM).scale).toBe(0.125);
  });

  it('keeps a smaller image inside the window', () => {
    expect(clampPan({ scale: 1, x: -50, y: 900 }, SMALL, ROOM)).toEqual({ scale: 1, x: 0, y: 500 });
    expect(clampPan({ scale: 1, x: 700, y: -10 }, SMALL, ROOM)).toEqual({ scale: 1, x: 600, y: 0 });
  });

  it('opens no gap at the edge of a larger image', () => {
    // 2000 × 1000 at 1: x between -1000 and 0, y between -200 and 0.
    expect(clampPan({ scale: 1, x: 50, y: 30 }, WIDE, ROOM)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampPan({ scale: 1, x: -1500, y: -900 }, WIDE, ROOM)).toEqual({
      scale: 1,
      x: -1000,
      y: -200,
    });
    expect(clampPan({ scale: 1, x: -400, y: -100 }, WIDE, ROOM)).toEqual({
      scale: 1,
      x: -400,
      y: -100,
    });
  });

  it('zooms in on a wheel up and out on a wheel down, lines and pages in px', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1);
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48));
    expect(wheelFactor(1, 2)).toBeCloseTo(wheelFactor(800));
  });
});

describe('which clicks open the viewer', () => {
  function target(html: string, selector: string): Element {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.querySelector(selector)!;
  }
  const plain = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  const linked =
    '<a href="/tracker/attachments/3fa9c2e1b07d"><img src="/tracker/attachments/3fa9c2e1b07d" alt="shot"></a>';

  it('an attached image, or the link holding one', () => {
    expect(attachedImageClicked({ ...plain, target: target(linked, 'img') })).toEqual({
      src: '/tracker/attachments/3fa9c2e1b07d',
      alt: 'shot',
    });
    expect(attachedImageClicked({ ...plain, target: target(linked, 'a') })).not.toBeNull();
  });

  it('not a modifier or middle click, an outside image, or a plain link', () => {
    const img = target(linked, 'img');
    expect(attachedImageClicked({ ...plain, target: img, ctrlKey: true })).toBeNull();
    expect(attachedImageClicked({ ...plain, target: img, metaKey: true })).toBeNull();
    expect(attachedImageClicked({ ...plain, target: img, button: 1 })).toBeNull();
    expect(
      attachedImageClicked({
        ...plain,
        target: target('<img src="https://example.com/x.png" alt="x">', 'img'),
      }),
    ).toBeNull();
    expect(
      attachedImageClicked({ ...plain, target: target('<a href="/x">x</a>', 'a') }),
    ).toBeNull();
  });
});

describe('the viewer', () => {
  const SOURCE = 'Look: ![shot](att:3fa9c2e1b07d)';

  /** Give the viewer's image a size and fire its load, as a browser would. */
  function load(width: number, height: number) {
    const image = screen.getByRole('dialog').querySelector('img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
    fireEvent.load(image);
    return image;
  }

  function openFrom(source = SOURCE) {
    render(
      <>
        <button type="button">before</button>
        <Markdown source={source} attachments />
      </>,
    );
    const thumbnail = screen.getByRole('img', { name: 'shot' });
    const link = thumbnail.closest('a')!;
    link.focus();
    fireEvent.click(thumbnail);
    return { link };
  }

  it('opens on a click, at 100 %, and closes on Esc with focus given back', () => {
    const { link } = openFrom();
    const dialog = screen.getByRole('dialog', { name: 'Image: shot' });
    expect(dialog).toHaveFocus();
    load(400, 300);
    expect(within(dialog).getByText('shot · 100%')).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(link).toHaveFocus();
  });

  it('fits a wide image to the width', () => {
    openFrom();
    // jsdom's window is 1024 wide: a 2048 px image opens at 50 %.
    load(2048, 1000);
    expect(screen.getByText('shot · 50%')).toBeInTheDocument();
  });

  it('closes on the X, and on a backdrop click but not a click on the image', async () => {
    const user = userEvent.setup();
    openFrom();
    const image = load(400, 300);
    fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(image, { pointerId: 1, button: 0, clientX: 400, clientY: 300 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog, { pointerId: 2, button: 0, clientX: 10, clientY: 700 });
    fireEvent.pointerUp(dialog, { pointerId: 2, button: 0, clientX: 10, clientY: 700 });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('img', { name: 'shot' }));
    await user.click(screen.getByRole('button', { name: 'Close the image' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not close when a drag ends on the backdrop', () => {
    openFrom();
    load(400, 300);
    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(dialog, { pointerId: 1, button: 0, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(dialog, { pointerId: 1, button: 0, clientX: 60, clientY: 10 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('zooms on the wheel and pans on a drag, clamped to the window', () => {
    openFrom();
    const image = load(2048, 1536);
    // 50 %: 1024 × 768, x 0, y 0 in a 1024 × 768 window.
    expect(image.style.transform).toBe('translate(0px, 0px) scale(0.5)');

    const dialog = screen.getByRole('dialog');
    act(() => {
      dialog.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -463, clientX: 0, clientY: 0, bubbles: true }),
      );
    });
    // exp(0.693) ≈ 2: 100 % about the top-left corner.
    expect(screen.getByText('shot · 100%')).toBeInTheDocument();
    expect(image.style.transform).toMatch(/^translate\(0px, 0px\) scale\(1\.0\d*\)$/);

    fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(image, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });
    expect(image.style.transform).toMatch(/^translate\(-200px, -100px\)/);
    // Past the edge: no further than the image's own edge.
    fireEvent.pointerMove(image, { pointerId: 1, button: 0, clientX: -5000, clientY: -5000 });
    const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(image.style.transform)!;
    expect(Number(x)).toBeCloseTo(1024 - 2048 * 1.0, -1);
    expect(Number(y)).toBeCloseTo(768 - 1536 * 1.0, -1);
    fireEvent.pointerUp(image, { pointerId: 1, button: 0, clientX: -5000, clientY: -5000 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps Tab inside, on its close button', () => {
    openFrom();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close the image' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Close the image' })).toHaveFocus();
  });

  it('opens nothing for prose without attachments', () => {
    render(<Markdown source="![x](https://example.com/x.png)" attachments />);
    fireEvent.click(screen.getByRole('img', { name: 'x' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the Attachments list', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an image’s preview in the viewer', async () => {
    const sha256 = `3fa9c2e1b07d${'0'.repeat(52)}`;
    const attachment: Attachment = {
      id: 7,
      project: 'demo',
      sha256,
      ref: 'att:3fa9c2e1b07d',
      name: 'shot.png',
      media_type: 'image/png',
      size: 48213,
      author_email: 'alice@example.com',
      agent: 'Unknown',
      surface: 'web',
      uploaded_at: STAMP,
    };
    new TrackerServer()
      .on('/tracker/demo/attachments', { body: { project: 'demo', attachments: [attachment] } })
      .install();
    mountAt('/projects/:project/docs', <Attachments project="demo" />, {
      route: '/projects/demo/docs',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'View shot.png' }));
    const dialog = screen.getByRole('dialog', { name: 'Image: shot.png' });
    expect(dialog.querySelector('img')).toHaveAttribute('src', `/tracker/attachments/${sha256}`);
  });
});
