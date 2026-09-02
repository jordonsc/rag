import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ChipList,
  DurationInput,
  Picker,
  SecretInput,
  Toggle,
  naturalUnit,
  placeList,
  type ChipListHandle,
} from '../components/inputs';

function SecretHarness() {
  const [value, setValue] = useState('hunter2');
  return <SecretInput value={value} onChange={setValue} />;
}

describe('SecretInput', () => {
  it('is masked by default', () => {
    const { container } = render(<SecretHarness />);
    const input = container.querySelector('input')!;
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('hunter2');
  });

  it('reveals and re-hides the value', async () => {
    const user = userEvent.setup();
    const { container } = render(<SecretHarness />);
    const reveal = screen.getByRole('button', { name: 'Reveal value' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');

    await user.click(reveal);
    expect(container.querySelector('input')).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: 'Hide value' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');

    await user.click(hide);
    expect(container.querySelector('input')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Reveal value' })).toBeInTheDocument();
  });

  it('propagates edits through onChange', async () => {
    const user = userEvent.setup();
    const { container } = render(<SecretHarness />);
    const input = container.querySelector('input')!;
    await user.clear(input);
    await user.type(input, 'correct horse');
    expect(input).toHaveValue('correct horse');
  });
});

describe('Toggle', () => {
  it('renders as a switch with its checked state', () => {
    render(<Toggle checked={false} onChange={() => {}} label="Automatic updates" />);
    const toggle = screen.getByRole('switch', { name: 'Automatic updates' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the inverted value on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Automatic updates" />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reflects checked=true and does not fire when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="Automatic updates" disabled />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

function ChipHarness({ maxItems }: { maxItems?: number }) {
  const [values, setValues] = useState<string[]>(['alpha']);
  return (
    <>
      <ChipList values={values} onChange={setValues} maxItems={maxItems} />
      <button type="button">elsewhere</button>
    </>
  );
}

/** A form that submits without the entry box ever losing focus. */
function ChipFormHarness() {
  const [values, setValues] = useState<string[]>(['alpha']);
  const [sent, setSent] = useState<string[] | null>(null);
  const chips = useRef<ChipListHandle>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSent(chips.current?.commit() ?? values);
      }}
    >
      <ChipList values={values} onChange={setValues} handleRef={chips} />
      <output>{sent === null ? 'unsent' : sent.join(',')}</output>
    </form>
  );
}

describe('ChipList', () => {
  it('adds an entry on Enter and trims it', async () => {
    const user = userEvent.setup();
    render(<ChipHarness />);
    await user.type(screen.getByRole('textbox'), '  beta  {Enter}');
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('removes an entry via its labelled remove button', async () => {
    const user = userEvent.setup();
    render(<ChipHarness />);
    await user.click(screen.getByRole('button', { name: 'Remove alpha' }));
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
  });

  it('honours maxItems by disabling entry', async () => {
    const user = userEvent.setup();
    render(<ChipHarness maxItems={2} />);
    await user.type(screen.getByRole('textbox'), 'beta{Enter}');
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  /**
   * **Leaving the box commits what is in it.** A chip used to be committed only
   * on Enter or on `+`, so a value typed and then submitted — the reader having
   * done nothing wrong, and the write having *succeeded* — was silently
   * dropped. Adding an unwanted chip is the right way round to be wrong: it is
   * visible and removable, a lost one is neither.
   */
  it('commits a pending entry when focus leaves', async () => {
    const user = userEvent.setup();
    render(<ChipHarness />);
    await user.type(screen.getByRole('textbox'), 'beta');
    expect(screen.queryByText('beta')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('clears a duplicate draft on blur rather than leaving it looking pending', async () => {
    const user = userEvent.setup();
    render(<ChipHarness />);
    await user.type(screen.getByRole('textbox'), 'alpha');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));

    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getAllByText('alpha')).toHaveLength(1);
  });

  /**
   * The other half of the same hole. Blur closes most of it, but a form
   * submitted from the keyboard — or one whose handler runs before the browser
   * dispatches the blur — never produces one. `commit` **returns** the
   * resulting values because the caller cannot read the state React is about to
   * set: it is still rendering the old one.
   */
  it('hands a form the pending entry on submit, without a blur', async () => {
    const user = userEvent.setup();
    render(<ChipFormHarness />);
    await user.type(screen.getByRole('textbox'), 'beta');
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);

    expect(screen.getByText('alpha,beta')).toBeInTheDocument();
  });

  it('answers with the current values when nothing is pending', async () => {
    const user = userEvent.setup();
    render(<ChipFormHarness />);
    await user.type(screen.getByRole('textbox'), 'beta{Enter}');
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);

    expect(screen.getByText('alpha,beta')).toBeInTheDocument();
  });
});

function DurationHarness({ initial = 1_800_000 }: { initial?: number | null }) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <>
      <DurationInput value={value} onChange={setValue} unit="m" />
      <output>{value === null ? 'empty' : String(value)}</output>
    </>
  );
}

describe('DurationInput', () => {
  it('opens on the largest unit the value divides into exactly', () => {
    // The point of the control: 1800000 reads as 30 minutes, not as 1800000.
    expect(naturalUnit(1_800_000, 'ms')).toBe('m');
    expect(naturalUnit(90_000, 'ms')).toBe('s');
    expect(naturalUnit(1_500, 'ms')).toBe('ms');
    // Zero has no natural unit, so the declared one wins rather than the
    // control silently settling on days.
    expect(naturalUnit(0, 'h')).toBe('h');
    expect(naturalUnit(null, 'h')).toBe('h');
  });

  it('emits milliseconds whatever unit is on screen', async () => {
    const user = userEvent.setup();
    render(<DurationHarness />);
    const box = screen.getByRole('spinbutton');
    expect(box).toHaveValue(30);

    await user.selectOptions(screen.getByLabelText('Unit'), 'h');
    // The same length, re-expressed — half an hour.
    expect(screen.getByRole('spinbutton')).toHaveValue(0.5);
    await user.clear(screen.getByRole('spinbutton'));
    await user.type(screen.getByRole('spinbutton'), '2');
    expect(screen.getByText('7200000')).toBeInTheDocument();
  });

  /**
   * **A declared interval fixes the unit.**
   *
   * `naturalUnit` is right for a duration authored as a bare number and wrong
   * the moment the caller declares the interval the length runs over: bounds
   * and the unit they were written in describe one ladder of positions, and
   * inferring a different unit from where the value happens to sit on that
   * ladder makes the control a different control depending on what was last
   * saved. Bounds of `{0, 5000, 100}` declared in seconds have 45 of their 51
   * positions land on something other than a whole second, so most saved
   * values would reopen as a 0–5000 knob stepping in hundreds of milliseconds.
   *
   * Both halves are asserted: the value that would infer `ms` and the one that
   * would infer `s` by luck, because a repair that simply changed the
   * inference would pass one and fail the other.
   */
  it('opens in the declared unit wherever the declaration gave an interval', () => {
    const bounds = { min: 0, max: 5_000, step: 100 };
    // 1500 ms divides into no unit above `ms`, and used to draw a 0–5000 knob.
    render(
      <DurationInput value={1_500} onChange={() => {}} unit="s" bounds={bounds} slider id="fade" />,
    );
    const knob = screen.getByRole('slider');
    expect(knob).toHaveAttribute('min', '0');
    expect(knob).toHaveAttribute('max', '5');
    expect(knob).toHaveAttribute('step', '0.1');
    expect(knob).toHaveValue('1.5');
    cleanup();

    // And the whole second, which inferred the right unit by luck, is unmoved.
    render(
      <DurationInput value={3_000} onChange={() => {}} unit="s" bounds={bounds} slider id="fade" />,
    );
    expect(screen.getByRole('slider')).toHaveAttribute('max', '5');
    expect(screen.getByRole('slider')).toHaveValue('3');
  });

  /**
   * **The inference is kept for a duration with no declared interval**, which
   * is the whole reason `naturalUnit` exists: 1800000 must still read as 30
   * minutes. A repair that let the declared unit always win would delete that.
   */
  it('still infers the unit when no interval is declared', () => {
    render(<DurationInput value={1_800_000} onChange={() => {}} unit="ms" />);
    expect(screen.getByRole('spinbutton')).toHaveValue(30);
    expect(screen.getByLabelText('Unit')).toHaveValue('m');
  });

  /**
   * **A slider with no usable ends is ignored.** Inventing the ends would be
   * describing an interval the caller never declared. Ends that do not ascend
   * are not an interval either, so they take the same answer, and the unit
   * goes back to being inferred.
   */
  it('draws a box, not a knob, when a slider is asked for without usable ends', () => {
    render(<DurationInput value={1_500} onChange={() => {}} unit="s" slider />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    cleanup();

    render(
      <DurationInput
        value={1_500}
        onChange={() => {}}
        unit="s"
        bounds={{ min: 5_000, max: 5_000 }}
        slider
      />,
    );
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    // No declared interval, so the unit is inferred again — 1500 ms is in no
    // larger unit exactly.
    expect(screen.getByLabelText('Unit')).toHaveValue('ms');
  });
});

function PickerHarness({
  options,
  initial = [],
  multiple = false,
  id,
}: {
  options: { value: string; label: string; detail?: string; code?: string }[];
  initial?: string[];
  multiple?: boolean;
  /** Set only where a case is about the label association surviving a swap. */
  id?: string;
}) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <Picker values={values} onChange={setValues} options={options} multiple={multiple} id={id} />
  );
}

describe('Picker', () => {
  const many = Array.from({ length: 120 }, (_, index) => ({
    value: `topic.${index}`,
    label: `Topic ${index}`,
  }));

  it('narrows on what is typed and says when it is showing only some', async () => {
    const user = userEvent.setup();
    render(<PickerHarness options={many} />);
    await user.click(screen.getByRole('combobox'));
    // A hundred and twenty options are not drawn at once, and the control says
    // so rather than letting the reader believe the list ends at fifty.
    expect(screen.getByText(/Showing 50 of 120/)).toBeInTheDocument();

    await user.type(screen.getByRole('combobox'), 'Topic 11');
    // 11, 110..119 — eleven of them, so no truncation note.
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Topic 110' }));
    expect(screen.getByText('Topic 110')).toBeInTheDocument();
  });

  it('says when the caller offered nothing at all', async () => {
    const user = userEvent.setup();
    render(<PickerHarness options={[]} />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByText(/nothing to choose from/i)).toBeInTheDocument();
  });

  it('shows a chosen value the options do not contain, marked', () => {
    render(<PickerHarness options={many} initial={['topic.gone']} />);
    expect(screen.getByText('topic.gone')).toBeInTheDocument();
    expect(screen.getByText('no longer offered')).toBeInTheDocument();
  });

  // An option is a **row** where the caller gave one — the name, a detail
  // beside it, and the id beneath in monospace. The case it exists for is
  // choosing one of several similar things, where the friendly name is
  // ambiguous and the id settles it.
  describe('option rows', () => {
    // **The code is deliberately not the value**, and the shape of the fixture
    // is load-bearing. `value` was already searched, so a code that repeated it
    // would leave the code-search case passing against a build that never looks
    // at `code` at all — an over-determined case, proving nothing. A mutation
    // found exactly that and this is the repair.
    const rows = [
      {
        value: 'opaque-1',
        label: 'Index rebuild',
        detail: 'rag',
        code: 'topic.index_rebuild',
      },
      { value: 'opaque-2', label: 'Index rebuild', detail: 'wiki' },
      { value: 'topic.plain', label: 'Plain' },
    ];

    it('draws the detail and the code the caller declared', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={rows} />);
      await user.click(screen.getByRole('combobox'));

      // The row that disambiguates two identically-named options. Read off the
      // rendered option rather than the document, so a `detail` drawn somewhere
      // else entirely would not satisfy this.
      const option = screen.getByRole('option', { name: /topic\.index_rebuild/ });
      expect(within(option).getByText('rag')).toBeInTheDocument();
      expect(within(option).getByText('topic.index_rebuild')).toBeInTheDocument();

      // **Two options share a label**, which is the situation the fields exist
      // for: without them the list would show "Index rebuild" twice and the
      // reader would have to guess.
      expect(screen.getByRole('option', { name: /wiki/ })).toBeInTheDocument();
    });

    it('leaves an option that declared neither exactly as it was', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={rows} />);
      await user.click(screen.getByRole('combobox'));
      // Nothing written before this addition changes shape: the accessible name
      // is the bare label, with no second line folded into it.
      expect(screen.getByRole('option', { name: 'Plain' })).toBeInTheDocument();
    });

    it('searches the code and deliberately not the detail', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={rows} />);
      await user.click(screen.getByRole('combobox'));

      // A code is an identifier a reader types to find one row — the whole
      // reason it is drawn. `index_rebuild` appears in **no** `value` and in no
      // `label` — only in the one option's `code` — so this fails against a
      // build that does not search it.
      await user.type(screen.getByRole('combobox'), 'index_rebuild');
      expect(screen.getAllByRole('option')).toHaveLength(1);

      // A detail is a grouping, and matching it would make typing a group's
      // name silently select everything in it. The split is deliberate, so it
      // is asserted rather than left to be rediscovered.
      await user.clear(screen.getByRole('combobox'));
      await user.type(screen.getByRole('combobox'), 'wiki');
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });
  });

  // Clicking away from the list closes it, the way a dropdown does.
  describe('closing', () => {
    it('closes on a press outside it, and forgets what was being searched for', async () => {
      const user = userEvent.setup();
      render(
        <>
          <PickerHarness options={many} />
          <button type="button">Somewhere else</button>
        </>,
      );

      const box = screen.getByRole('combobox');
      await user.click(box);
      await user.type(box, 'Topic 11');
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Somewhere else' }));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(box).toHaveAttribute('aria-expanded', 'false');
      // The box is a search field, not the value: leaving the needle in it
      // shows an input holding something the control does not.
      expect(box).toHaveValue('');
    });

    it('stays open for a press on its own chrome, so a chip can be removed', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.1']} multiple />);

      await user.click(screen.getByRole('combobox'));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      // Removing a chip is work inside the control, not a look away from it.
      await user.click(screen.getByRole('button', { name: /Remove topic\.1/ }));
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('does not close when focus moves to an option, which is how a choice is made', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} />);

      const box = screen.getByRole('combobox');
      await user.click(box);
      // Closing on blur would kill the selection: the options are buttons, so
      // pressing one blurs the input on the way.
      await user.click(screen.getByRole('option', { name: 'Topic 3' }));
      expect(screen.getByText('Topic 3')).toBeInTheDocument();
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      // After a single-valued choice, focus must be on the control and not on
      // the document body, or the next Tab starts from the top of the page.
      // The control is not the same element it was: a single-valued picker
      // that holds a value rests as its trigger, so the search box `box`
      // refers to has been detached by this point, and asserting on it would
      // be asserting that focus sits on a node that is not in the document. So
      // the assertion follows the control: focus is on whatever the combobox
      // now is, and that element is a real one.
      const trigger = screen.getByRole('combobox');
      expect(trigger).not.toBe(box);
      expect(trigger).toHaveFocus();
      expect(trigger).toBeInTheDocument();
    });

    it('closes on Escape and does not reopen when focus comes back', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} />);

      const box = screen.getByRole('combobox');
      await user.click(box);
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      await user.keyboard('{Escape}');
      // Focusing the input is what opens the list, so returning focus to it
      // must not undo the close.
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(box).toHaveFocus();
      expect(box).toHaveAttribute('aria-expanded', 'false');
    });

    it('reopens on a press even though the box never lost focus', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} />);

      const box = screen.getByRole('combobox');
      await user.click(box);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      // Opening on focus alone is not enough: after Escape the box is already
      // focused, so a second press moves no focus and fires no event, and the
      // control sits there refusing to open.
      await user.click(box);
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('lets Escape reach a dialog once the list is already shut', async () => {
      const user = userEvent.setup();
      const closed = vi.fn();
      render(
        <div onKeyDown={(event) => event.key === 'Escape' && closed()}>
          <PickerHarness options={many} />
        </div>,
      );

      const box = screen.getByRole('combobox');
      await user.click(box);
      // The first press belongs to the list…
      await user.keyboard('{Escape}');
      expect(closed).not.toHaveBeenCalled();
      // …and the second to the layer above it, because the handler is guarded
      // on `open` rather than swallowing every press.
      await user.keyboard('{Escape}');
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('names the list it controls only while the list exists', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} />);

      const box = screen.getByRole('combobox');
      expect(box).not.toHaveAttribute('aria-controls');

      await user.click(box);
      const list = screen.getByRole('listbox');
      expect(box).toHaveAttribute('aria-controls', list.id);
      expect(list.id).not.toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // A single-valued picker rests as a value, not as a search box.
  //
  // A control that selects exactly one thing but is drawn like a multi-selector
  // reads as one you can add to. The search box is not deleted, it is *moved
  // behind the trigger*: hiding it outright would leave a held value
  // unsearchable past the fifty-option limit. So these cases are as much about
  // what still works as about what is now absent.
  // -------------------------------------------------------------------------
  describe('a single value at rest', () => {
    /** What the search box is, wherever it is asserted about. */
    const searchBox = () => screen.queryByPlaceholderText('Type to search…');

    it('hides the search box once a single value is held', () => {
      const { container } = render(<PickerHarness options={many} initial={['topic.1']} />);

      // Asserted on the placeholder rather than on a class name.
      expect(searchBox()).toBeNull();
      // The second proof, and it has to be one the first cannot make.
      // `queryByRole('textbox')` would be vacuous here: the search box carries
      // an explicit `role="combobox"` that overrides the implicit textbox
      // role, so that query returns null either way. The tag query covers the
      // blind spot the placeholder query has — a box still rendered under a
      // different placeholder, or none — and fails the moment an `<input>` is
      // back in the control.
      expect(container.querySelector('input')).toBeNull();

      // And what stands in its place is the value, not a bare affordance: the
      // control still announces itself as a combobox, and its content is what
      // a closed `<select>` would be showing.
      const trigger = screen.getByRole('combobox');
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger).toHaveTextContent('Topic 1');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    });

    it('leaves an empty single-valued picker exactly as it was', () => {
      render(<PickerHarness options={many} />);

      // No value, no change: a picker with nothing in it has nothing to show
      // instead.
      expect(searchBox()).toBeInTheDocument();
      expect(screen.getByRole('combobox').tagName).toBe('INPUT');
    });

    it('leaves a multi-valued picker exactly as it was, holding a value or not', () => {
      const { unmount } = render(<PickerHarness options={many} multiple />);
      expect(searchBox()).toBeInTheDocument();
      expect(screen.getByRole('combobox').tagName).toBe('INPUT');
      unmount();

      // A multi-valued picker is the control the single-valued one was being
      // mistaken for, so it is the one thing this must not touch: the chip
      // *and* the box, because a second value is still to be added.
      render(<PickerHarness options={many} initial={['topic.1']} multiple />);
      expect(searchBox()).toBeInTheDocument();
      expect(screen.getByRole('combobox').tagName).toBe('INPUT');
      expect(screen.getByRole('button', { name: /Remove topic\.1/ })).toBeInTheDocument();
    });

    it('will not rest on one of two values a single-valued picker was given', () => {
      // Malformed input rather than a state the UI can reach — and it degrades
      // to the chip list, because a trigger can only show one thing and the
      // alternative is drawing `topic.1` while `topic.2` is silently held.
      render(<PickerHarness options={many} initial={['topic.1', 'topic.2']} />);
      expect(searchBox()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Remove topic\.2/ })).toBeInTheDocument();
    });

    it('reopens the list from the keyboard alone, and the search box comes back with it', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.1']} />);

      // No pointer anywhere in this case: Tab reaches the trigger because it is
      // a real button, and Enter activates it. Hiding the search box removed
      // both the focus target and the click handler that used to be the only
      // way back into the list, so this is the case that proves the affordance
      // replaced them rather than merely covering the resting state.
      await user.tab();
      const trigger = screen.getByRole('combobox');
      expect(trigger).toHaveFocus();

      await user.keyboard('{Enter}');
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      // The box is back, focused, and empty — so the next keystroke narrows the
      // list rather than going nowhere. A held value that could not be searched
      // past the fifty-option limit would be a regression, not a tidy-up.
      const box = screen.getByRole('combobox');
      expect(box.tagName).toBe('INPUT');
      expect(box).toHaveFocus();
      expect(box).toHaveValue('');
      await user.keyboard('Topic 110');
      expect(screen.getByRole('option', { name: 'Topic 110' })).toBeInTheDocument();
    });

    it('reopens on a press, and goes back to the value when the list shuts', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.1']} />);

      await user.click(screen.getByRole('combobox'));
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(searchBox()).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      // Back to the value, with focus on it — the same guarantee the `closing`
      // cases make for the search box, on the element that replaced it. Focus
      // on a detached node is the failure this rules out.
      const trigger = screen.getByRole('combobox');
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger).toHaveFocus();
      expect(trigger).toBeInTheDocument();
      expect(searchBox()).toBeNull();
    });

    it('keeps the label pointing at a real control across the swap', async () => {
      const user = userEvent.setup();
      render(
        <>
          <label htmlFor="repo">Repository</label>
          <PickerHarness options={many} initial={['topic.1']} id="repo" />
        </>,
      );

      // `Field` draws the label and callers find the control through it, so
      // the `id` has to travel with whichever element is on screen. If it
      // stayed on the search box the label would point at nothing for as long
      // as a value was held.
      expect(screen.getByLabelText('Repository').tagName).toBe('BUTTON');
      await user.click(screen.getByLabelText('Repository'));
      expect(screen.getByLabelText('Repository').tagName).toBe('INPUT');
    });

    it('brings the search box back when the value is cleared', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.1']} />);

      // The chip's clear button did not go away with the chip: a single-valued
      // picker could always be emptied, and emptying it is what returns the
      // control to the resting state the cases above leave alone.
      await user.click(screen.getByRole('button', { name: /Remove topic\.1/ }));
      expect(searchBox()).toBeInTheDocument();
      expect(screen.getByRole('combobox').tagName).toBe('INPUT');
      // **Focus goes with the control.** The button that was clicked is inside
      // the subtree this click unmounts, so without the deferred restore focus
      // falls to `document.body` and the next Tab starts from the top of the
      // page.
      expect(screen.getByRole('combobox')).toHaveFocus();
      // And landing there does not reopen what was just emptied: focusing the
      // search box is normally what opens the list, so the `reopening` guard is
      // load-bearing on this path too.
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // The held value is stated while the list is open.
  //
  // Every case above holds `topic.1` out of 120 options against a `limit` of
  // 50, so the held value is index 1 and is always drawn — an over-determined
  // fixture, where the *ordering* rather than the code makes the assertion
  // hold.
  //
  // These three are the configurations that fixture cannot reach, and they are
  // the three ways the list fails to state the value: it ranks past `limit`,
  // it does not match what the reader has typed, or the options do not contain
  // it at all. The third has no row to mark, which is why the answer is the
  // chip rather than promoting an option into the drawn window.
  //
  // Several hundred options against a limit of fifty is the configuration in
  // which a held value is otherwise invisible, and it is exactly the one the
  // search box was kept for.
  // -------------------------------------------------------------------------
  describe('what the control says it holds while its list is open', () => {
    /** The value, wherever the control chooses to state it. */
    const states = (text: string) => screen.queryByText(text);

    it('states a held value that ranks past the drawn limit', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.90']} />);

      await user.click(screen.getByRole('combobox'));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      // The fixture is doing the opposite of the old one's job: this asserts
      // the list *cannot* be what states the value, so the assertion below has
      // only one thing left that could satisfy it.
      expect(screen.queryByRole('option', { name: 'Topic 90' })).toBeNull();
      expect(screen.getByText(/Showing 50 of 120/)).toBeInTheDocument();

      expect(states('Topic 90')).toBeInTheDocument();
      // And it is still removable, which is the other half of what the chip is.
      expect(screen.getByRole('button', { name: /Remove topic\.90/ })).toBeInTheDocument();
    });

    it('states a held value the live query excludes', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.1']} />);

      await user.click(screen.getByRole('combobox'));
      await user.type(screen.getByRole('combobox'), 'Topic 77');

      // Index 1 of 120 — the very value the old fixture relied on being drawn —
      // and typing is enough to take it out of the list.
      expect(screen.queryByRole('option', { name: 'Topic 1' })).toBeNull();
      expect(screen.getByRole('option', { name: 'Topic 77' })).toBeInTheDocument();

      expect(states('Topic 1')).toBeInTheDocument();
    });

    it('states a held value the options do not contain at all', async () => {
      const user = userEvent.setup();
      render(<PickerHarness options={many} initial={['topic.gone']} />);

      // At rest the trigger says it, marked. This is the `picker.notOffered`
      // case: a value that has since been withdrawn, still stored on the
      // record.
      expect(states('topic.gone')).toBeInTheDocument();

      await user.click(screen.getByRole('combobox'));
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      // There is no row to promote and no row to mark — the whole reason the
      // repair could not be "put the held option in the drawn window".
      expect(screen.queryByRole('option', { name: /gone/ })).toBeNull();

      expect(states('topic.gone')).toBeInTheDocument();
      expect(screen.getByText('no longer offered')).toBeInTheDocument();
    });
  });

  /*
   * Removing a chip detaches the button that was clicked.
   *
   * The single-valued case is above, inside the resting describe, because there
   * the control changes shape as well. This is the multi case, where it does
   * not — the search box was already mounted beside the chips — and the harm is
   * the same: the focused node goes away and focus falls to the document body.
   */
  it('keeps focus in the control when a chip is removed from a multi-valued picker', async () => {
    const user = userEvent.setup();
    render(<PickerHarness options={many} initial={['topic.1', 'topic.2']} multiple />);

    await user.click(screen.getByRole('button', { name: /Remove topic\.1/ }));

    expect(screen.queryByRole('button', { name: /Remove topic\.1/ })).toBeNull();
    expect(screen.getByRole('combobox')).toHaveFocus();
    // Not by reopening the list, which focusing the search box otherwise does.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The option set can move underneath the control, because what feeds it is live
// ---------------------------------------------------------------------------

/*
 * These two cases are a **pair**, and the first is the positive control rather
 * than a second feature: they present the same movement of the same option set
 * to the same control, differing in nothing but whether the list is open at the
 * moment it moves. Only the second asserts the hold, and it proves nothing on
 * its own — a `Picker` that ignored its `options` prop entirely, or one this
 * harness never re-rendered, would pass it. The control fails by name when that
 * happens.
 *
 * The control opens and closes the list before its second move for a reason
 * that is not symmetry: the freeze has two halves, *taken on open* and
 * *released on close*, and a mutation that deletes only the release survives
 * every assertion about the open list. Moving the set at rest is what asks
 * whether it was released.
 *
 * The movement is the one a live feed actually delivers: an option is
 * withdrawn and another appears, which is what a rename looks like from here.
 */
describe('Picker — an option set that moves underneath it', () => {
  const before = [
    { value: 'tag.retrieval', label: 'Retrieval' },
    { value: 'tag.indexing', label: 'Indexing' },
  ];
  const after = [
    { value: 'tag.retrieval', label: 'Retrieval' },
    { value: 'tag.reranking', label: 'Reranking' },
  ];
  const noop = () => undefined;

  it('takes the new set at once while its list is shut, and again after it has been open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Picker values={['tag.indexing']} onChange={noop} options={before} />,
    );
    expect(screen.getByText('Indexing')).toBeInTheDocument();

    // Never opened. The control at rest states what the caller says *now*: the
    // held value is no longer on the list, so it falls back to the id and is
    // marked.
    rerender(<Picker values={['tag.indexing']} onChange={noop} options={after} />);
    expect(screen.queryByText('Indexing')).not.toBeInTheDocument();
    expect(screen.getByText('tag.indexing')).toBeInTheDocument();
    expect(screen.getByText('no longer offered')).toBeInTheDocument();

    // **And again after a freeze has been taken and released**, which is the
    // half that has to be asserted separately: a freeze that is captured on
    // open and never cleared on close passes every other case in this file —
    // the case below still sees its held set, and reopening still refreshes it
    // — while leaving a shut control labelled from whatever the option set
    // said the last time somebody looked at the list.
    rerender(<Picker values={['tag.indexing']} onChange={noop} options={before} />);
    expect(screen.getByText('Indexing')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');

    rerender(<Picker values={['tag.indexing']} onChange={noop} options={after} />);
    expect(screen.queryByText('Indexing')).not.toBeInTheDocument();
    expect(screen.getByText('no longer offered')).toBeInTheDocument();
  });

  it('holds the set it opened with until the reader has finished with it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Picker values={[]} onChange={noop} options={before} />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Indexing' })).toBeInTheDocument();

    rerender(<Picker values={[]} onChange={noop} options={after} />);

    // Nothing moved under a pointer that is on its way to a row. Both halves
    // matter: the withdrawn row is still there to be clicked, and the new one
    // has not appeared to be clicked by accident.
    expect(screen.getByRole('option', { name: 'Indexing' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Reranking' })).not.toBeInTheDocument();

    // Finishing releases it — and the release is bounded by the reader rather
    // than by a timer, so this is the whole of the freeze's lifetime.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Reranking' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Indexing' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A field you cannot type into looks like one you cannot type into
// ---------------------------------------------------------------------------

/*
 * Read-only-ness arrives from several places and they all end at one DOM
 * attribute. A field that passes `disabled` greys out; one that passes
 * `readOnly` looks exactly like a field you could type in — and that is
 * routinely the field carrying an identifier the form is *about*.
 *
 * Asserted against the stylesheet **on disk** rather than against a computed
 * style: jsdom has no cascade worth the name, so a `getComputedStyle` here
 * would pass whatever we wrote. The rule text is what decides the pixels, and
 * reading it is a real assertion — it fails the moment the rule is deleted or
 * its colour is changed to something that is not the dim token.
 */
describe('inputs.module.css — the read-only treatment', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/inputs.module.css'), 'utf8');

  /** The body of the first rule whose selector list mentions `needle`. */
  function ruleFor(needle: string): string {
    const start = css.indexOf(needle);
    expect(start, `no rule mentioning ${needle}`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open)).trim();
  }

  it('dims a read-only field and grounds it, so it does not read as typeable', () => {
    const rule = ruleFor(':read-only');
    // `--rag-dim` is defined once in `tokens.css`, so no colour literal is
    // needed here and none is wanted.
    expect(rule).toContain('color: var(--rag-dim)');
    expect(rule).toContain('background: var(--rag-surface2)');
  });

  it('does not read as a refusal: the cursor is default, never not-allowed', () => {
    // A read-only field is not the form saying no — it is the form saying what
    // it is about. `:disabled` is the refusal, and the two must not look
    // alike, or every such field reads as a control that is broken.
    const rule = ruleFor(':read-only');
    expect(rule).toContain('cursor: default');
    expect(rule).not.toContain('not-allowed');
    expect(ruleFor('.input:disabled')).toContain('cursor: not-allowed');
  });

  it('reaches the textarea and leaves the select alone', () => {
    // `Textarea` composes `.input`, so it is treated by the same rule and needs
    // no class of its own. `Select` composes `.input` too — and a `<select>`
    // matches `:read-only` *unconditionally*, because the HTML specification
    // only ever makes `<input>` and `<textarea>` read-write. A bare
    // `.input:read-only` would therefore grey out every select in the package,
    // which is why the selector is element-qualified.
    const selectors = css.slice(0, css.indexOf('{', css.indexOf(':read-only')));
    const list = selectors.slice(selectors.lastIndexOf('*/') + 2).trim();
    expect(list).toContain('input.input:read-only');
    expect(list).toContain('textarea.input:read-only');
    expect(list).not.toMatch(/(^|,)\s*\.input:read-only/);
  });
});

/**
 * **The list hovers over the surface; it does not grow it.**
 *
 * An option list that is an ordinary block in the control's flow expands the
 * box it stands in: opening one inside a dialog pushes every field below it
 * down and starts the dialog scrolling under the pointer that was reaching for
 * an option.
 *
 * The answer is `Tooltip`'s: render into `document.body` through a React
 * portal and position in viewport coordinates. That buys three things — an
 * ancestor with `overflow: auto`, which is every dialog body and every
 * scrolling pane, would otherwise **clip** the list and be **inflated** by it
 * into a scrollbar of its own.
 *
 * Two of the cases below are about what the move could quietly have broken:
 * choosing an option (the outside-press check is on `pointerdown`, which is
 * ahead of `click`, and the list is now outside the control by every DOM
 * measure) and dismissing on `Escape` (which survives because a portal
 * relocates the DOM and not the React tree).
 */
describe('Picker — the list floats free of the control', () => {
  const tags = [
    { value: 'tag.retrieval', label: 'Retrieval' },
    { value: 'tag.indexing', label: 'Indexing' },
  ];

  it('is mounted outside the control, so no box around it can be grown by it', async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="pane">
        <PickerHarness options={tags} />
      </div>,
    );

    await user.click(screen.getByRole('combobox'));
    const list = screen.getByRole('listbox');
    expect(screen.getByTestId('pane').contains(list)).toBe(false);
    expect(list.parentElement).toBe(document.body);
  });

  it('still chooses on a press, with the press landing outside the control', async () => {
    // The regression a React portal invites: `pointerdown` anywhere outside
    // the control dismisses the list, and an option is now outside it.
    // Dismissing there unmounts the option before its own `click` can arrive,
    // so the control would look like it simply refused to be chosen from.
    const user = userEvent.setup();
    render(<PickerHarness options={tags} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Indexing' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('Indexing');
  });

  it('still closes on Escape, because a portal moves the DOM and not the tree', async () => {
    const user = userEvent.setup();
    render(<PickerHarness options={tags} />);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('goes away with the control, leaving nothing behind on the body', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PickerHarness options={tags} />);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    unmount();
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  });
});

/**
 * Where the floating list is put — the arithmetic, in isolation.
 *
 * A pure function rather than an assertion about jsdom, which reports every
 * rectangle as zero and would agree with any placement at all.
 */
describe('placeList', () => {
  const anchor = { top: 100, left: 40, bottom: 130, width: 200 };

  it('opens below the control, which is where a list is looked for', () => {
    const at = placeList(anchor, 160, 1000, 800);
    expect(at.top).toBe(132);
    expect(at.left).toBe(40);
    expect(at.width).toBe(200);
  });

  it('opens upward when it does not fit below and there is more room above', () => {
    // The form's last field, with the list taller than the strip of glass
    // beneath it — 20px below, 130px above.
    const at = placeList({ top: 140, left: 40, bottom: 170, width: 200 }, 160, 1000, 200);
    expect(at.maxHeight).toBe(130);
    // **Bottom-anchored**: the list ends just above the control rather than
    // starting at its top edge and running back down over it.
    expect(at.top).toBe(140 - 2 - 130);
  });

  it('stays below when below is the roomier side, however tall the content', () => {
    // The paired control for the case above: without it, "flips when it does
    // not fit" is satisfied by a build that always flips.
    const at = placeList(anchor, 4000, 1000, 800);
    expect(at.top).toBe(132);
  });

  it('caps its height, and gives the list a scrollbar rather than the page', () => {
    const at = placeList(anchor, 4000, 1000, 4000);
    expect(at.maxHeight).toBe(256);
  });

  it('never draws a sliver: a control against the bottom edge still opens usefully', () => {
    // Eight pixels of room below and none above. Clamping to what is available
    // would give a list two rows short of unusable, so the floor wins and the
    // list sits proud of the margin instead.
    const at = placeList({ top: 0, left: 40, bottom: 792, width: 200 }, 400, 1000, 800);
    expect(at.maxHeight).toBe(96);
  });

  it('is clamped to the viewport when the control is wider than the window', () => {
    const at = placeList({ top: 100, left: -20, bottom: 130, width: 4000 }, 100, 600, 800);
    expect(at.width).toBe(584);
    expect(at.left).toBe(8);
  });
});

/**
 * The rule that makes the list float, read off the stylesheet on disk.
 *
 * Same reasoning as the read-only block above: jsdom has no cascade worth the
 * name, so `getComputedStyle` would agree with whatever was written. The rule
 * text is what decides the pixels. It is guarded because deleting one line of
 * it returns the list to normal flow — which is the fault this round was opened
 * to fix, and which no behavioural test can see, since the same options render
 * either way.
 */
describe('inputs.module.css — the floating option list', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/inputs.module.css'), 'utf8');
  const rule = (() => {
    const start = css.indexOf('.pickerOptions {');
    expect(start, 'no .pickerOptions rule').toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  })();

  it('is taken out of flow, so opening it cannot grow the box it stands in', () => {
    // `fixed`, not `absolute`: absolute would be positioned inside the control
    // and so clipped by, and counted into the scrollable overflow of, the
    // nearest `overflow: auto` ancestor — which is every dialog body.
    expect(rule).toContain('position: fixed');
  });

  it('clears the dialog scrim it is routinely opened inside', () => {
    const layer = Number(/z-index:\s*(\d+)/.exec(rule)?.[1]);
    const overlays = readFileSync(
      resolve(process.cwd(), 'src/components/overlays.module.css'),
      'utf8',
    );
    const scrim = Number(/\.scrim\s*{[^}]*z-index:\s*(\d+)/.exec(overlays)?.[1]);
    const tip = Number(/\.tip\s*{[^}]*z-index:\s*(\d+)/.exec(overlays)?.[1]);
    expect(scrim).toBeGreaterThan(0);
    // Above the tooltip layer too: a tip covering the list a reader is
    // choosing from is the same fault one storey up.
    expect(layer).toBeGreaterThan(Math.max(scrim, tip));
  });

  it('leaves the height to the code that decides which side it opens on', () => {
    // A `max-height` here and one set inline is two numbers that can disagree,
    // and the inline one wins — so the rule would look like the cap while doing
    // nothing. `placeList` owns it, `LIST_MAX_HEIGHT` is the number.
    expect(rule).not.toContain('max-height');
    expect(rule).toContain('overflow-y: auto');
  });
});
