import { render, screen } from '@testing-library/react';
import { Icon } from '../components/Icon';
import { iconRegistry } from '../icons/registry';

describe('Icon', () => {
  it('renders a registered glyph by name', () => {
    const { container } = render(<Icon name="settings" label="Settings" />);
    const wrapper = container.querySelector('[data-icon="settings"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Settings' })).toBeInTheDocument();
  });

  it('resolves multi-word names', () => {
    const { container } = render(<Icon name="triangle-alert" />);
    expect(container.querySelector('[data-icon="triangle-alert"] svg')).not.toBeNull();
  });

  it('falls back to the generic glyph for a name the registry does not hold', () => {
    const { container } = render(<Icon name="definitely-not-an-icon-xyz" />);
    const wrapper = container.querySelector('[data-icon="fallback"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('circle')).not.toBeNull();
  });

  it('is decorative (aria-hidden) without a label and labelled with one', () => {
    const { container } = render(<Icon name="settings" />);
    expect(container.querySelector('[data-icon="settings"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    render(<Icon name="settings" label="Search settings" />);
    expect(screen.getByRole('img', { name: 'Search settings' })).toBeInTheDocument();
  });

  // The glyphs the components in this package name for themselves. A rename in
  // the registry that misses one of these is a silent grey circle otherwise.
  it('holds every glyph the components draw', () => {
    for (const name of [
      'chevron-down',
      'chevron-right',
      'chevron-up',
      'circle-help',
      'eye',
      'eye-off',
      'info',
      'octagon-alert',
      'plus',
      'triangle-alert',
      'x',
    ]) {
      expect(iconRegistry[name], name).toBeDefined();
    }
  });
});
