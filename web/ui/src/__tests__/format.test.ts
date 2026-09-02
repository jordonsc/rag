// The locale-aware formatters a surface presents values through.
//
// These assertions hold the *shape* of a formatted value: the separator, how
// many units a duration shows, and which small cases are phrases rather than
// numbers. They run against the platform's `Intl`, which is the point — a
// second locale table is what this layer exists not to be.

import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationSeconds, formatNumber, formatStamp } from '../i18n/format';

describe('quantities', () => {
  it('groups thousands the way the locale does', () => {
    expect(formatNumber(451234)).toBe('451,234');
    expect(formatNumber(8192)).toBe('8,192');
    // The separator is the locale's, not a hard-coded comma.
    expect(formatNumber(8192, 'de-DE')).toBe('8.192');
  });

  it('leaves a value below a thousand alone', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(-42)).toBe('-42');
  });

  it('keeps a reading rather than rounding it to three places', () => {
    expect(formatNumber(21.5)).toBe('21.5');
    expect(formatNumber(3.1415927)).toBe('3.141593');
    // Past six places is floating-point noise, not precision.
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
  });

  it('states a non-finite value as itself rather than as a symbol', () => {
    expect(formatNumber(Number.NaN)).toBe('NaN');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('durations', () => {
  it('shows a long uptime as two units, largest first', () => {
    expect(formatDurationSeconds(451234)).toBe('5d 5h');
  });

  it('omits the second unit when it is zero, and never skips past it', () => {
    expect(formatDurationSeconds(86400)).toBe('1d');
    // 5 days and 20 minutes is "5d", not "5d 20m": the leading unit has
    // already ruled out that precision.
    expect(formatDurationSeconds(86400 * 5 + 1200)).toBe('5d');
  });

  it('handles the small cases', () => {
    expect(formatDurationSeconds(3661)).toBe('1h 1m');
    expect(formatDurationSeconds(61)).toBe('1m 1s');
    expect(formatDurationSeconds(45)).toBe('45s');
    expect(formatDurationSeconds(1)).toBe('1s');
    // Under a second is a phrase: zero is the one reading that is wrong.
    expect(formatDurationSeconds(0)).toBe('Less than a second');
    expect(formatDuration(400)).toBe('Less than a second');
    expect(formatDuration(400, 'en-GB', { moment: 'Just now' })).toBe('Just now');
  });

  it('takes milliseconds as milliseconds', () => {
    expect(formatDuration(451234000)).toBe('5d 5h');
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('does not lose the sign of a negative length', () => {
    expect(formatDurationSeconds(-3661)).toBe('-1h 1m');
  });
});

describe('the timestamp', () => {
  /** A local wall-clock instant, so the case does not depend on the box's zone. */
  const at = new Date(2026, 7, 17, 14, 5, 30);

  it('states a date and a 24-hour clock', () => {
    expect(formatStamp(at)).toBe('17 Aug 2026, 14:05');
  });

  it('stays on a 24-hour cycle whatever the locale prefers', () => {
    // Two people's screenshots of one record must not disagree about whether
    // 14:05 is the afternoon.
    expect(formatStamp(at, 'en-US')).toContain('14:05');
  });

  it('takes an ISO string as well as a Date', () => {
    expect(formatStamp(at.toISOString())).toBe(formatStamp(at));
  });

  it('states an unparseable instant as itself rather than as a date', () => {
    expect(formatStamp('not a date')).toBe('not a date');
  });
});
