// jsdom has no layout engine, so nothing here proves a *rendered* tooltip sits
// inside the viewport. What is provable headless is the part that decides where
// a tooltip goes: the placement arithmetic, and the structural facts the
// arithmetic depends on — that the bubble is rendered through a React portal
// rather than laid out inside its trigger's box, and that the nav rail asks for
// the side placement its left-edge position requires.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip, placeTooltip, type TooltipPlacement } from '../components/overlays';
import { NavRail, TopNav } from '../components/nav';

const VIEWPORT = { width: 1280, height: 800 };

/** A trigger box, in viewport coordinates. */
function trigger(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('placeTooltip', () => {
  it('opens a right-placed tooltip clear of the left edge', () => {
    // A nav rail button: 40px wide, hard against the left of the viewport.
    const at = placeTooltip(
      trigger(8, 64, 40, 40),
      { width: 204, height: 24 },
      'right',
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(at.left).toBeGreaterThanOrEqual(48);
    expect(at.left + 204).toBeLessThanOrEqual(VIEWPORT.width);
    // Vertically centred on the trigger.
    expect(at.top).toBe(64 + 40 / 2 - 24 / 2);
  });

  it('clamps a bottom-placed tooltip that would centre off the left edge', () => {
    // The first top-nav icon: a tooltip centred under it starts at -47.
    const at = placeTooltip(
      trigger(12, 6, 34, 36),
      { width: 110, height: 24 },
      'bottom',
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(at.left).toBeGreaterThanOrEqual(0);
  });

  it('clamps a bottom-placed tooltip that would run off the right edge', () => {
    const at = placeTooltip(
      trigger(1240, 6, 34, 36),
      { width: 160, height: 24 },
      'bottom',
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(at.left + 160).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('flips a right-placed tooltip to the left when there is no room beside it', () => {
    const at = placeTooltip(
      trigger(1200, 400, 40, 40),
      { width: 200, height: 24 },
      'right',
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(at.left).toBeLessThan(1200);
    expect(at.left + 200).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('flips a bottom-placed tooltip above its trigger at the foot of the viewport', () => {
    const at = placeTooltip(
      trigger(600, 770, 40, 24),
      { width: 100, height: 24 },
      'bottom',
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(at.top + 24).toBeLessThanOrEqual(770);
  });

  it.each<TooltipPlacement>(['bottom', 'right'])(
    'keeps a %s tooltip inside a viewport too small for it either way',
    (placement) => {
      const at = placeTooltip(
        trigger(0, 0, 40, 40),
        { width: 300, height: 24 },
        placement,
        320,
        200,
      );
      expect(at.left).toBeGreaterThanOrEqual(0);
      expect(at.top).toBeGreaterThanOrEqual(0);
    },
  );
});

describe('Tooltip', () => {
  it('renders the bubble out of its trigger so no ancestor clips or scrolls for it', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Tooltip text="Search the ledger">
        <button type="button">item</button>
      </Tooltip>,
    );

    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveTextContent('Search the ledger');
    // Anchored inside the trigger, the bubble counts towards the nav strip's
    // scrollable overflow, which is what produces a phantom scrollbar.
    expect(container.contains(bubble)).toBe(false);
    expect(bubble.parentElement).toBe(document.body);
    // Positioned against the viewport, not against the trigger's box.
    expect(bubble).toHaveStyle({ position: 'fixed' });

    // It still describes its trigger from over there.
    expect(screen.getByRole('button', { name: 'item' }).parentElement).toHaveAttribute(
      'aria-describedby',
      bubble.id,
    );

    expect(bubble).not.toHaveClass('tipOpen');
    await user.hover(screen.getByRole('button', { name: 'item' }));
    expect(bubble).toHaveClass('tipOpen');
    await user.unhover(screen.getByRole('button', { name: 'item' }));
    expect(bubble).not.toHaveClass('tipOpen');
  });

  it('defaults to the bottom placement', () => {
    render(
      <Tooltip text="Topics">
        <button type="button">item</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-placement', 'bottom');
  });
});

describe('nav tooltip placement', () => {
  const items = [
    { id: 'search', icon: 'search', title: 'Search', hint: 'Find a topic across the ledger' },
    { id: 'new', icon: 'plus', title: 'New topic', hint: 'Record a decision or a finding' },
  ];

  it('opens rail tooltips to the right of the rail', () => {
    render(<NavRail label="Sections" items={items} activeId="search" onSelect={() => {}} />);
    const tips = screen.getAllByRole('tooltip');
    expect(tips).toHaveLength(items.length);
    for (const tip of tips) {
      // The rail is pinned to the left edge; a centred tooltip lands off-screen.
      expect(tip).toHaveAttribute('data-placement', 'right');
    }
  });

  // A hint that explains a destination without naming it is an unattributed
  // sentence over an icon nobody recognises yet. The title leads, emphasised;
  // the hint follows.
  it('names the destination on the first line of its hint, and explains it beneath', () => {
    render(<NavRail label="Sections" items={items} activeId="search" onSelect={() => {}} />);
    const tip = screen.getAllByRole('tooltip')[0]!;
    // Both lines are present, in that order.
    expect(tip).toHaveTextContent('SearchFind a topic across the ledger');
    // The title is the *emphasised* line rather than merely the first one —
    // this is the assertion that fails if the two collapse back into one
    // string.
    const title = tip.firstElementChild;
    expect(title).not.toBeNull();
    expect(title).toHaveClass('tipTitle');
    expect(title).toHaveTextContent('Search');
  });

  it('gives the rail button its title as the accessible name', () => {
    render(<NavRail label="Sections" items={items} activeId="search" onSelect={() => {}} />);
    // Not the hint: a screen reader that announced the description as the
    // control's name would never say which destination it was.
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New topic' })).toBeInTheDocument();
  });

  it('draws a hintless destination as its title alone, not as its title twice', () => {
    render(
      <NavRail
        label="Sections"
        items={[{ id: 'archive', icon: 'archive', title: 'Archive' }]}
        onSelect={() => {}}
      />,
    );
    const tip = screen.getAllByRole('tooltip')[0]!;
    expect(tip).toHaveTextContent('Archive');
    expect(tip.querySelector('.tipTitle')).toBeNull();
  });

  it('opens top-nav tooltips below the strip, and only for inactive destinations', () => {
    render(
      <TopNav
        label="Sections"
        items={[
          { id: 'search', icon: 'search', label: 'Search' },
          { id: 'archive', icon: 'archive', label: 'Archive' },
        ]}
        activeId="search"
        onSelect={() => {}}
      />,
    );
    const tips = screen.getAllByRole('tooltip');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent('Archive');
    expect(tips[0]).toHaveAttribute('data-placement', 'bottom');
  });

  it('leaves nothing absolutely positioned inside the scrolling strip', () => {
    const { container } = render(
      <TopNav
        label="Sections"
        items={[
          { id: 'search', icon: 'search', label: 'Search' },
          { id: 'archive', icon: 'archive', label: 'Archive' },
          { id: 'tags', icon: 'tag', label: 'Tags' },
        ]}
        activeId="search"
        onSelect={() => {}}
      />,
    );
    const strip = within(container).getByRole('navigation', { name: 'Sections' });
    expect(strip.querySelector('[role="tooltip"]')).toBeNull();
  });
});
