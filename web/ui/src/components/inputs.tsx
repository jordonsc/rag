import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './inputs.module.css';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { useT } from '../i18n';
import { cx } from '../util';

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'className'
>;

export interface InputProps extends NativeInputProps {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}

export function Input({ value, onChange, invalid, type = 'text', ...rest }: InputProps) {
  return (
    <input
      type={type}
      className={cx(styles.input, invalid === true && styles.invalid)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-invalid={invalid === true || undefined}
      {...rest}
    />
  );
}

export interface NumberInputProps extends Omit<NativeInputProps, 'type' | 'min' | 'max' | 'step'> {
  /** `null` represents an empty field. */
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  /** `'any'` lifts the browser's whole-number stepping, for a real number. */
  step?: number | 'any';
  invalid?: boolean;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  invalid,
  ...rest
}: NumberInputProps) {
  return (
    <input
      type="number"
      className={cx(styles.input, styles.number, invalid === true && styles.invalid)}
      value={value === null ? '' : String(value)}
      min={min}
      max={max}
      step={step}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === '') {
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        if (!Number.isNaN(parsed)) {
          onChange(parsed);
        }
      }}
      aria-invalid={invalid === true || undefined}
      {...rest}
    />
  );
}

export interface SliderProps extends Omit<NativeInputProps, 'type' | 'min' | 'max' | 'step'> {
  /** `null` is "not set": the knob rests at `min` and the reading says so. */
  value: number | null;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** `'any'` lifts whole-number stepping, for a real number. */
  step?: number | 'any';
  invalid?: boolean;
  /** How to write the reading — a unit, a rounding. Defaults to the digits. */
  format?: (value: number) => string;
}

/**
 * A bounded numeric control: a knob plus an authoritative reading.
 *
 * **The reading is stated, never inferred from where the knob looks.** A
 * slider with no read-out is a control you cannot set precisely, and these are
 * asked to set percentages and byte counts.
 *
 * A form has one writer — the draft *is* the truth until it is submitted — so
 * dragging moves the knob and the reading together and nothing is written
 * anywhere until the form commits.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  invalid,
  format,
  id,
  ...rest
}: SliderProps) {
  const t = useT();
  // The knob has to be somewhere even when the document says nothing; the
  // reading is what refuses to invent a value.
  const position = value === null ? min : value;
  return (
    <span className={styles.slider}>
      <input
        type="range"
        id={id}
        className={cx(styles.sliderTrack, invalid === true && styles.invalid)}
        value={position}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-invalid={invalid === true || undefined}
        {...rest}
      />
      <output className={styles.sliderValue} htmlFor={id}>
        {value === null ? t('slider.unset') : (format?.(value) ?? String(value))}
      </output>
    </span>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * Secondary text — what this thing belongs to, where it came from. A phrase,
   * not a sentence.
   *
   * **Drawn by {@link Picker} and ignored by {@link Select}**, and that
   * asymmetry is the contract rather than an omission: a native `<select>` has
   * an option list of plain strings and cannot draw a second line at all.
   * Folding it into the label instead would give *"Reranker retrieval
   * pipeline"* on one line, which is worse than the name alone. The rule that
   * puts on a caller is that `label` must still identify the option on its own.
   */
  detail?: string;
  /**
   * A machine identifier, drawn **monospaced** beneath the label.
   *
   * Monospace is the whole reason this is not a second `detail`: it is what
   * makes a column of similar ids scannable, and what tells a reader the string
   * is matched exactly rather than read as prose. Ignored by {@link Select}, as
   * {@link SelectOption.detail} is.
   */
  code?: string;
}

type NativeSelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange' | 'className' | 'children'
>;

export interface SelectProps extends NativeSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /**
   * The wording of the disabled leading option.
   *
   * Only the wording: `Select` draws the lead whenever the control holds
   * nothing, given or not, so this is what to set when "Choose…" is the wrong
   * prompt for this particular choice — not what to set to get a lead at all.
   */
  placeholder?: string;
  invalid?: boolean;
}

export interface SegmentedProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** The group's accessible name — a radiogroup with none is unidentifiable. */
  label?: string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  /**
   * The id a surrounding `<label>` points at, and the id of the element
   * carrying this field's help and error text.
   *
   * **Named rather than spread**, unlike {@link Select}, because a
   * `radiogroup` is a `<div>`: `{...rest}` on it would silently accept every
   * `<input>` prop a caller happened to pass and drop it on the floor. These
   * two are the pair {@link Field} actually clones onto its child, and both
   * are read by assistive technology only — `htmlFor` does not activate a
   * `div`, so the group's accessible name still comes from `label` above.
   */
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
}

