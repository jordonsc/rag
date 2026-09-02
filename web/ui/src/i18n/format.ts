/**
 * Locale-aware presentation of the values a surface reads out.
 *
 * These live beside the catalogue rather than beside a component because what
 * they decide is the locale's business: whether a thousands separator is a
 * comma or a full stop, and what "5d" is called, are answered by `Intl` for
 * the locale the catalogue is written in. A hand-rolled regex over digit
 * groups would be a second, poorer locale table sitting beside the platform's
 * — and wrong in every locale but this one.
 *
 * Nothing here decides *whether* a value should be formatted this way. A
 * renderer cannot tell a count of things from a length of time; the caller
 * says which.
 */

/** The locale the shipped catalogue is written in. */
export const DEFAULT_LOCALE = 'en-GB';

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string): Intl.NumberFormat {
  let format = numberFormats.get(locale);
  if (format === undefined) {
    // Six fraction digits rather than `Intl`'s default three: silently
    // rounding a value to three places would be the formatter changing a
    // reading. Six is also past where IEEE-754 noise shows up, so 0.1 + 0.2
    // still reads as 0.3.
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
    numberFormats.set(locale, format);
  }
  return format;
}

/**
 * A quantity, with the locale's group separators.
 *
 * Not for an identifier, a port, a year or a version — those are numbers that
 * are not quantities, and 8760 becoming "8,760" makes them unreadable. The
 * caller decides.
 */
export function formatNumber(value: number, locale: string = DEFAULT_LOCALE): string {
  // A non-finite value is stated as itself. Formatting it would print
  // "∞" in some locales and nothing useful in any of them.
  return Number.isFinite(value) ? numberFormat(locale).format(value) : String(value);
}

const UNIT_MILLIS = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1000,
} as const;

/** Largest first — the order the two shown units are picked in. */
const UNITS = ['day', 'hour', 'minute', 'second'] as const;

type DurationUnitName = (typeof UNITS)[number];

const unitFormats = new Map<string, Intl.NumberFormat>();

function unitFormat(locale: string, unit: DurationUnitName): Intl.NumberFormat {
  const key = `${locale}:${unit}`;
  let format = unitFormats.get(key);
  if (format === undefined) {
    // `unitDisplay: 'narrow'` is what gives "5d" rather than "5 days"; the
    // locale decides the abbreviation, which is the whole reason this goes
    // through `Intl` instead of a suffix table.
    format = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow',
      maximumFractionDigits: 0,
    });
    unitFormats.set(key, format);
  }
  return format;
}

export interface DurationLabels {
  /** Shown for a length shorter than one second. */
  moment: string;
}

const DEFAULT_LABELS: DurationLabels = { moment: 'Less than a second' };

/**
 * A length of time, in the two largest units that say anything.
 *
 * 451 234 seconds is "5d 5h", not "451,234" and not "5d 5h 20m 34s". Two units
 * is the precision a reader wants from an elapsed span: the first says how
 * long, the second says how long *within* that, and everything after it is
 * noise on a figure of that size. The second unit is the one immediately below
 * the first and is omitted when it is zero, so a whole number of days reads
 * "5d" rather than "5d 0h" — and never skips down to minutes, which would
 * claim a precision the leading unit has already ruled out.
 *
 * A length under one second is a phrase rather than "0s", because zero is the
 * one reading that is certainly wrong: the thing being measured did happen.
 */
export function formatDuration(
  millis: number,
  locale: string = DEFAULT_LOCALE,
  labels: Partial<DurationLabels> = {},
): string {
  if (!Number.isFinite(millis)) {
    return String(millis);
  }
  if (millis < 0) {
    return `-${formatDuration(-millis, locale, labels)}`;
  }
  if (millis < UNIT_MILLIS.second) {
    return labels.moment ?? DEFAULT_LABELS.moment;
  }

  const index = UNITS.findIndex((unit) => millis >= UNIT_MILLIS[unit]);
  const unit = UNITS[index]!;
  const whole = Math.floor(millis / UNIT_MILLIS[unit]);
  const parts = [unitFormat(locale, unit).format(whole)];

  const next = UNITS[index + 1];
  if (next !== undefined) {
    const remainder = Math.floor((millis - whole * UNIT_MILLIS[unit]) / UNIT_MILLIS[next]);
    if (remainder > 0) {
      parts.push(unitFormat(locale, next).format(remainder));
    }
  }
  return parts.join(' ');
}

/** [`formatDuration`] for a value an application states in whole seconds. */
export function formatDurationSeconds(
  seconds: number,
  locale: string = DEFAULT_LOCALE,
  labels: Partial<DurationLabels> = {},
): string {
  return Number.isFinite(seconds)
    ? formatDuration(seconds * 1000, locale, labels)
    : String(seconds);
}

const stampFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant, as a person reads it: `17 Aug 2026, 14:05`.
 *
 * `hourCycle` is pinned to `h23` deliberately. A record that is quoted between
 * people must not read as the afternoon on one machine and the morning on
 * another, and a 12-hour clock in a locale that prefers one is exactly that.
 */
export function formatStamp(at: Date | string | number, locale: string = DEFAULT_LOCALE): string {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) {
    return String(at);
  }
  let format = stampFormats.get(locale);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    stampFormats.set(locale, format);
  }
  return format.format(when);
}
