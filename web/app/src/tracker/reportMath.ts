/**
 * The report page's arithmetic (spec:velocity D16, VL-12): the server's
 * hourly UTC buckets summed into the reader's local days, a day's labels, and
 * "nice" axis ticks.
 *
 * Local time is the browser's (`Date`'s local fields), so a day boundary
 * falls at the reader's midnight. An hour belongs to the day it starts in:
 * in a time zone a half or quarter hour off UTC, the hour that straddles
 * midnight is counted on the day before it.
 */

import type { ReportBucket } from './types';

/** One local day of the burn-down. */
export interface DayBucket {
  /** The local date, `YYYY-MM-DD`. */
  day: string;
  /** The first hour's start, RFC 3339 UTC. */
  start: string;
  /** Remaining at the end of the day's last hour (D16). */
  remaining: number;
  /** Summed over the day's hours. */
  added: number;
  done: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date of an instant, `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Hourly buckets, oldest first, summed into local days: `added` and `done`
 * summed, `remaining` the last hour's. A window that starts mid-day starts
 * with a partial day, and the 7-day view ends with today, so far.
 */
export function localDays(buckets: readonly ReportBucket[]): DayBucket[] {
  const days: DayBucket[] = [];
  for (const bucket of buckets) {
    const day = localDay(bucket.start);
    const last = days.at(-1);
    if (last !== undefined && last.day === day) {
      last.remaining = bucket.remaining;
      last.added += bucket.added;
      last.done += bucket.done;
    } else {
      days.push({
        day,
        start: bucket.start,
        remaining: bucket.remaining,
        added: bucket.added,
        done: bucket.done,
      });
    }
  }
  return days;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** A local day's labels: the axis's ("Mon 2") and the full one ("Mon 2 Nov"). */
export function dayLabels(day: string): { tick: string; label: string } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const tick = `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
  return { tick, label: `${tick} ${MONTHS[date.getMonth()]}` };
}

/** Rounds away the binary noise of `k × 0.1` and the like. */
const tidy = (n: number) => Number(n.toPrecision(12));

/**
 * Ticks for an axis from 0 to at least `max`: at most `intervals` steps of
 * 1, 2 or 5 times a power of ten. Whole numbers only unless `whole` is
 * false (a count is never 2.5). A `max` of 0 (or nothing to draw) still gets
 * an axis, `[0, 1]`, so an empty chart is drawn rather than divided by zero.
 */
export function niceTicks(
  max: number,
  { intervals = 5, whole = true }: { intervals?: number; whole?: boolean } = {},
): number[] {
  if (!Number.isFinite(max) || max <= 0) {
    return [0, 1];
  }
  const raw = max / intervals;
  const power = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  if (whole) {
    step = Math.max(1, Math.round(step));
  }
  const count = Math.max(1, Math.ceil(tidy(max / step)));
  return Array.from({ length: count + 1 }, (_, k) => tidy(k * step));
}