/**
 * **A closed option set with every choice visible and exactly one lit.**
 *
 * Chosen by the caller, never inferred from the option count: a control that
 * picked itself over a drop-down by counting would restyle a page the day the
 * list grew by one. It is for three to five options on one line, and it is not
 * a general styling knob.
 *
 * **A `radiogroup`, not a row of buttons.** Exactly one of these is true at a
 * time and that is what a screen reader has to be told; a group of `button`s
 * announces four independent actions and never says which is current.
 *
 * **No empty lead, unlike `Select`.** The lead exists there because a
 * `<select>` whose value matches no option silently displays the first one;
 * nothing here selects itself, so a value the set does not offer draws with
 * **nothing lit** — which is the honest picture, and the one a reader can act
 * on.
 */
export function Segmented({
  value,
  onChange,
  options,
  label,
  disabled = false,
  invalid = false,
  id,
  'aria-describedby': describedBy,
}: SegmentedProps) {
  return (
    <div
      className={cx(styles.segmented, invalid && styles.invalid)}
      role="radiogroup"
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      // The same signal `Select` gives, on the element that carries the role.
      // Without it a refused segmented field is red and silent.
      aria-invalid={invalid || undefined}
      data-invalid={invalid ? 'true' : undefined}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={cx(styles.segmentedOption, on && styles.segmentedOn)}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Select({ value, onChange, options, placeholder, invalid, ...rest }: SelectProps) {
  const t = useT();
  // **A control may never display an answer the form does not hold.** A
  // `<select>` whose `value` matches no `<option>` is not left blank by the
  // browser: React marks every option unselected and the HTML "ask for a
  // reset" algorithm then selects the first one, so a reader sees the first
  // option off a form whose state is `''`, submits, and is told the value must
  // be one of the offered values — the one it appeared to be showing. The
  // empty leading option is what pins the display to the empty state.
  //
  // So the lead is drawn whenever the value is empty, with the caller's
  // wording where there is one and a neutral prompt where there is not. It is
  // suppressed only when the option set offers the empty string itself: there
  // the empty value *is* one of the choices, it has a label of its own, and a
  // second empty option would sit above it saying something else.
  const offersEmpty = options.some((option) => option.value === '');
  const lead = placeholder ?? (value === '' && !offersEmpty ? t('select.choose') : undefined);
  return (
    <select
      className={cx(styles.input, styles.select, invalid === true && styles.invalid)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-invalid={invalid === true || undefined}
      {...rest}
    >
      {lead !== undefined && (
        <option value="" disabled>
          {lead}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

type NativeTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'className'
>;

export interface TextareaProps extends NativeTextareaProps {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}

export function Textarea({ value, onChange, invalid, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cx(styles.input, styles.textarea, invalid === true && styles.invalid)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      rows={rows}
      aria-invalid={invalid === true || undefined}
      {...rest}
    />
  );
}

export interface ToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'className' | 'children' | 'type'
> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label rendered beside the switch. */
  label?: string;
}

export function Toggle({ checked, onChange, label, disabled, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx(styles.toggle, checked && styles.toggleOn)}
      onClick={() => onChange(!checked)}
      {...rest}
    >
      <span className={styles.track} aria-hidden>
        <span className={styles.knob} />
      </span>
      {label !== undefined && <span className={styles.toggleLabel}>{label}</span>}
    </button>
  );
}

export interface CheckboxSetProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

/**
 * A closed multi-select: pick any number from a set the caller named.
 *
 * The `ChipList` is the *open* list — free tags, anything the user knows and
 * this build does not. This is the other half, and the difference matters
 * where the valid values are a handful of known words: offering a text box for
 * a fixed vocabulary is offering a way to type something that silently never
 * matches. Selecting nothing is a legitimate answer, and what it means is the
 * caller's to decide.
 */
export function CheckboxSet({
  values,
  onChange,
  options,
  disabled = false,
  invalid,
  id,
  ...rest
}: CheckboxSetProps) {
  const toggle = (value: string) =>
    onChange(
      values.includes(value)
        ? values.filter((existing) => existing !== value)
        : // Kept in the offered order rather than the order they were ticked,
          // so what is saved reads the same as what is on screen.
          options.map((option) => option.value).filter((v) => v === value || values.includes(v)),
    );

  return (
    <div
      className={cx(styles.checkboxSet, invalid === true && styles.invalid)}
      role="group"
      id={id}
      {...rest}
    >
      {options.map((option) => (
        <label key={option.value} className={styles.checkboxOption}>
          <input
            type="checkbox"
            checked={values.includes(option.value)}
            disabled={disabled}
            onChange={() => toggle(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** The units a duration may be authored in, largest first. */
const DURATION_UNITS = [
  { unit: 'd', millis: 86_400_000 },
  { unit: 'h', millis: 3_600_000 },
  { unit: 'm', millis: 60_000 },
  { unit: 's', millis: 1_000 },
  { unit: 'ms', millis: 1 },
] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number]['unit'];

/** How many milliseconds one of `unit` is. */
export function unitMillis(unit: string): number {
  return DURATION_UNITS.find((entry) => entry.unit === unit)?.millis ?? 1;
}

/**
 * The largest unit `millis` divides into exactly.
 *
 * So a stored 1800000 opens as "30 minutes" rather than as 1800000
 * milliseconds — which is the entire reason this control exists. Zero has no
 * natural unit, so the caller's stated one wins.
 */
export function naturalUnit(millis: number | null, fallback: DurationUnit): DurationUnit {
  if (millis === null || millis === 0) {
    return fallback;
  }
  return DURATION_UNITS.find((entry) => millis % entry.millis === 0)?.unit ?? 'ms';
}

/**
 * **Whether these bounds describe an interval a control can be drawn between.**
 *
 * Ends that do not ascend are not an interval, and the same test decides two
 * things about the control: whether a `slider` is honoured at all, and — see
 * {@link DurationInput} — whether the caller's **stated** unit wins over the
 * one the value would suggest.
 */
function drawableInterval(bounds: DurationInputProps['bounds']): boolean {
  return bounds !== undefined && bounds.max > bounds.min;
}

export interface DurationInputProps {
  /** Milliseconds, or `null` for an empty field. */
  value: number | null;
  onChange: (millis: number | null) => void;
  /** The unit the control opens on when there is no value to infer one from. */
  unit?: DurationUnit;
  /**
   * The interval this length runs over, **in milliseconds** — the unit the
   * value is in, never the unit the control happens to be showing.
   *
   * Bounds in the display unit would change meaning the moment the unit
   * changed, which is the one thing this control exists to prevent. They are
   * re-expressed into whatever unit is chosen, exactly as the value is.
   */
  bounds?: { min: number; max: number; step?: number };
  /**
   * Draw the length as a knob rather than as a box.
   *
   * **Ignored without {@link DurationInputProps.bounds}**, and that is the
   * rule rather than defensiveness: a slider with no ends is not a control, and
   * inventing the ends here would describe an interval the caller never
   * stated.
   *
   * The unit chooser stays either way — which is what makes *"a slider in
   * seconds with a millisecond box beside it"* one control rather than two.
   */
  slider?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

/**
 * A length of time: a number and the unit it is in.
 *
 * **What leaves is always milliseconds.** The unit is a property of the
 * control, not of the value — whatever reads the duration never has to ask
 * which unit it arrived in, which is the failure mode that makes a plain
 * number field carrying "in milliseconds — thirty seconds is 30000" help text
 * the wrong answer rather than merely an ugly one.
 *
 * Changing the unit **re-expresses** the same length rather than reinterpreting
 * the number: 90 seconds picked as minutes becomes 1.5 minutes, not 90 minutes.
 * The other reading would silently multiply a timeout by sixty.
 */
export function DurationInput({
  value,
  onChange,
  unit = 'ms',
  bounds,
  slider = false,
  disabled = false,
  invalid,
  id,
  ...rest
}: DurationInputProps) {
  const t = useT();
  /**
   * **A stated interval fixes the unit; only a bare value infers one.**
   *
   * `naturalUnit` — the largest unit the stored milliseconds divide into
   * exactly — is the right answer for a duration authored as a number, and the
   * wrong one the moment the caller says which interval the length runs over.
   * `bounds` are milliseconds and `unit` is the unit they were written in, so
   * together they describe a **ladder of positions in one unit**; picking a
   * different unit from wherever the value happens to sit on that ladder
   * contradicts the control the reader is being shown.
   *
   * Worked example: bounds `{0, 5000, 100}` stated in seconds — **45 of the
   * slider's 51 positions are not whole seconds**, so 1.5 s would reopen as a
   * 0–5000 knob reading in hundreds of milliseconds while 3 s reopened as 0–5
   * in tenths. The value is never wrong; the control would be a different
   * control depending on where it had been left.
   *
   * Ends that do not ascend are not an interval, so such bounds fall back to
   * the inference.
   */
  const statedInterval = drawableInterval(bounds);
  const [chosen, setChosen] = useState<DurationUnit>(() =>
    statedInterval ? unit : naturalUnit(value, unit),
  );
  const scale = unitMillis(chosen);
  const shown = value === null ? null : value / scale;
  // Re-expressed into the chosen unit, like the value beside them. A step that
  // does not divide the unit — 100 ms shown in hours — becomes a fraction
  // rather than being rounded away, because rounding it would silently change
  // which values the control can produce.
  const ends =
    statedInterval && bounds !== undefined
      ? {
          min: bounds.min / scale,
          max: bounds.max / scale,
          step: bounds.step !== undefined && bounds.step > 0 ? bounds.step / scale : undefined,
        }
      : undefined;

  return (
    <span className={styles.duration}>
      {slider && ends !== undefined ? (
        <Slider
          id={id}
          value={shown}
          onChange={(next) => onChange(Math.round(next * scale))}
          min={ends.min}
          max={ends.max}
          step={ends.step ?? 'any'}
          // The reading is the value in the unit beside it, trimmed of the
          // float noise dividing by 1000 leaves behind — `0.30000000000000004`
          // is not a length of time anybody chose.
          format={(next) => String(Number(next.toFixed(6)))}
          disabled={disabled}
          invalid={invalid}
          {...rest}
        />
      ) : (
        <NumberInput
          id={id}
          value={shown}
          onChange={(next) => onChange(next === null ? null : Math.round(next * scale))}
          step="any"
          min={ends?.min ?? 0}
          max={ends?.max}
          disabled={disabled}
          invalid={invalid}
          {...rest}
        />
      )}
      <Select
        value={chosen}
        onChange={(next) => setChosen(next as DurationUnit)}
        options={DURATION_UNITS.map((entry) => ({
          value: entry.unit,
          label: t(`duration.unit.${entry.unit}`),
        }))}
        disabled={disabled}
        aria-label={t('duration.unit')}
      />
    </span>
  );
}

/** Clearance kept between the control and its list. */
const LIST_GAP = 2;
/** Clearance kept between the list and the edge of the viewport. */
const LIST_MARGIN = 8;
/**
 * The shortest list worth drawing. A control pressed against the bottom of the
 * window opens into whatever is left rather than into a two-pixel sliver, and
 * overflows the margin by however much that costs — a list that cannot be read
 * is worse than one that sits slightly proud of the edge.
 */
const LIST_MIN_HEIGHT = 96;
/**
 * The tallest a list is drawn, however much room there is — 16rem at the
 * default root size, which is the cap this list has always had. It lived in the
 * stylesheet until the list started being positioned; now that a `max-height`
 * is set inline it has to be here, because two of them would disagree.
 */
const LIST_MAX_HEIGHT = 256;

/** Where a picker's list is drawn, in viewport coordinates. */
export interface ListPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Place a picker's list against the control it belongs to.
 *
 * Below by preference, because that is where a list is looked for; above when
 * the content does not fit below **and** there is more room there, which is the
 * case that matters for a form's last field sitting near the bottom of the
 * window. Whichever side wins is then given a `maxHeight` of the space actually
 * available, so the list scrolls inside itself instead of running off the
 * screen.
 *
 * Width follows the control, so the list reads as part of it, and is clamped to
 * the viewport for the case where the control itself is wider than the window.
 */
export function placeList(
  anchor: { top: number; left: number; bottom: number; width: number },
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ListPosition {
  const below = viewportHeight - LIST_MARGIN - (anchor.bottom + LIST_GAP);
  const above = anchor.top - LIST_GAP - LIST_MARGIN;
  const desired = Math.min(contentHeight, LIST_MAX_HEIGHT);
  const openUp = desired > below && above > below;
  const maxHeight = Math.min(LIST_MAX_HEIGHT, Math.max(LIST_MIN_HEIGHT, openUp ? above : below));
  const height = Math.min(desired, maxHeight);
  const width = Math.min(anchor.width, viewportWidth - 2 * LIST_MARGIN);
  const left = Math.min(
    Math.max(anchor.left, LIST_MARGIN),
    Math.max(LIST_MARGIN, viewportWidth - LIST_MARGIN - width),
  );
  return {
    top: openUp ? anchor.top - LIST_GAP - height : anchor.bottom + LIST_GAP,
    left,
    width,
    maxHeight,
  };
}

export interface PickerProps {
  /** The chosen values. A single-valued picker holds none or one. */
  values: readonly string[];
  onChange: (values: string[]) => void;
  options: readonly SelectOption[];
  multiple?: boolean;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Most options to draw at once; the rest are reached by typing. */
  limit?: number;
  id?: string;
  'aria-describedby'?: string;
}

/**
 * A searchable chooser over a set the caller supplied.
 *
 * `Select` is the *small closed* control — a handful of statuses, a topic type
 * — and it stops working somewhere around a few dozen options with no useful
 * ordering to scroll through. This is the other half: type to narrow, click to
 * choose.
 *
 * **A chosen value that is not in the options is shown, not dropped.** A value
 * stored when the set was wider still renders, marked as no longer offered.
 * Quietly removing it would delete the user's work to make a control tidy, and
 * they would find out later, from the thing that stopped working.
 *
 * **The list closes when the user looks away**: a press outside the control, or
 * `Escape`. Three details in that are load-bearing.
 *
 * *`pointerdown`, not `click`* — it is what a native `<select>` reacts to, it
 * fires before a target that is about to unmount can take its `click` with it,
 * and on a touch screen it arrives immediately rather than after the
 * synthesised mouse event.
 *
 * *Never on blur* — the options are `<button>`s, so focus moving to one is a
 * blur of the input, and closing there would cancel the selection being made.
 *
 * *`Escape` stops propagating* — dialogs are modal and close on `Escape`
 * themselves, so one press must close exactly one layer. It is also guarded on
 * `open`, or a picker sitting closed inside a dialog would swallow the press
 * that was meant for the dialog.
 *
 * **A single-valued picker holding a value rests as a value, not as a search
 * box.** A chip plus a permanently-open search box is the *multi* idiom, and
 * reading it on a control that can hold exactly one thing says the wrong thing
 * about the control. So once one value is held and `multiple` is false, the
 * chip and the search box are replaced by a single **trigger** — the chosen
 * label, a caret, and the clear button beside it, which is what a `<select>`
 * looks like at rest.
 *
 * Four things about that swap are load-bearing.
 *
 * *The search box comes back when the list opens, rather than going away.* A
 * set of several hundred options against a `limit` of fifty is exactly the case
 * this control is for, so a held value that could no longer be searched past
 * would be a functional regression dressed as a tidy-up. Opening the trigger
 * renders the same `Input`, focused and empty; closing puts the trigger back.
 *
 * *And the chip comes back with it, because the list cannot be relied on to
 * state the value.* There are three ways the held value is not in the list: it
 * ranks past `limit`, the query does not match it, or the options do not
 * contain it at all (a stale value, the case `picker.notOffered` exists for) —
 * and that last one has no row to mark, so promoting a row into the drawn
 * window could never cover it. Hence the suppression is on *held **and** shut*
 * rather than on *held*: at rest the chip is the trigger's job, and the moment
 * the list opens the chip is back, saying what the control holds while the user
 * searches for what to replace it with. `aria-selected` still marks the row
 * where there is one; it is a confirmation rather than the statement.
 *
 * *One element carries the ARIA at a time.* Whichever of the two is on screen
 * is the `role="combobox"` and wears the `id` — so a `<label for>` keeps
 * pointing at a real control across the swap, and the trigger announces the
 * value as its content the way a closed `<select>` does. `aria-controls` is
 * still only ever set while the list exists.
 *
 * *Focus is returned by an effect, not inside `dismiss`.* The control changes
 * shape in the same commit that closes the list, so a synchronous `focus()`
 * would land on the node that render is about to detach — after which focus
 * falls to the document body, which is the exact fault the focus return exists
 * to prevent. See `restoreFocus` below.
 *
 * **Two values in a single-valued picker is not this state.** It should not
 * happen, and if it does the control falls back to the chip list rather than
 * drawing the first value and silently hiding the rest.
 *
 * **The list floats over the surface; it does not push it about.** As an
 * ordinary block in the control's own flow, opening it inside a dialog *grows
 * the dialog* — every field below it moves, and on a dialog already at its
 * `max-height` the surface starts scrolling under the pointer while the list is
 * being read.
 *
 * It is therefore rendered into `document.body` through a React portal and
 * positioned in viewport coordinates by {@link placeList} — the arrangement
 * `Tooltip` uses, for the same two reasons stated there: an ancestor with
 * `overflow: auto`, which is every dialog body and every scrolling pane, would
 * otherwise **clip** the list and be **inflated** by it into growing a
 * scrollbar of its own. Absolute positioning inside the control fixes the first
 * half of that and neither of the other two.
 *
 * Two consequences are load-bearing. The outside-press check has to consider
 * the list as well as the control, because the list is no longer inside it in
 * the DOM and a press on an option would otherwise dismiss the list before the
 * option's `click` arrived. And `Escape` still works because a React portal is
 * a DOM relocation, not a tree one: the `<ul>` remains a child of this
 * component, so synthetic events still reach the handler on the container.
 */
export function Picker({
  values,
  onChange,
  options,
  multiple = false,
  placeholder,
  disabled = false,
  invalid,
  limit = 50,
  id,
  ...rest
}: PickerProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  /**
   * Where the floating list is drawn.
   *
   * Measured in a layout effect rather than on render, so the first paint is
   * already in the right place — a list that appeared at the top-left corner
   * and jumped would be worse than the in-flow list this replaced.
   */
  const [at, setAt] = useState<ListPosition>({ top: 0, left: 0, width: 0, maxHeight: 0 });
  /**
   * **The option set does not move while the list is open.**
   *
   * A caller's options can be refreshed from the server while this control is
   * on screen, so the set behind it changes when the data does rather than only
   * when the user asks. That is worth having — and it is also the argument for
   * freezing: a row reordered, removed or relabelled under a pointer that is
   * travelling towards it is worse than a second's staleness.
   *
   * Both are satisfied by making staleness a **caller** concern and mid-choice
   * movement a **control** one. The caller stays live; this control holds the
   * set it opened with for exactly as long as the list is open. The freeze ends
   * the moment the user finishes — a choice, an `Escape`, or a press outside —
   * so it is bounded by their own attention rather than by a timer.
   *
   * It lives here rather than at the call sites because the control is the only
   * party that knows the list is open; a caller trying to hold the set for it
   * would be guessing at a state it cannot see.
   *
   * **Closed, nothing is frozen**, which matters more than it looks: a held
   * value's chip is labelled from this set and marked `picker.notOffered` when
   * it is not in it, so a control at rest states what the data says now.
   *
   * Recorded in an effect rather than in the render body. A ref written during
   * render survives a pass React discards and re-invokes; a state write in an
   * effect costs one extra render per open and cannot lie.
   */
  const [frozen, setFrozen] = useState<readonly SelectOption[] | undefined>(undefined);
  const latestOptions = useRef(options);
  useEffect(() => {
    latestOptions.current = options;
  }, [options]);
  useEffect(() => {
    setFrozen(open ? latestOptions.current : undefined);
  }, [open]);
  /** The set this control draws: what it opened with, or what it has now. */
  const shown = frozen ?? options;
  // Focusing the input is what *opens* the list, so returning focus to it after
  // a deliberate close would reopen what was just shut.
  const reopening = useRef(false);
  // Set by anything that detaches the element focus is on — a shape change, or
  // a chip whose remove button goes with the chip — and wants focus to follow
  // the control rather than fall to the document body. Spent by the effect
  // below, after the render. Every such path sets it: `dismiss(true)`, the
  // trigger's `onClick`, and both clear buttons.
  const restoreFocus = useRef(false);

  /**
   * Shut the list.
   *
   * The query goes with it. The box is a search field, not the value — leaving
   * "retr" in it after the list closes shows an input that appears to hold
   * something the control does not, and reopening would then show a filtered
   * list with nothing on screen explaining why.
   */
  const dismiss = (returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) {
      // Focus may be on an option that is about to stop existing, and — once a
      // single-valued picker holds a value — on a *search box* that is about to
      // stop existing too. Deferred to the effect below rather than called
      // here, because this render has not happened yet.
      restoreFocus.current = true;
    }
  };

  /**
   * Put focus back on whichever element is the control after the render that
   * `dismiss` (or the trigger) just asked for.
   *
   * It cannot be done synchronously any more. Closing a single-valued picker
   * that holds a value swaps its search box for the trigger in the same commit;
   * opening it swaps the trigger back for the search box. Focusing before that
   * commit focuses a node about to be detached, and focus then falls to the
   * document body, so the next Tab starts from the top of the page. An effect
   * runs after the DOM is updated, which is the one moment both facts are true:
   * the list is in its new state, and the element to focus exists.
   *
   * The query is `[role="combobox"]` rather than `input` for the same reason —
   * the two elements are interchangeable and exactly one of them is present.
   * The `reopening` guard is still spent across the synchronous `focus()`, and
   * still cleared afterwards for the case where focus never moved and no event
   * fired at all.
   */
  useEffect(() => {
    if (!restoreFocus.current) {
      return;
    }
    restoreFocus.current = false;
    reopening.current = true;
    container.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
    reopening.current = false;
  });

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // **The list counts as inside**, and this is not defensive tidiness: it
      // is rendered into `document.body` through a React portal, so a press on
      // an option is a press outside the container by every DOM measure — and
      // `pointerdown` is deliberately ahead of `click`, so dismissing here
      // would unmount the option before its own `click` could choose it.
      const inside =
        (container.current?.contains(target) ?? false) || (list.current?.contains(target) ?? false);
      if (container.current !== null && !inside) {
        // No focus return: the user has already said where they are going, and
        // stealing focus back would fight them for it.
        dismiss(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const labels = new Map(shown.map((option) => [option.value, option.label]));
  const needle = query.trim().toLowerCase();
  // The `code` is searched and the `detail` is not, which is a deliberate split
  // rather than an oversight. A code is an identifier a user types to find one
  // row — the whole reason it is drawn — while a detail is a grouping, and
  // matching on it would make typing a group's name silently narrow to every
  // member of it. `value` is searched already and usually *is* the code, so
  // this changes nothing where the two agree and covers the case where a
  // caller shows an id it does not key on.
  const matching = shown.filter(
    (option) =>
      needle === '' ||
      option.value.toLowerCase().includes(needle) ||
      option.label.toLowerCase().includes(needle) ||
      (option.code?.toLowerCase().includes(needle) ?? false),
  );
  const drawn = matching.slice(0, limit);

  // The one value a single-valued picker holds, once it holds one — `undefined`
  // in every other case, including the malformed one where a `multiple: false`
  // picker has somehow been given two. See the header: that falls back to the
  // chip list rather than drawing one value and hiding the other.
  const held = !multiple && values.length === 1 ? values[0] : undefined;
  // Open, the control is a search box; closed and holding a value, it is the
  // value. Exactly one of the two is ever on screen.
  const resting = held !== undefined && !open;

  /**
   * Keep the floating list against the control.
   *
   * Re-measured on every scroll — captured, because the control may sit in a
   * pane rather than in the document — and on resize, which is the same
   * contract `Tooltip` keeps. The content height read is `scrollHeight`, the
   * height the list *wants*, so applying a `maxHeight` from it cannot feed back
   * into the next measurement and oscillate.
   */
  useLayoutEffect(() => {
    if (!open || disabled) {
      return undefined;
    }
    const reposition = () => {
      const anchor = container.current?.getBoundingClientRect();
      if (anchor === undefined) {
        return;
      }
      setAt(
        placeList(anchor, list.current?.scrollHeight ?? 0, window.innerWidth, window.innerHeight),
      );
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, disabled, query, drawn.length]);

  const choose = (value: string) => {
    if (multiple) {
      onChange(values.includes(value) ? [...values] : [...values, value]);
      setQuery('');
      return;
    }
    onChange([value]);
    // A single-valued pick is finished, so the list shuts and focus comes back
    // off the option that is about to unmount — without which it falls to the
    // document body and the next Tab starts from the top of the page.
    dismiss(true);
  };

  return (
    <div
      ref={container}
      className={cx(styles.picker, invalid === true && styles.invalid)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) {
          return;
        }
        event.preventDefault();
        // One Escape closes one layer: the dialogs this control sits inside
        // close on Escape too, and they listen further up the tree.
        event.stopPropagation();
        dismiss(true);
      }}
    >
      {/* Gated on `resting`, not on `held`: a held value hides its chip only
          while the trigger is on screen saying the same thing. Open the list
          and the chip is the only surface stating what is held — the row may
          rank past `limit`, may not match the query, or may not exist at
          all. */}
      {values.length > 0 && !resting && (
        <ul className={styles.chips}>
          {values.map((value) => (
            <li key={value} className={styles.chip}>
              <span className={styles.chipText}>{labels.get(value) ?? value}</span>
              {!labels.has(value) && (
                <span className={styles.pickerStale}>{t('picker.notOffered')}</span>
              )}
              <IconButton
                icon="x"
                size={12}
                label={t('chiplist.remove', { value })}
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  // This button is what has focus, and removing the chip
                  // detaches it — after which focus falls to the document body
                  // and the next Tab starts from the top of the page. The
                  // control's *shape* does not change here the way it does at
                  // rest (the search box is already mounted beside the chips),
                  // so this is the same harm by a different route; the
                  // mechanism covers both, and the `reopening` guard keeps the
                  // focus it lands from reopening a shut list.
                  restoreFocus.current = true;
                  onChange(values.filter((existing) => existing !== value));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {resting && held !== undefined && (
        <div className={styles.pickerValue}>
          <button
            type="button"
            id={id}
            role="combobox"
            // Always false, and honestly so: while the list is open this button
            // is not on screen and the search box is the combobox.
            aria-expanded={false}
            aria-haspopup="listbox"
            className={cx(styles.input, styles.pickerTrigger, invalid === true && styles.invalid)}
            disabled={disabled}
            onClick={() => {
              setOpen(true);
              // The search box is about to take this button's place, so it is
              // about to take its focus too.
              restoreFocus.current = true;
            }}
            {...rest}
          >
            <span className={styles.pickerTriggerText}>{labels.get(held) ?? held}</span>
            {!labels.has(held) && (
              <span className={styles.pickerStale}>{t('picker.notOffered')}</span>
            )}
            <Icon name="chevron-down" size={14} className={styles.pickerCaret} />
          </button>
          {/* The chip's clear button, kept where the chip used to be: a
              single-valued picker could always be emptied and still can. */}
          <IconButton
            icon="x"
            size={12}
            label={t('chiplist.remove', { value: held })}
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              // Emptying the control unmounts this whole group — this button
              // included, while it holds focus — and mounts the search box in
              // its place. That is precisely the shape change `restoreFocus`
              // exists for.
              restoreFocus.current = true;
              onChange([]);
            }}
          />
        </div>
      )}
      {!resting && (
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          // Only while the list exists: pointing `aria-controls` at an id that
          // is not in the document is a broken reference, not a hint.
          aria-controls={open && !disabled ? listId : undefined}
          value={query}
          onChange={(next) => {
            setQuery(next);
            setOpen(true);
          }}
          onFocus={() => {
            if (reopening.current) {
              reopening.current = false;
              return;
            }
            setOpen(true);
          }}
          // Focus alone is not enough to reopen: after `Escape` the input is
          // *already* focused, so pressing it again moves no focus, fires no
          // event, and the control sits there refusing to open. Found in a real
          // browser, and reproducible headlessly once you know to look for it —
          // `user-event` skips re-focusing an already-focused element too.
          onClick={() => setOpen(true)}
          placeholder={placeholder ?? t('picker.search')}
          disabled={disabled}
          invalid={invalid}
          {...rest}
        />
      )}
      {open &&
        !disabled &&
        createPortal(
          <ul
            id={listId}
            ref={list}
            className={styles.pickerOptions}
            role="listbox"
            // Viewport coordinates, so no ancestor can clip the list or be
            // inflated by it. See the header, and `placeList`.
            style={{ top: at.top, left: at.left, width: at.width, maxHeight: at.maxHeight }}
          >
            {drawn.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={values.includes(option.value)}
                  className={cx(
                    styles.pickerOption,
                    values.includes(option.value) && styles.pickerChosen,
                  )}
                  onClick={() => choose(option.value)}
                >
                  {/* A row rather than a line, where the caller gave one. The
                    label leads; the detail sits to its right; the code goes
                    beneath in monospace. An option carrying neither draws as a
                    single span with no grid, so the simple case stays
                    simple. */}
                  {option.detail === undefined && option.code === undefined ? (
                    option.label
                  ) : (
                    <span className={styles.optionRow}>
                      <span className={styles.optionHead}>
                        <span className={styles.optionLabel}>{option.label}</span>
                        {option.detail !== undefined && (
                          <span className={styles.optionDetail}>{option.detail}</span>
                        )}
                      </span>
                      {option.code !== undefined && (
                        <span className={styles.optionCode}>{option.code}</span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {matching.length === 0 && (
              <li className={styles.pickerNote}>
                {shown.length === 0 ? t('picker.none') : t('picker.noMatch')}
              </li>
            )}
            {matching.length > drawn.length && (
              <li className={styles.pickerNote}>
                {t('picker.more', { shown: drawn.length, total: matching.length })}
              </li>
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}

export interface SecretInputProps extends Omit<InputProps, 'type'> {}

/** A masked input with a reveal toggle, for a value that should not be read
 *  over a shoulder. */
export function SecretInput({ value, onChange, invalid, ...rest }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);
  const t = useT();
  return (
    <span className={styles.secret}>
      <Input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        invalid={invalid}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      <IconButton
        icon={revealed ? 'eye-off' : 'eye'}
        label={t(revealed ? 'secret.hide' : 'secret.reveal')}
        variant="ghost"
        pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
      />
    </span>
  );
}

/**
 * What a form holds to make a half-typed chip real before it submits.
 *
 * The problem it solves: a chip is committed on Enter or on the `+` button, so
 * text still sitting in the entry box when the surrounding form is submitted is
 * not in `values` and is thrown away — silently, and after a write that
 * *succeeded*, which is the worst shape a data loss can take. Blur closes most
 * of it (clicking a submit button moves focus first), but not all: a form
 * submitted from the keyboard, or one whose submit handler runs before the
 * browser dispatches the blur, would still lose the draft.
 *
 * `commit` therefore **returns** the resulting values rather than only calling
 * `onChange`. A caller that has just submitted cannot read the state React is
 * about to set — it is still rendering the old value — so it needs the answer
 * back in its own hand, in the same tick.
 */
export interface ChipListHandle {
  /**
   * Commit whatever is in the entry box and answer with the values that
   * result. Idempotent, and returns the current values unchanged when there is
   * nothing pending.
   */
  commit: () => string[];
}

export interface ChipListProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  minItems?: number;
  maxItems?: number;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  'aria-describedby'?: string;
  /** Somewhere for a form to reach {@link ChipListHandle.commit} on submit. */
  handleRef?: RefObject<ChipListHandle | null>;
}

/** An editable list of free strings — tags, and anything else open-ended. */
export function ChipList({
  values,
  onChange,
  placeholder,
  minItems,
  maxItems,
  disabled = false,
  invalid,
  id,
  handleRef,
  ...rest
}: ChipListProps) {
  const [draft, setDraft] = useState('');
  const t = useT();

  const atMax = maxItems !== undefined && values.length >= maxItems;
  const atMin = minItems !== undefined && values.length <= minItems;

  const commit = (): string[] => {
    const value = draft.trim();
    if (value === '' || atMax || values.includes(value)) {
      // Nothing to add — but a draft that duplicates an existing chip, or one
      // typed against a full list, is still cleared: leaving it in the box
      // after a submit would suggest it is going to be added later.
      if (value !== '') {
        setDraft('');
      }
      return [...values];
    }
    const next = [...values, value];
    onChange(next);
    setDraft('');
    return next;
  };

  const add = () => {
    commit();
  };

  useImperativeHandle(handleRef, () => ({ commit }));

  return (
    <div className={cx(styles.chipList, invalid === true && styles.invalid)}>
      {values.length > 0 && (
        <ul className={styles.chips}>
          {values.map((value) => (
            <li key={value} className={styles.chip}>
              <span className={styles.chipText}>{value}</span>
              <IconButton
                icon="x"
                size={12}
                label={t('chiplist.remove', { value })}
                variant="ghost"
                disabled={disabled || atMin}
                onClick={() => onChange(values.filter((existing) => existing !== value))}
              />
            </li>
          ))}
        </ul>
      )}
      <span className={styles.chipEntry}>
        <Input
          id={id}
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          disabled={disabled || atMax}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          // Leaving the box commits what is in it. A tag typed and then
          // abandoned by clicking elsewhere is added rather than dropped, which
          // is the right way round to be wrong: an unwanted chip is visible and
          // removable, a lost one is neither.
          onBlur={add}
          {...rest}
        />
        <IconButton
          icon="plus"
          label={t('chiplist.add')}
          disabled={disabled || atMax || draft.trim() === ''}
          onClick={add}
        />
      </span>
    </div>
  );
}
