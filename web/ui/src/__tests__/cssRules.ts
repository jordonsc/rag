/**
 * The design system's stylesheets, read as declarations.
 *
 * jsdom applies no CSS, so a rule like *"a table must fit its container"* is
 * unanswerable by rendering: every box in jsdom is zero wide, and
 * `scrollWidth <= clientWidth` is `0 <= 0` against any stylesheet whatsoever —
 * including one that has just broken the rule. Real widths belong in a real
 * browser. What is answerable here is the **rule**, which is the thing a later
 * change breaks silently.
 *
 * **Anything it cannot account for throws rather than being skipped.** A parser
 * that quietly drops what it does not understand hands its callers a *shorter
 * list*, and every "no rule does X" assertion over that list then passes for
 * the wrong reason — the worst failure a guard can have, because it buys
 * confidence. Comment stripping is the sharpest case: `Table.module.css`
 * discusses `overflow-x: auto` in prose at length, so a reader that took
 * comments for CSS would report the very declaration the sheet forbids.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** One `property: value` pair, with the selector it was found under. */
export interface Declaration {
  /**
   * The selector, prefixed by any at-rule it sits inside — `@media (…) .wrap`.
   * Kept as written, so an assertion can name a rule the way the sheet does.
   */
  selector: string;
  /** Lower-cased property name. */
  property: string;
  /** The value as written, whitespace-collapsed. */
  value: string;
}

/** A component stylesheet from `src/components`, read from disk. */
export function componentCss(file: string): string {
  return readFileSync(resolve(process.cwd(), 'src/components', file), 'utf8');
}

/**
 * Strip comments.
 *
 * Load-bearing rather than cosmetic — see this file's header. An unterminated
 * comment throws: it would otherwise swallow the rest of the sheet, and a guard
 * reading half a stylesheet reports every absence it was asked about.
 */
function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('/*', i);
    if (open < 0) return out + css.slice(i);
    out += css.slice(i, open);
    const close = css.indexOf('*/', open + 2);
    if (close < 0) {
      throw new Error('unterminated comment: the rest of the sheet would be invisible');
    }
    i = close + 2;
  }
  return out;
}

/** The index of the `}` matching the `{` at `open`. */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces: no "}" closes the block at ${open}`);
}

/** The declarations of one rule body. */
function readBody(body: string, selector: string, out: Declaration[]): void {
  if (body.includes('{')) {
    throw new Error(`nested rule inside "${selector}": this reader does not resolve CSS nesting`);
  }
  for (const piece of body.split(';')) {
    const text = piece.trim();
    if (text === '') continue;
    const colon = text.indexOf(':');
    if (colon < 0) {
      throw new Error(`not a declaration in "${selector}": ${text}`);
    }
    out.push({
      selector,
      property: text.slice(0, colon).trim().toLowerCase(),
      value: text
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, ' '),
    });
  }
}

function walk(css: string, prefix: string, out: Declaration[]): void {
  let head = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '}') {
      throw new Error(`unbalanced braces: a "}" closes nothing at ${i}`);
    }
    if (c !== '{') {
      head += c;
      i++;
      continue;
    }
    const selector = head.trim().replace(/\s+/g, ' ');
    head = '';
    const close = matchBrace(css, i);
    const body = css.slice(i + 1, close);
    if (selector.startsWith('@')) {
      // `@media` and `@supports` hold rules, and `@keyframes` holds rule-shaped
      // blocks whose "selector" is a keyframe offset (`from`, `50%`). All three
      // are walked, because all three carry declarations that reach an element:
      // an animation stepping a `min-width` is exactly the kind of width an
      // audit over this reader exists to see.
      //
      // `@font-face` is the other shape — declarations with no selector at all
      // — so it is read as a body rather than walked as a list.
      //
      // Every *other* at-rule throws. That is the point of the list being
      // short: the next unaccounted construct should cost somebody five minutes
      // and a decision, not pass as an empty contribution to an
      // absence-assertion.
      const name = selector.split(/[\s(]/)[0]!.toLowerCase();
      if (name === '@font-face') {
        readBody(body, prefix === '' ? selector : `${prefix} ${selector}`, out);
        i = close + 1;
        continue;
      }
      if (name !== '@media' && name !== '@supports' && !name.endsWith('keyframes')) {
        throw new Error(`${name} is not a rule list: this reader does not account for it`);
      }
      walk(body, prefix === '' ? selector : `${prefix} ${selector}`, out);
    } else {
      readBody(body, prefix === '' ? selector : `${prefix} ${selector}`, out);
    }
    i = close + 1;
  }
  if (head.trim() !== '') {
    throw new Error(`text outside any rule: ${head.trim()}`);
  }
}

/**
 * Every declaration in a stylesheet, in source order, at-rules included.
 *
 * Throws on anything it cannot account for. See the header: a reader that
 * skips is a reader whose callers' absence-assertions are worthless.
 */
export function declarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  walk(stripComments(css), '', out);
  return out;
}

/**
 * A length in `px`, for comparing one floor against another.
 *
 * `rem` is resolved at the browser default of 16px — nothing here sets a root
 * font size — and anything else throws, because a floor this reader silently
 * mis-read is a floor the guard above it cannot see.
 */
export function lengthPx(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
  if (match === null) {
    throw new Error(`not a length this reader resolves: ${value}`);
  }
  const size = Number(match[1]);
  return match[2] === 'rem' ? size * 16 : size;
}

/** Any file in this package, read by its path relative to the package root. */
export function uiFile(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), 'utf8');
}

/**
 * The stylesheets whose classes reach a rendered table, by file name.
 *
 * `Table.module.css` composes from `rows.module.css`, so a width introduced in
 * either lands on the same element — and the rule being audited is a property
 * of the rendered table, not of one file. Read each with {@link componentCss}.
 */
export function tableStylesheets(): string[] {
  return ['Table.module.css', 'rows.module.css'];
}

/**
 * The unshrinkable floor a `min-width` value states, in px.
 *
 * `min(<length>, 100%)` is bounded by its container and therefore states no
 * floor at all — but the length inside it is still resolved, so a unit this
 * reader cannot parse throws rather than passing as a zero.
 */
export function minWidthFloorPx(value: string): number {
  const text = value.trim();
  if (text === '0') return 0;
  const bounded = /^min\(\s*([^,]+?)\s*,\s*100%\s*\)$/.exec(text);
  if (bounded !== null) {
    lengthPx(bounded[1]!);
    return 0;
  }
  const ch = /^(-?\d+(?:\.\d+)?)ch$/.exec(text);
  if (ch !== null) return Number(ch[1]) * 16;
  return lengthPx(text);
}
