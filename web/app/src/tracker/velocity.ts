/**
 * How fast a project's tickets get done, as the queue page's widget says it
 * (spec:velocity, D12–D14): the figures' wording, the tooltips, and the
 * window the reader chose.
 *
 * Kept apart from `VelocityBar.tsx` so the report page (m03, `ReportView.tsx`)
 * reads the same window choice and says its figures the same way.
 */

import { VELOCITY_WINDOWS, type Velocity, type VelocityWindow } from './types';

/** The pill's options (D12): 7 days first, the default. */
export const WINDOW_OPTIONS: readonly { value: VelocityWindow; label: string }[] = [
  { value: '7d', label: '7 d' },
  { value: '24h', label: '24 h' },
];

/** `value` rounded to `places` decimals, half away from zero (D12). */
function roundHalfAway(value: number, places: number): number {
  const scale = 10 ** places;
  // `Math.round` rounds half up (-2.5 to -2), so round the magnitude.
  return (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale;
}

/**
 * A rate or a count of hours as the widget reads it (D12): a whole number
 * when it is 10 or more, or when rounding it to one decimal gives a whole
 * number ("8" for 8 and 8.04, "0" for 0); otherwise one decimal ("2.4", and
 * 9.96 reads "10", not "10.0"). Rounded half away from zero (10.5 reads
 * "11"), as the MCP's `rate()` does, so the two always agree (D32).
 */
export function formatRate(value: number): string {
  const tenths = roundHalfAway(value, 1);
  if (Math.abs(tenths) >= 10 || Number.isInteger(tenths)) {
    // `+ 0` turns a -0 into 0.
    return String(roundHalfAway(value, 0) + 0);
  }
  return tenths.toFixed(1);
}

/** "8/day", "2.4/day" (D12). */
export function formatVelocity(perDay: number): string {
  return `${formatRate(perDay)}/day`;
}

// ---- Lengths of time (owner request rag-t0062) ------------------------------

/** A number and its unit, apart, so a tile can set the unit smaller. */
export interface Parts {
  /** "1.6", "32", "<0.1", "done", "—". */
  value: string;
  /** "days", "hour", "/day", or `''` for none. */
  unit: string;
}

/** The value and its unit as one string: "1.6 days", "8/day", "done". */
export function joinParts({ value, unit }: Parts): string {
  if (unit === '') {
    return value;
  }
  return unit.startsWith('/') ? `${value}${unit}` : `${value} ${unit}`;
}

/**
 * An amount in the owner's rule (rag-t0062): one decimal below 5, a whole
 * number from 5; a decimal that rounds to a whole number reads whole ("1",
 * not "1.0", and 4.96 reads "5"). Rounded half away from zero, as the MCP's
 * `amount()` does, so the two always agree.
 */
export function formatAmount(value: number): string {
  if (value < 5) {
    const tenths = roundHalfAway(value, 1);
    if (!Number.isInteger(tenths)) {
      return tenths.toFixed(1);
    }
  }
  // `+ 0` turns a -0 into 0.
  return String(roundHalfAway(value, 0) + 0);
}

/** The units a length is worded in, smallest first; a month is 365.25 ÷ 12 days. */
const UNITS = [
  { one: 'minute', many: 'minutes', seconds: 60 },
  { one: 'hour', many: 'hours', seconds: 3_600 },
  { one: 'day', many: 'days', seconds: 86_400 },
  { one: 'week', many: 'weeks', seconds: 604_800 },
  { one: 'month', many: 'months', seconds: 2_629_800 },
] as const;

export type SmallestUnit = 'minute' | 'hour';

/**
 * A length of time in the largest unit it is over one and a half of
 * (rag-t0062): minutes (or hours, for the ETA) until 1.5 hours (90 minutes),
 * then hours until 1.5 days (36 hours), days until 1.5 weeks (10.5 days),
 * weeks until 1.5 months, months beyond; the amount in `formatAmount`'s rule
 * ("32 hours", "1.6 days", "1.6 weeks", "6 weeks", "4.6 months"), singular
 * for exactly one ("1 day"). Something that rounds to nothing but is not
 * nothing reads "<0.1". Mirrored exactly by the MCP's `duration()`
 * (`crates/mcp/src/tracker.rs`), and pinned by the same cases on both sides.
 */
export function durationParts(seconds: number, smallest: SmallestUnit = 'minute'): Parts {
  const s = Math.max(0, seconds);
  let i = UNITS.findIndex((u) => u.one === smallest);
  while (i + 1 < UNITS.length && s > 1.5 * UNITS[i + 1]!.seconds) {
    i += 1;
  }
  const unit = UNITS[i]!;
  const amount = s / unit.seconds;
  let value = formatAmount(amount);
  if (value === '0' && s > 0) {
    value = '<0.1';
  }
  return { value, unit: value === '1' ? unit.one : unit.many };
}

/**
 * A length of time with its unit in words, for the report (D19, VL-13):
 * `durationParts` from minutes ("42 minutes", "2.5 hours", "6.7 days").
 */
export function formatElapsed(seconds: number): string {
  return joinParts(durationParts(seconds, 'minute'));
}

/**
 * The ETA (D9, D12, amended by rag-t0062): `eta_days` worded from hours up
 * ("32 hours", "1.6 days", "6 weeks"); "done" with nothing remaining, "—"
 * when it is unknown (`spoken` says "unknown", for a screen reader).
 */
export function etaParts(days: number | null): Parts & { spoken?: string } {
  if (days === null) {
    return { value: '—', unit: '', spoken: 'unknown' };
  }
  if (days <= 0) {
    return { value: 'done', unit: '' };
  }
  return durationParts(days * 86_400, 'hour');
}

/** The ETA as one string: "1.6 days", "done", "—". */
export function formatEta(days: number | null): string {
  const { value, unit } = etaParts(days);
  return joinParts({ value, unit });
}

/** A velocity apart: "8" and "/day". */
export function velocityParts(perDay: number): Parts {
  return { value: formatRate(perDay), unit: '/day' };
}

/** Active time in hours, worded as the rate is. */
function hours(seconds: number): string {
  return `${formatRate(seconds / 3600)} h`;
}

/**
 * What an ETA's tooltip says (D14), on the widget and on the roadmap's figures
 * (spec:roadmap D24): active work at this pace, never a date.
 */
export const ETA_TOOLTIP =
  'Remaining ÷ velocity, in days of active work at this pace. ' +
  'An idle project takes longer in calendar days.';

/** The tooltips (D14), the native `title` as `linkTooltip` gives one. */
export function velocityTooltips(velocity: Velocity): {
  velocity: string;
  eta: string;
  inProgress: string;
  pending: string;
} {
  const week = velocity.windows['7d'];
  const day = velocity.windows['24h'];
  return {
    velocity:
      `${week.done} done in the last 7 days over ${hours(week.active_seconds)} of active time ` +
      `(24 h: ${day.done} over ${hours(day.active_seconds)}). ` +
      'Active time leaves out gaps of over 2 hours between writes.',
    eta: ETA_TOOLTIP,
    inProgress: `Includes ${velocity.in_review} in review.`,
    pending: `Includes ${velocity.blocked} blocked. Deferred tickets (${velocity.deferred}) are left out.`,
  };
}

/**
 * Whether the project has any counted ticket, ever (D11): one open now, one
 * put aside, or one done this week. A project with none shows no widget.
 */
export function hasCountedTickets(velocity: Velocity): boolean {
  return velocity.remaining + velocity.deferred + velocity.windows['7d'].done > 0;
}

// ---- The window chosen ------------------------------------------------------

const WINDOW_KEY = 'rag.tracker.velocityWindow';

export function isVelocityWindow(value: unknown): value is VelocityWindow {
  return VELOCITY_WINDOWS.some((option) => option === value);
}

/**
 * The window the reader last chose, for every project (D13); 7 days when
 * none is kept, or what is kept is not a window.
 *
 * Guarded as `paths.ts` guards the last project: `localStorage` throws when
 * a browser refuses site data, and a choice that cannot be remembered is the
 * default.
 */
export function readVelocityWindow(): VelocityWindow {
  try {
    const stored = window.localStorage.getItem(WINDOW_KEY);
    return isVelocityWindow(stored) ? stored : '7d';
  } catch {
    return '7d';
  }
}

export function storeVelocityWindow(choice: VelocityWindow): void {
  try {
    window.localStorage.setItem(WINDOW_KEY, choice);
  } catch {
    // Storage refused: the pill still switches, it just will not remember.
  }
}
