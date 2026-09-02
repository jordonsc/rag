// `Panel`'s `stickyHeader` — a panel does not leave its own name off screen.
//
// **What is being guarded.** A tall form puts its submit button hundreds of
// pixels below the heading that says which form it is, so there is no scroll
// position in which the two are visible together. This is the moment *before*
// the click: the controls are being filled in and the panel they belong to has
// scrolled away.
//
// **What jsdom can and cannot say, stated plainly rather than implied.** jsdom
// performs no layout: it computes no sticky position, no scroll container and
// no overflow, so *nothing here proves the header actually stays on the glass*.
// What these tests do prove is everything that decides whether it can:
//
// 1. the panels that ask for the behaviour and the panels that do not — the
//    inertness half, which is what keeps this from becoming a visual change to
//    every page;
// 2. that the panel is not left as its own scroll container, which is the one
//    mistake that would leave a rule running, passing review and doing nothing
//    (see the note in `surfaces.module.css`);
// 3. that no length, breakpoint or viewport unit decides any of it.
//
// The remaining half is owed to a look at a real browser at more than one
// window size: a panel taller than its pane must keep its heading on screen,
// and — the negative, which matters as much — a panel shorter than its pane
// must be pixel-identical to what it draws today.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Panel } from '../components/surfaces';

/** The body of the rule whose selector is exactly `selector`. */
function ruleFor(selector: string): string {
  const css = readFileSync(resolve(process.cwd(), 'src/components/surfaces.module.css'), 'utf8');
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open)).trim();
}

/** The panel element of whatever was just rendered. */
function panel(): HTMLElement {
  const section = screen.getByText('Details').closest('section');
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

describe('a panel that keeps its own heading on screen', () => {
  it('marks the panel and its header when it is asked for', () => {
    render(
      <Panel header="Details" stickyHeader>
        <p>Body content</p>
      </Panel>,
    );

    expect(panel()).toHaveClass('panelFollows');
    expect(panel().querySelector('header')).toHaveClass('panelHeaderFollows');
  });

  // The half that stops this being a visual regression on every page. A panel
  // that did not ask must be the panel it was yesterday —
  // asserted as the exact class list rather than as the absence of one name,
  // because "does not carry `panelFollows`" would still pass if the modifier
  // arrived under a different name.
  it('changes nothing at all for a panel that did not ask', () => {
    render(
      <Panel header="Details">
        <p>Body content</p>
      </Panel>,
    );

    expect(panel().className).toBe('panel');
    expect(panel().querySelector('header')!.className).toBe('panelHeader');
  });

  // The mistake that would leave the rule running and doing nothing. An
  // `overflow: hidden` box is a scroll container with no scrollbar, so a sticky
  // header inside one pins to a box that never scrolls. Only the source can be
  // asked this: jsdom resolves no scrollport at all.
  it('does not leave the panel as its own scroll container', () => {
    expect(ruleFor('.panel.panelFollows')).toContain('overflow: clip');
    expect(ruleFor('.panel.panelFollows')).not.toContain('overflow: hidden');
    // And the plain panel keeps the clipping it has always had, so this is a
    // property of the opt-in and not a change to every panel.
    expect(ruleFor('.panel')).toContain('overflow: hidden');
  });

  it('pins the header rather than merely offsetting it, and paints over the body', () => {
    const rule = ruleFor('.panelHeaderFollows');
    expect(rule).toContain('position: sticky');
    // `top` is a variable so that a second sticky bar above these headers can
    // set an offset on its own column. **The fallback is the assertion**: a
    // panel with nothing pinned above it inherits no offset, resolves to `0`
    // and is the panel it was. Whatever pins above a panel first owes its own
    // assertions — that only one place in the tree sets the offset, and that
    // its height is derived rather than measured; this file holds the
    // fallback.
    expect(rule).toMatch(/top: var\(--rag-sticky-offset, 0\)/);
    // Without this the form's controls slide over the header they are meant to
    // slide under, and the panel's name is on screen and unreadable.
    expect(rule).toMatch(/z-index:/);
  });

  // No pixel threshold is introduced: the panel's own box decides, which is
  // what makes the same rule right in a narrow window and a full one alike. A
  // measured height would be right at the size it was measured at and nowhere
  // else.
  it('consults no viewport width and no length threshold', () => {
    for (const selector of ['.panel.panelFollows', '.panelHeaderFollows']) {
      const rule = ruleFor(selector);
      expect(rule).not.toMatch(/\d+(px|vw|vh|rem|em|%)/);
    }
    // A breakpoint anywhere in this stylesheet would be a breakpoint these two
    // rules could be moved inside. If one is ever legitimately needed here,
    // narrow this to the two rules rather than delete it.
    const css = readFileSync(resolve(process.cwd(), 'src/components/surfaces.module.css'), 'utf8');
    expect(css).not.toContain('@media');
    expect(css).not.toContain('@container');
  });
});
