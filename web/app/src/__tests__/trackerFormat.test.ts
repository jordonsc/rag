/**
 * The velocity figures' wording of lengths of time (owner request rag-t0062).
 *
 * What it defends: the owner's rule, one decimal below 5 and a whole number
 * from 5, a decimal that rounds whole reading whole, half away from zero; the
 * unit moving up once the value is over one and a half of the next (90
 * minutes, 36 hours, 10.5 days, 1.5 months of 365.25 ÷ 12 days), the
 * boundaries themselves staying in the smaller unit; singular for exactly
 * one; "<0.1" for something that rounds to nothing; the ETA from hours up,
 * "done" and "—"; and the report's lengths from minutes up.
 *
 * **The same cases as the MCP's** `the_eta_moves_up_a_unit_past_one_and_a_half_of_it`
 * and `a_length_moves_up_from_minutes_by_the_same_rule`
 * (`crates/mcp/src/tracker/tests.rs`): the `tracker_queue` line and the
 * widget word the ETA alike, so a case changed here is changed there.
 */

import {
  durationParts,
  etaParts,
  formatAmount,
  formatElapsed,
  formatEta,
  joinParts,
} from '../tracker/velocity';

describe('an amount', () => {
  it('has one decimal below 5 and none from 5, a whole decimal reading whole', () => {
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(1)).toBe('1');
    expect(formatAmount(1.04)).toBe('1');
    expect(formatAmount(1.6)).toBe('1.6');
    expect(formatAmount(2.25)).toBe('2.3');
    expect(formatAmount(4.94)).toBe('4.9');
    expect(formatAmount(4.96)).toBe('5');
    expect(formatAmount(5.4)).toBe('5');
    expect(formatAmount(10.5)).toBe('11');
  });
});

describe('the ETA', () => {
  it('reads the owner’s examples (and 16 days as the rule has it)', () => {
    expect(formatEta(32 / 24)).toBe('32 hours');
    expect(formatEta(1.6)).toBe('1.6 days');
    expect(formatEta(11.2)).toBe('1.6 weeks');
    expect(formatEta(42)).toBe('6 weeks');
    expect(formatEta(140)).toBe('4.6 months');
    // "16 days" contradicts the rule: over 1.5 weeks is weeks.
    expect(formatEta(16)).toBe('2.3 weeks');
  });

  it('moves up a unit only past one and a half of it', () => {
    expect(formatEta(1.5)).toBe('36 hours');
    expect(formatEta(1.51)).toBe('1.5 days');
    expect(formatEta(10.5)).toBe('11 days');
    expect(formatEta(10.6)).toBe('1.5 weeks');
    expect(formatEta((1.5 * 365.25) / 12)).toBe('7 weeks');
    expect(formatEta(46)).toBe('1.5 months');
    expect(formatEta(200)).toBe('7 months');
  });

  it('rounds as the owner’s rule does', () => {
    expect(formatEta(4.94)).toBe('4.9 days');
    expect(formatEta(4.96)).toBe('5 days');
    expect(formatEta(7)).toBe('7 days');
    expect(formatEta(3)).toBe('3 days');
    expect(formatEta(2.25 / 24)).toBe('2.3 hours');
  });

  it('is singular for one, in hours at the least, and “<0.1” for a sliver', () => {
    expect(formatEta(1 / 24)).toBe('1 hour');
    expect(formatEta(2 / 24)).toBe('2 hours');
    expect(formatEta(1 / 48)).toBe('0.5 hours');
    expect(formatEta(0.001)).toBe('<0.1 hours');
  });

  it('says “done” with nothing remaining and “—” (read “unknown”) when unknown', () => {
    expect(formatEta(0)).toBe('done');
    expect(formatEta(null)).toBe('—');
    expect(etaParts(null)).toEqual({ value: '—', unit: '', spoken: 'unknown' });
    expect(etaParts(1.6)).toEqual({ value: '1.6', unit: 'days' });
  });
});

describe('a length in the report', () => {
  it('moves up from minutes by the same rule', () => {
    expect(formatElapsed(0)).toBe('0 minutes');
    expect(formatElapsed(2)).toBe('<0.1 minutes');
    expect(formatElapsed(20)).toBe('0.3 minutes');
    expect(formatElapsed(60)).toBe('1 minute');
    expect(formatElapsed(42 * 60)).toBe('42 minutes');
    expect(formatElapsed(3_600)).toBe('60 minutes');
    expect(formatElapsed(90 * 60)).toBe('90 minutes');
    expect(formatElapsed(91 * 60)).toBe('1.5 hours');
    expect(formatElapsed(6_840)).toBe('1.9 hours');
    expect(formatElapsed(2.5 * 3_600)).toBe('2.5 hours');
    expect(formatElapsed(32 * 3_600)).toBe('32 hours');
    expect(formatElapsed(47 * 3_600)).toBe('2 days');
    expect(formatElapsed(5.2 * 86_400)).toBe('5 days');
    expect(formatElapsed(12.3 * 86_400)).toBe('1.8 weeks');
  });

  it('keeps the value and its unit apart for a tile', () => {
    expect(durationParts(6_840)).toEqual({ value: '1.9', unit: 'hours' });
    expect(durationParts(60)).toEqual({ value: '1', unit: 'minute' });
    expect(joinParts({ value: '8', unit: '/day' })).toBe('8/day');
    expect(joinParts({ value: 'done', unit: '' })).toBe('done');
  });
});
