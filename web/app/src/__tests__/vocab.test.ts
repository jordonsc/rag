/**
 * The ledger's display vocabulary, tested for the promise it makes rather than
 * for the labels it happens to hold.
 *
 * The promise is the interesting part: **an unknown value comes back as
 * itself**, never coerced onto a default. A status this build has not heard of
 * is a fact worth seeing, and drawing it as `open` would state something nobody
 * claimed.
 */

import {
  defaultStatus,
  kindIcon,
  kindLabel,
  relIcon,
  relLabel,
  statusLabel,
  statusTone,
  typeIcon,
  typeLabel,
} from '../ledger/vocab';
import {
  docKindIcon,
  docKindLabel,
  eventKindIcon,
  eventKindLabel,
  FROZEN_STATUSES,
  offeredStatuses,
  phaseStateLabel,
  phaseStateTone,
} from '../tracker/vocab';

describe('the display tables', () => {
  it('draws the vocabulary it knows', () => {
    expect(typeLabel('decision')).toBe('Decision');
    expect(statusLabel('wontfix')).toBe("Won't fix");
    expect(kindLabel('state_change')).toBe('State change');
    expect(relLabel('superseded_by')).toBe('Superseded by');
    expect(statusTone('reverted')).toBe('crit');
    expect(defaultStatus('decision')).toBe('proposed');
    expect(defaultStatus('incident')).toBe('open');
  });

  it('returns an unheard-of value as itself rather than as a default', () => {
    expect(typeLabel('postmortem')).toBe('postmortem');
    expect(statusLabel('mothballed')).toBe('mothballed');
    expect(statusTone('mothballed')).toBe('neutral');
  });

  /**
   * **The tables are read by own property, not by index.** A plain index reads
   * through the prototype chain, so `'constructor'`, `'toString'` and
   * `'valueOf'` come back as inherited *functions* — non-`undefined`, and
   * neither a label nor the value itself, which is the one thing the contract
   * above promises.
   *
   * Unreachable today: every value reaching these tables was derived from a
   * Rust enum on the way out of the server. It is asserted because a stated
   * contract the code does not keep is a lie waiting for the day the values
   * stop being enum-derived — a free-text `kind`, a tag rendered through the
   * same helper.
   */
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'does not answer %j out of the prototype chain',
    (inherited) => {
      expect(typeLabel(inherited)).toBe(inherited);
      expect(statusLabel(inherited)).toBe(inherited);
      expect(kindLabel(inherited)).toBe(inherited);
      expect(relLabel(inherited)).toBe(inherited);
      // The icon helpers fall back to a named glyph, which must be that glyph
      // and not a function borrowed off `Object.prototype`.
      expect(typeIcon(inherited)).toBe('circle-dot');
      expect(kindIcon(inherited)).toBe('file-text');
      expect(relIcon(inherited)).toBe('link');
      expect(statusTone(inherited)).toBe('neutral');
    },
  );
});

describe('the roadmap’s words (spec:roadmap RM-40 to RM-49)', () => {
  it('names a release and a recall as a phase’s, never a build’s', () => {
    expect(eventKindLabel('release')).toBe('Phase released');
    expect(eventKindLabel('recall')).toBe('Phase recalled');
    expect(eventKindIcon('release')).toBe('rocket');
    expect(eventKindIcon('recall')).toBe('rotate-ccw');
  });

  it('words a phase’s state, an unknown one as itself', () => {
    expect(phaseStateLabel('planned')).toBe('Planned');
    expect(phaseStateLabel('released')).toBe('Released');
    expect(phaseStateLabel('archived')).toBe('Archived');
    expect(phaseStateLabel('mothballed')).toBe('mothballed');
    expect(phaseStateTone('mothballed')).toBe('neutral');
    expect(phaseStateLabel('constructor')).toBe('constructor');
  });

  it('names a phase search hit', () => {
    expect(docKindLabel('phase')).toBe('Phase');
    expect(docKindIcon('phase')).toBe('map');
  });

  it('offers a frozen ticket only done and cancelled, whatever its status says', () => {
    expect(FROZEN_STATUSES).toEqual(['done', 'cancelled']);
    expect(offeredStatuses({ status: 'pending', frozen: true })).toEqual(['done', 'cancelled']);
    expect(offeredStatuses({ status: 'pending', frozen: false })).toContain('deferred');
    expect(offeredStatuses({ status: 'pending' })).toContain('in_progress');
  });
});
