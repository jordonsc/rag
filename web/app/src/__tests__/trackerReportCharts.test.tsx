/**
 * The report's arithmetic and charts (spec:velocity m03, VL-12).
 *
 * What it defends: hourly UTC buckets summed into the reader's local days
 * across a UTC day boundary, with the time zone pinned (Melbourne, where
 * local midnight falls at 13:00 UTC in November); the days' and hours'
 * labels; "nice" whole-number ticks for 0, 7, 48 and 1 000, and fractional
 * ones for an hours axis; each chart's hidden table carrying its numbers,
 * and each mark its `<title>`; and an all-zero series drawing an empty chart
 * with its axis, never NaN. A length's wording is `trackerFormat.test.ts`'s.
 */

import { render, screen, within } from '@testing-library/react';

import { BurnDown, RangeBars, type BurnPoint, type RangeRow } from '../tracker/charts';
import { dayLabels, hourLabels, localDay, localDays, niceTicks } from '../tracker/reportMath';
import type { ReportBucket } from '../tracker/types';
import { formatElapsed } from '../tracker/velocity';

beforeAll(() => {
  vi.stubEnv('TZ', 'Australia/Melbourne');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function bucket(start: string, remaining: number, added: number, done: number): ReportBucket {
  return { start, remaining, added, done };
}

describe('local days', () => {
  it('runs in Melbourne, an eleven-hour lead on UTC in November', () => {
    expect(new Date('2026-11-01T13:00:00Z').getHours()).toBe(0);
    expect(localDay('2026-11-01T12:59:59Z')).toBe('2026-11-01');
    expect(localDay('2026-11-01T13:00:00Z')).toBe('2026-11-02');
  });

  it('sums the hours of each local day across a UTC day boundary', () => {
    // One UTC day (1 November, 10:00 to 15:00), two Melbourne ones.
    const hours = [
      bucket('2026-11-01T10:00:00Z', 5, 1, 0),
      bucket('2026-11-01T11:00:00Z', 6, 0, 1),
      bucket('2026-11-01T12:00:00Z', 7, 2, 0),
      bucket('2026-11-01T13:00:00Z', 8, 0, 1),
      bucket('2026-11-01T14:00:00Z', 9, 0, 1),
      bucket('2026-11-01T15:00:00Z', 10, 3, 0),
    ];
    expect(localDays(hours)).toEqual([
      { day: '2026-11-01', start: '2026-11-01T10:00:00Z', remaining: 7, added: 3, done: 1 },
      { day: '2026-11-02', start: '2026-11-01T13:00:00Z', remaining: 10, added: 3, done: 2 },
    ]);
    expect(localDays([])).toEqual([]);
  });

  it('labels a day and an hour in local time', () => {
    expect(dayLabels('2026-11-02')).toEqual({ tick: 'Mon 2', label: 'Mon 2 Nov' });
    // Melbourne's midnight carries a tick; one o’clock does not, by default.
    expect(hourLabels('2026-11-01T13:00:00Z')).toEqual({
      tick: '00:00',
      label: 'Mon 2 Nov, 00:00',
    });
    expect(hourLabels('2026-11-01T14:00:00Z')).toEqual({ tick: '', label: 'Mon 2 Nov, 01:00' });
    expect(hourLabels('2026-11-01T14:00:00Z', 1).tick).toBe('01:00');
    // A partial first hour is labelled by its own start, and has no tick.
    expect(hourLabels('2026-11-01T13:34:56Z')).toEqual({ tick: '', label: 'Mon 2 Nov, 00:34' });
  });
});

describe('ticks', () => {
  it('gives whole numbers from 0 to at least the top, in at most five steps', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(48)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(1_000)).toEqual([0, 200, 400, 600, 800, 1_000]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });

  it('gives fractions when asked, for an hours axis', () => {
    expect(niceTicks(0.37, { whole: false })).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(7, { whole: false })).toEqual([0, 2, 4, 6, 8]);
  });
});

/** The text of every `<title>` in the chart. */
function titles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('title')].map((t) => t.textContent ?? '');
}

/** The cells of the hidden table's row for `name`. */
function row(table: HTMLElement, name: string): string[] {
  const header = within(table).getByRole('rowheader', { name });
  return [...header.closest('tr')!.querySelectorAll('td')].map((td) => td.textContent ?? '');
}

