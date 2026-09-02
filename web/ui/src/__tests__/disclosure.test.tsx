// `Disclosure` — the fold behind an Advanced settings section.
//
// The two properties worth holding are the two that stop it hiding something
// that matters: it keeps no open-state of its own (so a caller who finds a
// validation error inside can open it), and shut means *not rendered* rather
// than rendered-and-invisible.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Disclosure } from '../components/surfaces';

function Harness({ initial = false }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <Disclosure
      title="Advanced"
      description="These have working defaults."
      open={open}
      onToggle={setOpen}
    >
      <p>Registry mirror</p>
    </Disclosure>
  );
}

describe('Disclosure', () => {
  it('renders nothing of its body while shut, and the description regardless', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Advanced/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Registry mirror')).not.toBeInTheDocument();
    // The sentence that explains why it is shut has to be readable while it is.
    expect(screen.getByText('These have working defaults.')).toBeInTheDocument();
  });

  it('opens and shuts on the toggle', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: /Advanced/ });

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Registry mirror')).toBeInTheDocument();
    // Open, the toggle points at the body it controls.
    expect(toggle.getAttribute('aria-controls')).toBe(
      screen.getByText('Registry mirror').parentElement!.id,
    );

    await user.click(toggle);
    expect(screen.queryByText('Registry mirror')).not.toBeInTheDocument();
  });

  it('is controlled: it holds no open-state of its own', async () => {
    const onToggle = vi.fn();
    render(
      <Disclosure title="Advanced" open={false} onToggle={onToggle}>
        <p>Registry mirror</p>
      </Disclosure>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    // It asked to be opened and did not open itself — which is what lets a
    // caller open one the reader never clicked.
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.queryByText('Registry mirror')).not.toBeInTheDocument();
  });

  it('is a heading, so the fold is reachable by heading navigation', () => {
    render(<Harness initial />);
    expect(screen.getByRole('heading', { level: 3, name: /Advanced/ })).toBeInTheDocument();
  });
});
