// A dialog dragged by its title bar (rag-t0045).
//
// jsdom has no layout engine, so the clamp is proven as arithmetic
// (`clampDialogOffset`), and the drag is driven with pointer events against a
// dialog whose box is stubbed: the stub reports where layout would put the box
// plus whatever translation the dialog has applied to itself, which is what a
// browser's `getBoundingClientRect` reports.

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog, clampDialogOffset } from '../components/overlays';

const VIEW = { width: 1024, height: 768 };

describe('clampDialogOffset', () => {
  const home = { left: 312, top: 234, width: 400, height: 300 };

  it('passes an offset that keeps the box on screen through unchanged', () => {
    expect(clampDialogOffset(home, { x: -100, y: 50 }, VIEW.width, VIEW.height)).toEqual({
      x: -100,
      y: 50,
    });
  });

  it('stops the box 8 px short of each edge', () => {
    // Left and top: the box's left/top may not go under 8.
    expect(clampDialogOffset(home, { x: -1000, y: -1000 }, VIEW.width, VIEW.height)).toEqual({
      x: 8 - 312,
      y: 8 - 234,
    });
    // Right and bottom: its right/bottom may not pass the viewport less 8.
    expect(clampDialogOffset(home, { x: 1000, y: 1000 }, VIEW.width, VIEW.height)).toEqual({
      x: 1024 - 8 - 400 - 312,
      y: 768 - 8 - 300 - 234,
    });
  });

  it('pins a box wider than the viewport to its leading edge, title bar on screen', () => {
    // A phone: 375 px across, a box 500 wide laid out at -62.5.
    const wide = { left: -62.5, top: 100, width: 500, height: 200 };
    expect(clampDialogOffset(wide, { x: 200, y: 0 }, 375, 667).x).toBe(8 + 62.5);
    expect(clampDialogOffset(wide, { x: -200, y: 0 }, 375, 667).x).toBe(8 + 62.5);
  });

  it('allows no movement on an axis the box exactly fills', () => {
    const snug = { left: 8, top: 8, width: 359, height: 651 };
    expect(clampDialogOffset(snug, { x: 40, y: -40 }, 375, 667)).toEqual({ x: 0, y: 0 });
  });
});

/** Where layout puts the stubbed dialog: centred in a 1024 x 768 viewport. */
const BOX = { left: 312, top: 234, width: 400, height: 300 };

/** The translation the dialog has applied to itself, from its inline style. */
function translation(element: HTMLElement): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(element.style.transform);
  return match === null ? { x: 0, y: 0 } : { x: Number(match[1]), y: Number(match[2]) };
}

let restore: (() => void) | null = null;

beforeEach(() => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function stub(this: HTMLElement) {
    if (this.getAttribute('role') !== 'dialog') {
      return original.call(this);
    }
    const { x, y } = translation(this);
    const left = BOX.left + x;
    const top = BOX.top + y;
    return {
      left,
      top,
      x: left,
      y: top,
      width: BOX.width,
      height: BOX.height,
      right: left + BOX.width,
      bottom: top + BOX.height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  restore = () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW.height });
});

afterEach(() => {
  restore?.();
  restore = null;
});

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Send this item back?"
        footer={<button type="button">Send back</button>}
      >
        <textarea aria-label="Note" />
      </Dialog>
    </>
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'Send this item back?' });
const titleBar = () => dialog().querySelector('header')!;

function drag(from: { x: number; y: number }, to: { x: number; y: number }, pointerId = 1) {
  fireEvent.pointerDown(titleBar(), { pointerId, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(titleBar(), { pointerId, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(titleBar(), { pointerId, clientX: to.x, clientY: to.y });
}

describe('Dialog dragging', () => {
  it('opens where layout puts it, untranslated', () => {
    render(<Harness />);
    expect(dialog().style.transform).toBe('');
  });

  it('follows the pointer by its title bar', () => {
    render(<Harness />);
    drag({ x: 500, y: 250 }, { x: 600, y: 300 });
    expect(translation(dialog())).toEqual({ x: 100, y: 50 });
    // A second drag starts from where the first left it.
    drag({ x: 600, y: 300 }, { x: 560, y: 280 });
    expect(translation(dialog())).toEqual({ x: 60, y: 30 });
  });

  it('moves only while the press lasts', () => {
    render(<Harness />);
    drag({ x: 500, y: 250 }, { x: 520, y: 250 });
    fireEvent.pointerMove(titleBar(), { pointerId: 1, clientX: 900, clientY: 700 });
    expect(translation(dialog())).toEqual({ x: 20, y: 0 });
  });

  it('keeps the dialog inside the viewport', () => {
    render(<Harness />);
    drag({ x: 500, y: 250 }, { x: 5000, y: 5000 });
    expect(translation(dialog())).toEqual({
      x: VIEW.width - 8 - BOX.width - BOX.left,
      y: VIEW.height - 8 - BOX.height - BOX.top,
    });
    drag({ x: 500, y: 250 }, { x: -5000, y: -5000 });
    expect(translation(dialog())).toEqual({ x: 8 - BOX.left, y: 8 - BOX.top });
  });

  it('ignores a press on the close button and a secondary button', () => {
    render(<Harness />);
    const close = screen.getByRole('button', { name: 'Close dialogue' });
    fireEvent.pointerDown(close, { pointerId: 1, button: 0, clientX: 700, clientY: 250 });
    fireEvent.pointerMove(titleBar(), { pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.pointerUp(titleBar(), { pointerId: 1 });
    fireEvent.pointerDown(titleBar(), { pointerId: 2, button: 2, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(titleBar(), { pointerId: 2, clientX: 600, clientY: 300 });
    expect(dialog().style.transform).toBe('');
  });

  it('follows only the pointer that started the drag', () => {
    render(<Harness />);
    fireEvent.pointerDown(titleBar(), { pointerId: 1, button: 0, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(titleBar(), { pointerId: 7, clientX: 900, clientY: 600 });
    expect(dialog().style.transform).toBe('');
    fireEvent.pointerMove(titleBar(), { pointerId: 1, clientX: 510, clientY: 260 });
    expect(translation(dialog())).toEqual({ x: 10, y: 10 });
  });

  it('opens centred again after being dragged and closed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    drag({ x: 500, y: 250 }, { x: 600, y: 300 });
    expect(dialog().style.transform).not.toBe('');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(dialog().style.transform).toBe('');
  });

  it('keeps focus, the Tab trap and Escape after a drag', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(document.activeElement).toBe(dialog());

    drag({ x: 500, y: 250 }, { x: 600, y: 300 });
    expect(document.activeElement).toBe(dialog());

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialogue' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Note' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send back' }));
    // The trap wraps rather than walking off to the page's Open button.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialogue' }));

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('puts a dialog over the lighter scrim and leaves the title bar the handle', () => {
    render(<Harness />);
    expect(dialog().parentElement).toHaveClass('scrim', 'scrimLight');
    expect(titleBar()).toHaveClass('dragHandle');
  });
});