const POINTS: BurnPoint[] = [
  { key: 'a', label: 'Mon 2 Nov', tick: 'Mon 2', remaining: 12, added: 3, done: 1 },
  { key: 'b', label: 'Tue 3 Nov', tick: 'Tue 3', remaining: 10, added: 0, done: 2 },
  { key: 'c', label: 'Wed 4 Nov', tick: 'Wed 4', remaining: 11, added: 1, done: 0 },
];

describe('the burn-down', () => {
  it('carries its numbers in a hidden table and on each mark', () => {
    const { container } = render(<BurnDown points={POINTS} caption="Burn-down" period="Day" />);
    const table = screen.getByRole('table', { name: 'Burn-down' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Day', 'Remaining at its end', 'Added', 'Done']);
    expect(row(table, 'Mon 2 Nov')).toEqual(['12', '3', '1']);
    expect(row(table, 'Tue 3 Nov')).toEqual(['10', '0', '2']);
    expect(row(table, 'Wed 4 Nov')).toEqual(['11', '1', '0']);

    expect(titles(container)).toEqual(
      expect.arrayContaining([
        'Mon 2 Nov: 3 added',
        'Mon 2 Nov: 1 done',
        'Tue 3 Nov: 2 done',
        'Wed 4 Nov: 1 added',
        'Mon 2 Nov: 12 remaining, 3 added, 1 done',
        'Tue 3 Nov: 10 remaining, 0 added, 2 done',
      ]),
    );
    // No bar is drawn for a zero: three added and done marks, three points.
    expect(container.querySelectorAll('rect')).toHaveLength(4);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+ L/);
    // The axis: 0 to 15 in fives, past the top of 12, and the days' labels.
    const axis = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(axis).toEqual(expect.arrayContaining(['0', '5', '10', '15', 'Mon 2', 'Wed 4']));
    expect(screen.getByRole('img', { name: /^Burn-down\./ })).toBeInTheDocument();
  });

  it('draws an all-zero series as an empty chart with its axis, not NaN', () => {
    const zeros = POINTS.map((p) => ({ ...p, remaining: 0, added: 0, done: 0 }));
    const { container } = render(<BurnDown points={zeros} caption="Burn-down" period="Day" />);
    expect(container.innerHTML).not.toContain('NaN');
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    const axis = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(axis).toEqual(expect.arrayContaining(['0', '1', 'Mon 2']));
    expect(row(screen.getByRole('table', { name: 'Burn-down' }), 'Mon 2 Nov')).toEqual([
      '0',
      '0',
      '0',
    ]);
  });
});

const ROWS: RangeRow[] = [
  { key: 'pending', label: 'Pending', count: 4, mean: 3 * 3_600, median: 9_000, p90: 6 * 3_600 },
  { key: 'review', label: 'Review', count: 0, mean: null, median: null, p90: null },
  { key: 'blocked', label: 'Blocked', count: 1, mean: 1_800, median: 1_800, p90: 1_800 },
];

describe('time in each state', () => {
  it('carries its numbers in a hidden table and on each mark', () => {
    const { container } = render(
      <RangeBars rows={ROWS} caption="Time in each state" format={formatElapsed} />,
    );
    const table = screen.getByRole('table', { name: 'Time in each state' });
    expect(row(table, 'Pending')).toEqual(['4', '3 hours', '2.5 hours', '6 hours']);
    expect(row(table, 'Review')).toEqual(['0', '—', '—', '—']);
    expect(row(table, 'Blocked')).toEqual(['1', '30 minutes', '30 minutes', '30 minutes']);
    expect(titles(container)).toEqual([
      'Pending: mean 3 hours, over 4',
      'Pending: median 2.5 hours',
      'Pending: 90th percentile 6 hours',
      'Blocked: mean 30 minutes, over 1',
      'Blocked: median 30 minutes',
      'Blocked: 90th percentile 30 minutes',
    ]);
    // A bar each for the two with lengths; the count beside every row.
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    const text = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(text).toEqual(
      expect.arrayContaining(['Pending', '4 ended', 'none ended', '1 ended', '0 h', '6 h']),
    );
  });

  it('draws rows with nothing ended as an empty chart with its axis, not NaN', () => {
    const empty = ROWS.map((r) => ({ ...r, count: 0, mean: null, median: null, p90: null }));
    const { container } = render(
      <RangeBars rows={empty} caption="Time in each state" format={formatElapsed} />,
    );
    expect(container.innerHTML).not.toContain('NaN');
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    const text = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(text).toEqual(expect.arrayContaining(['0 h', '1 h', 'none ended']));
  });
});
