// The segmented track ends at its last button.
//
// **This file is evidence about the stylesheet, not about the glass, and it
// says so out loud.** jsdom applies no CSS and computes no layout: it can be
// asked what a rule *declares* and never what a box *is*. So nothing here
// proves the track is the right width on screen — what it does is stop the one
// declaration that makes it so being tidied away as redundant, which is a real
// risk on a rule that reads like a no-op beside an `inline-flex`.
//
// The failure it guards against: `.segmented` sits inside `form.module.css`'s
// `.field`, a flex *column*, whose default `align-items: stretch` sizes it
// across the field's whole measure — so the track's background runs the width
// of the row instead of ending at its last button.
//
// The sheet is read through `cssRules.ts`, which strips comments before it
// parses. That is load-bearing here rather than tidy: these stylesheets discuss
// properties in prose at length, and a reader that took a comment for CSS would
// report declarations the sheet does not make.

import { describe, expect, it } from 'vitest';
import { componentCss, declarations } from './cssRules';

/** Every declaration under exactly `selector` in `inputs.module.css`. */
function ruleFor(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of declarations(componentCss('inputs.module.css'))) {
    if (rule.selector === selector) {
      found.set(rule.property, rule.value);
    }
  }
  expect(found.size, `no rule reads ${selector}`).toBeGreaterThan(0);
  return found;
}

const segmented = () => ruleFor('.segmented');

describe('.segmented', () => {
  it('refuses the stretch its flex-column parent would otherwise apply', () => {
    const rule = segmented();
    // `.field` is `flex-direction: column`, so its cross axis is the one a
    // reader sees as width, and `align-items: stretch` is the default. This is
    // the declaration that opts out of it.
    expect(rule.get('align-self')).toBe('start');
    // Named for a grid parent as well, because this package exports the
    // control and does not get to assume which layout the caller used.
    expect(rule.get('justify-self')).toBe('start');

    // The paired positive control: the two above are only meaningful while the
    // track is a shrink-to-fit box in the first place. If `display` ever became
    // `flex`, both would be inert and this file would pass while guarding
    // nothing.
    expect(rule.get('display')).toBe('inline-flex');
    // And the cap that keeps the shrink-to-fit safe at a narrow width.
    expect(rule.get('max-width')).toBe('100%');
  });

  it('declares nothing that would give the track a width of its own', () => {
    // **A presence guard is not a property guard, and the assertions above are
    // presence.** They say the two opt-outs are still written; they say nothing
    // about what else is. Adding `width: 100%` to this rule reproduces the
    // defect exactly — a track whose background runs the width of the row —
    // and leaves every one of them green, because `align-self` cannot shrink a
    // box that has been given a definite width.
    //
    // So the guard is stated as the property instead: **this rule contributes
    // no width and no growth.** `max-width` is deliberately absent from the
    // list — it is a cap, and it forces nothing.
    const STRETCHING = ['width', 'min-width', 'flex', 'flex-grow', 'flex-basis', 'inline-size'];
    const rule = segmented();
    for (const property of STRETCHING) {
      expect(
        rule.has(property),
        `.segmented declares ${property}: ${rule.get(property)} — which gives the track a ` +
          'width of its own, and the shrink-to-fit that ends it at its last button is gone',
      ).toBe(false);
    }

    // The paired positive control, over the *list* rather than over one entry:
    // a reader of `.segmented` that returned nothing would satisfy every line
    // above. These are the declarations the rule is known to carry.
    expect([...rule.keys()].sort()).toContain('align-self');
    expect(rule.size).toBeGreaterThanOrEqual(4);
  });

  it('leaves only its own padding after the last button', () => {
    // An `inline-flex` track with a 2px padding, so the space after the last
    // button is the padding and the border and nothing else.
    expect(segmented().get('padding')).toBe('2px');
  });
});
