// `Select`'s leading option.
//
// A `<select>` whose `value` matches no `<option>` is **not** drawn blank by
// the browser. React marks every option unselected, and the HTML "ask for a
// reset" algorithm then selects the first one — so a control holding `''`
// displays the first choice, the reader leaves it alone believing it was
// chosen, and the form is submitted with a value nobody picked. The empty
// leading option is what pins the display to the empty state.
//
// These assert on `value` and `selectedOptions` — what the DOM reports —
// because the whole defect is the DOM disagreeing with the state the component
// was given.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../components/inputs';

const TYPES = [
  { value: 'decision', label: 'Decision' },
  { value: 'incident', label: 'Incident' },
];

function drawn(): HTMLSelectElement {
  return screen.getByRole('combobox') as HTMLSelectElement;
}

describe('Select', () => {
  it('never displays an option while it holds nothing', () => {
    render(<Select value="" onChange={vi.fn()} options={TYPES} aria-label="Topic type" />);

    const control = drawn();
    expect(control.value).toBe('');
    expect(control.selectedOptions[0]?.textContent).toBe('Choose…');
    // Disabled, so the prompt cannot be chosen as though it were an answer.
    expect(control.selectedOptions[0]).toBeDisabled();
  });

  it('prefers the declared placeholder to the fallback wording', () => {
    render(
      <Select
        value=""
        onChange={vi.fn()}
        options={TYPES}
        placeholder="Pick a topic type"
        aria-label="Type"
      />,
    );

    expect(drawn().selectedOptions[0]?.textContent).toBe('Pick a topic type');
  });

  it('leaves an option set that offers the empty value alone', () => {
    // Here `''` *is* one of the choices and carries a label the caller wrote.
    // A second empty option above it would sit there saying something else,
    // and the reader would be choosing between two blanks.
    render(
      <Select
        value=""
        onChange={vi.fn()}
        options={[{ value: '', label: 'Any type' }, ...TYPES]}
        aria-label="Type"
      />,
    );

    const control = drawn();
    expect(control.value).toBe('');
    expect(control.selectedOptions[0]?.textContent).toBe('Any type');
    expect(control.selectedOptions[0]).not.toBeDisabled();
    expect(screen.queryByText('Choose…')).not.toBeInTheDocument();
  });

  it('draws no lead at all once the control holds a value', () => {
    render(<Select value="incident" onChange={vi.fn()} options={TYPES} aria-label="Type" />);

    expect(drawn().value).toBe('incident');
    expect(screen.queryByText('Choose…')).not.toBeInTheDocument();
  });
});
