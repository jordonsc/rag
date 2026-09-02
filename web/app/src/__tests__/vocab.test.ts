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
