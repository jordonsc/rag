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

/** The ETA's value (D9, D12): "done" for 0, "—" when unknown, "1 day", "N days". */
export function formatEta(days: number | null): string {
  if (days === null) {
    return '—';
  }
  if (days === 0) {
    return 'done';
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * A length of time with its unit in words (D19, VL-13): minutes under an
 * hour, hours under two days, days beyond, the hours and days worded as the
 * rate is ("2.4 hours", "12 days").
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    if (minutes === 0) {
      return seconds > 0 ? 'under a minute' : '0 minutes';
    }
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  if (seconds < 2 * 86_400) {
    const hours = formatRate(seconds / 3600);
    return hours === '1' ? '1 hour' : `${hours} hours`;
  }
  return `${formatRate(seconds / 86_400)} days`;
}

/** Active time in hours, worded as the rate is. */
function hours(seconds: number): string {
  return `${formatRate(seconds / 3600)} h`;
}

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
    eta:
      'Remaining ÷ velocity, in days of active work at this pace. ' +
      'An idle project takes longer in calendar days.',
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
