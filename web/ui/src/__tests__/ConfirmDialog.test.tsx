import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ConfirmDialog, Dialog } from '../components/overlays';

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="A dialog">
        Body
      </Dialog>
    </>
  );
}

describe('Dialog closing', () => {
  // The page can be scrolled behind an open dialog: going back to an opener now
  // off screen must not take the reader with it.
  it('gives focus back to what opened it, without scrolling to it', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const focus = vi.spyOn(opener, 'focus');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(opener).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="Archive topic"
        message="Archiving drops it from the search index."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('states the consequence and confirms through onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Archive topic"
        message="Archiving drops it from the search index."
        onConfirm={onConfirm}
        onCancel={onCancel}
        danger
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Archive topic' })).toBeInTheDocument();
    expect(screen.getByText('Archiving drops it from the search index.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels through onCancel without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Move topic"
        message="Moving mints a new id and retires this one."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes on Escape via onCancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Move topic"
        message="Moving mints a new id and retires this one."
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('supports custom action labels and a busy confirm', () => {
    render(
      <ConfirmDialog
        open
        title="Archive topic"
        message="Archiving drops it from the search index."
        confirmLabel="Archive"
        cancelLabel="Keep"
        busy
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Archive/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
  });
});
