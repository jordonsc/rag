// `Slider` — a bounded numeric control with a stated reading.
//
// The rule under test: the knob may be wherever the pointer left it, but the
// *reading* is never inferred from where the knob looks. Hence the two cases
// that matter — an absent value reads as "not set" while the knob still has to
// rest somewhere, and the reading follows the value rather than the position.

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from '../components/inputs';

function Harness({ initial }: { initial: number | null }) {
  const [value, setValue] = useState<number | null>(initial);
  return <Slider value={value} onChange={setValue} min={0} max={100} />;
}

describe('Slider', () => {
  it('states the value beside the control', () => {
    render(<Harness initial={60} />);
    expect(screen.getByRole('slider')).toHaveValue('60');
    expect(screen.getByRole('status')).toHaveTextContent('60');
  });

  it('says "not set" rather than reading the knob back as a value', () => {
    render(<Harness initial={null} />);
    // The knob rests at the low end because it must be somewhere; the reading
    // refuses to claim the value is 0.
    expect(screen.getByRole('slider')).toHaveValue('0');
    expect(screen.getByRole('status')).toHaveTextContent('Not set');
  });

  it('moves the reading with the control', () => {
    render(<Harness initial={60} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '25' } });
    expect(screen.getByRole('status')).toHaveTextContent('25');
  });

  it('reports a number, never the input event string', () => {
    const onChange = vi.fn();
    render(<Slider value={10} onChange={onChange} min={0} max={100} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '42' } });
    expect(onChange).toHaveBeenCalledWith(42);
  });

  it('carries its bounds and its step onto the control', () => {
    render(<Slider value={1.5} onChange={vi.fn()} min={0} max={5} step="any" />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '5');
    // A real number needs the browser's whole-number stepping lifted.
    expect(slider).toHaveAttribute('step', 'any');
  });

  it('writes the reading through a format the caller supplies', () => {
    render(
      <Slider value={60} onChange={vi.fn()} min={0} max={100} format={(value) => `${value}%`} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('60%');
  });
});
