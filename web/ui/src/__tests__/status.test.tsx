import { render, screen } from '@testing-library/react';
import { SeverityIcon, StateDot, type Tone } from '../components/status';

describe('StateDot', () => {
  const cases: Array<{ tone: Tone; label: string }> = [
    { tone: 'neutral', label: 'Proposed' },
    { tone: 'acc', label: 'Open' },
    { tone: 'good', label: 'Resolved' },
    { tone: 'warn', label: 'Reverted' },
    { tone: 'crit', label: 'Superseded' },
  ];

  it.each(cases)('renders $tone with its token class and text label', ({ tone, label }) => {
    const { container } = render(
      <StateDot tone={tone} label={label} state={label.toLowerCase()} />,
    );
    const dot = container.querySelector(`[data-state="${label.toLowerCase()}"]`)!;
    expect(dot).not.toBeNull();
    expect(dot).toHaveClass(`dot_${tone}`);
    // Status is never colour alone: the label text is present.
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('falls back to the label as the state attribute', () => {
    const { container } = render(<StateDot label="Open" />);
    expect(container.querySelector('[data-state="Open"]')).not.toBeNull();
  });

  it('renders an emphasised state as a filled pill with an icon', () => {
    const { container } = render(
      <StateDot label="Superseded" tone="crit" emphasis state="superseded" />,
    );
    const pill = container.querySelector('[data-state="superseded"]')!;
    expect(pill).toHaveClass('emphasis');
    expect(pill.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
  });

  it('carries an aria-label when the text label is hidden', () => {
    const { container } = render(<StateDot label="Open" tone="acc" showLabel={false} />);
    const dot = container.querySelector('[data-state="Open"]')!;
    expect(dot).toHaveAttribute('aria-label', 'Open');
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
  });
});

describe('SeverityIcon', () => {
  it('labels each severity through the catalogue', () => {
    render(<SeverityIcon severity="info" />);
    expect(screen.getByRole('img', { name: 'Information' })).toBeInTheDocument();
    render(<SeverityIcon severity="warning" />);
    expect(screen.getByRole('img', { name: 'Warning' })).toBeInTheDocument();
    render(<SeverityIcon severity="critical" />);
    expect(screen.getByRole('img', { name: 'Critical' })).toBeInTheDocument();
  });

  it('applies the severity token class and data attribute', () => {
    const { container } = render(<SeverityIcon severity="critical" />);
    const wrapper = container.querySelector('[data-severity="critical"]')!;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass('critical');
  });

  it('can render the severity as text as well', () => {
    render(<SeverityIcon severity="warning" showLabel />);
    expect(screen.getByText('Warning')).toBeInTheDocument();
  });

  // The type is open at the edge: a token this build does not know must reach
  // the glass. Rendering `undefined` as an icon name used to throw and take the
  // whole surface with it, for one unrecognised word.
  it('renders an unknown severity token rather than throwing', () => {
    const { container } = render(<SeverityIcon severity="catastrophic" showLabel />);
    const wrapper = container.querySelector('[data-severity="catastrophic"]')!;
    expect(wrapper).not.toBeNull();
    // Shown as itself: not coerced onto `info`, which would state a severity
    // nobody claimed, and not dropped, which loses the message.
    expect(screen.getByText('catastrophic')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'catastrophic' })).toBeInTheDocument();
  });
});
