import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, IconButton } from '../components/Button';

describe('Button', () => {
  it('defaults to type=button and fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disables itself and shows a spinner while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Save/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    await user.click(button).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies the variant class', () => {
    render(<Button variant="danger">Remove</Button>);
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass('danger');
  });
});

describe('IconButton', () => {
  it('is named by its label and shows it as a title', () => {
    render(<IconButton icon="x" label="Close drawer" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Close drawer' });
    expect(button).toHaveAttribute('title', 'Close drawer');
    expect(button.querySelector('svg')).not.toBeNull();
  });
});
