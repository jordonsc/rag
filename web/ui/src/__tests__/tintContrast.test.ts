/**
 * The tinted controls' text contrast, at rest and on hover (rag-t0034).
 *
 * jsdom applies no CSS, so the colours are resolved here from the sheets
 * themselves: the tokens in `tokens.css`, the rules in `Button.module.css`, and
 * `color-mix(in srgb, …)` worked as the browser works it (a share of a colour
 * over `transparent` is that colour at that alpha, then laid over the ground).
 * Headless Chromium measured the same numbers on the tracker's rows.
 *
 * The grounds are every one a tinted control is drawn on while the pointer is
 * over it or at rest: the page, the panel, a plain or highlighted row's hover
 * (`--rag-surface2`, also the selected-row ground), and the in-progress row's
 * tint and its hover.
 */

import { componentCss, declarations, uiFile } from './cssRules';

type Rgba = [number, number, number, number];

/** `--rag-*` tokens, name to value as written. */
function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of declarations(uiFile('src/tokens.css'))) {
    if (d.property.startsWith('--rag-')) out[d.property] = d.value;
  }
  return out;
}

function hex(value: string): Rgba {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m === null) throw new Error(`not a hex colour: ${value}`);
  const n = m[1]!;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)).concat(1) as Rgba;
}

/** Split a `color-mix` argument list on its top-level commas. */
function args(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** A percentage, written or as a token. */
function share(text: string, t: Record<string, string>): number {
  const token = /^var\((--rag-[a-z0-9-]+)\)$/.exec(text);
  const value = token === null ? text : t[token[1]!];
  const m = /^(\d+(?:\.\d+)?)%$/.exec(value ?? '');
  if (m === null) throw new Error(`not a share this reader resolves: ${text}`);
  return Number(m[1]) / 100;
}

/** A colour value as the sheets write it, resolved to premultiplied-free RGBA. */
function colour(text: string, t: Record<string, string>): Rgba {
  const value = text.trim();
  if (value === 'transparent') return [0, 0, 0, 0];
  if (value.startsWith('#')) return hex(value);
  const token = /^var\((--rag-[a-z0-9-]+)\)$/.exec(value);
  if (token !== null) {
    const v = t[token[1]!];
    if (v === undefined) throw new Error(`no such token: ${token[1]}`);
    return colour(v, t);
  }
  const mix = /^color-mix\(in srgb,(.*)\)$/.exec(value);
  if (mix === null) throw new Error(`not a colour this reader resolves: ${value}`);
  const [a, b] = args(mix[1]!);
  const pa = /^(.*\))\s+(\S+)$/.exec(a!);
  if (pa === null || b === undefined)
    throw new Error(`a color-mix this reader cannot split: ${value}`);
  const p = share(pa[2]!, t);
  const [ca, cb] = [colour(pa[1]!, t), colour(b, t)];
  // CSS Color 5: mixed premultiplied, then un-premultiplied.
  const alpha = ca[3] * p + cb[3] * (1 - p);
  if (alpha === 0) return [0, 0, 0, 0];
  const ch = [0, 1, 2].map((i) => (ca[i]! * ca[3] * p + cb[i]! * cb[3] * (1 - p)) / alpha);
  return [ch[0]!, ch[1]!, ch[2]!, alpha];
}

/** `fg` laid over an opaque `ground`. */
function over(fg: Rgba, ground: Rgba): Rgba {
  return [0, 1, 2].map((i) => fg[i]! * fg[3] + ground[i]! * (1 - fg[3])).concat(1) as Rgba;
}

function contrast(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba) => {
    const [r, g, bl] = [0, 1, 2].map((i) => {
      const v = Math.round(c[i]!) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The declarations of the rule written exactly as `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const found = declarations(css).filter((d) => d.selector === selector);
  if (found.length === 0) throw new Error(`no rule "${selector}"`);
  return Object.fromEntries(found.map((d) => [d.property, d.value]));
}

const GROUNDS = [
  '--rag-bg',
  '--rag-surface',
  '--rag-surface2',
  '--rag-inprogress-row',
  '--rag-inprogress-row-hover',
];

const button = componentCss('Button.module.css');

describe.each([
  ['accent', '--rag-acc'],
  ['caution', '--rag-warn'],
  ['good', '--rag-good'],
])('the %s button', (variant, role) => {
  const t = tokens();
  const rest = rule(button, `.${variant}`);
  const hover = rule(button, `.${variant}:hover:not(:disabled)`);

  it('reads at 4.5:1 or better at rest, on every ground it is drawn on', () => {
    expect(rest.color).toBe(`var(${role})`);
    for (const g of GROUNDS) {
      const ground = colour(`var(${g})`, t);
      const fill = over(colour(rest.background!, t), ground);
      expect(contrast(colour(rest.color!, t), fill), g).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('reads at 4.5:1 or better under the pointer, on every ground it is drawn on (rag-t0034)', () => {
    for (const g of GROUNDS) {
      const ground = colour(`var(${g})`, t);
      const fill = over(colour(hover.background!, t), ground);
      expect(contrast(colour(hover.color!, t), fill), g).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('still lifts on hover: a deeper fill, and the text paler in its own hue', () => {
    const shareOf = (value: string) =>
      share(
        args(/^color-mix\(in srgb,(.*)\)$/.exec(value)![1]!)[0]!
          .split(/\s+/)
          .pop()!,
        t,
      );
    expect(shareOf(hover.background!)).toBeGreaterThan(shareOf(rest.background!));
    expect(hover.color).toBe(
      `color-mix(in srgb, var(--rag-bright) var(--rag-tint-lift), var(${role}))`,
    );
    // A subtle lift, not a new colour: most of the hover text is still the role.
    expect(share('var(--rag-tint-lift)', t)).toBeGreaterThan(0);
    expect(share('var(--rag-tint-lift)', t)).toBeLessThanOrEqual(0.5);
  });
});

describe.each([
  ['accent', '--rag-acc'],
  ['caution', '--rag-warn'],
])('the %s button, unlifted', (variant, role) => {
  it('would fail without the lifted text: the deeper fill alone is under 4.5:1 on a row’s hover', () => {
    const t = tokens();
    const hover = rule(button, `.${variant}:hover:not(:disabled)`);
    const fill = over(colour(hover.background!, t), colour('var(--rag-inprogress-row-hover)', t));
    expect(contrast(colour(`var(${role})`, t), fill)).toBeLessThan(4.5);
  });
});

describe('the tint tokens', () => {
  it('are shares, used by name rather than written into the rules', () => {
    const t = tokens();
    for (const name of [
      '--rag-tint-acc',
      '--rag-tint-acc-hover',
      '--rag-tint-warn',
      '--rag-tint-warn-hover',
      '--rag-tint-good',
      '--rag-tint-good-hover',
      '--rag-tint-lift',
    ]) {
      expect(t[name], name).toMatch(/^\d+%$/);
    }
    // No tinted button writes its share as a number any more.
    for (const d of declarations(button)) {
      if (/^\.(accent|caution|good)/.test(d.selector) && d.property === 'background') {
        expect(d.value, d.selector).toMatch(/var\(--rag-tint-/);
      }
    }
  });
});
