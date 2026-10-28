/**
 * The slots on a row (rag-t0033): every row's status word and type badge, in
 * every section, sit in slots as wide as the widest word of their kind, and a
 * flat row leads with the queue's grip room, so the ids and the assignees each
 * start at one x down the page. jsdom lays nothing out, so this defends the
 * parts the layout is built from: every row slotted with every word of its
 * kind, the stylesheet's sizers, the flat row's lead, and the words' own text
 * unchanged (a sizer is a pseudo-element, never a word anyone reads). The
 * measured x positions are in the m03 As built (headless Chromium).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, within } from '@testing-library/react';

import { StatusDot, TypeBadge } from '../tracker/parts';
import { QueueView } from '../tracker/QueueView';
import type { QueueView as QueueViewRecord } from '../tracker/types';
import { ITEM_STATUSES, ITEM_TYPES } from '../tracker/types';
import { ITEM_TYPE_SIZER, itemStatusLabel, itemTypeLabel, STATUS_SIZER } from '../tracker/vocab';
import { mountAt } from './harness';
import { TrackerServer, gateItem, item, queueRoute, queueView } from './trackerFixtures';

const QUEUE = /^\/tracker\/demo$/;
const PROJECTS = '/tracker/projects';

let view: QueueViewRecord;

beforeEach(() => {
  view = queueView({
    done: [
      item('demo-t0009', { status: 'done', queued: false, type: 'analysis', assignee: 'a-1' }),
    ],
    review: [item('demo-t0011', { status: 'review', type: 'design', assignee: 'b-2' })],
    queue: [
      item('demo-t0001', { status: 'in_progress', type: 'recon', assignee: 'c-3' }),
      gateItem('demo-t0003', { release: true }),
      item('demo-t0002', { type: 'dev', assignee: 'd-4' }),
    ],
    blocked: [
      item('demo-t0006', {
        blocked: true,
        block_reason: 'review',
        type: 'dev',
        assignee: 'e-5',
      }),
    ],
    deferred: [item('demo-t0007', { status: 'deferred', type: 'analysis', assignee: 'f-6' })],
  });
  const server = new TrackerServer();
  server.on(PROJECTS, { body: { projects: [] } });
  server.on(
    QUEUE,
    queueRoute(() => view),
    'GET',
  );
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the type slot (rag-t0033)', () => {
  it('sizes each slot from every word of its kind, one a line', () => {
    expect(ITEM_TYPE_SIZER.split('\n').sort()).toEqual(ITEM_TYPES.map(itemTypeLabel).sort());
    // Every status a row can show, blocked included.
    const states = [...ITEM_STATUSES, 'blocked'];
    expect(STATUS_SIZER.split('\n').sort()).toEqual(states.map(itemStatusLabel).sort());
  });

  it('slots the type on every row’s second line, in every section, with the assignee straight after it', async () => {
    mountAt('/projects/:project', <QueueView />, { route: '/projects/demo' });
    await screen.findByRole('heading', { name: 'demo' });
    const expected: Record<string, Array<[string, string]>> = {
      Done: [['Analysis', 'a-1']],
      Review: [['Design', 'b-2']],
      Queue: [
        ['Recon', 'c-3'],
        ['Dev', 'd-4'],
      ],
      Blocked: [['Dev', 'e-5']],
      Deferred: [['Analysis', 'f-6']],
    };
    for (const [name, rows] of Object.entries(expected)) {
      const region = screen.getByRole('region', { name });
      const lines = region.querySelectorAll<HTMLElement>('[class*="cellLine2"]');
      expect(lines, name).toHaveLength(rows.length);
      lines.forEach((line, i) => {
        const [label, assignee] = rows[i]!;
        const badge = line.querySelector<HTMLElement>('[data-type]')!;
        expect(badge.className, name).toMatch(/typeSlotted/);
        const word = badge.querySelector<HTMLElement>('[data-sizer]')!;
        expect(word.getAttribute('data-sizer')).toBe(ITEM_TYPE_SIZER);
        // The status beside it is slotted the same way, so the status
        // column (and the id after it) is one width on every row.
        const status = line.closest('li')!.querySelector<HTMLElement>('[data-state]')!;
        expect(status.className, name).toMatch(/statusSlotted/);
        expect(status.querySelector('[data-sizer]')!.getAttribute('data-sizer')).toBe(STATUS_SIZER);
        // The badge still says only its own type.
        expect(badge.textContent).toBe(label);
        // The assignee is the next thing on the line, so the slot sets its x.
        const next = badge.nextElementSibling as HTMLElement;
        expect(next.getAttribute('title')).toBe('Assignee');
        const nameSpan = within(next).getByText(assignee);
        // Kept with the type, and cut short rather than wrapped, its full
        // text the tooltip.
        expect(badge.parentElement!.className).toMatch(/line2Who/);
        expect(next.parentElement).toBe(badge.parentElement);
        expect(nameSpan.className).toMatch(/assigneeName/);
        expect(nameSpan).toHaveAttribute('title', assignee);
      });
    }
    // A gate marker has no second line and no slot.
    const gate = screen
      .getByRole('list', { name: 'Queue' })
      .querySelector('[data-id="demo-t0003"]');
    expect(gate).not.toBeNull();
    expect(gate!.querySelector('[class*="typeSlotted"]')).toBeNull();
  });

  it('draws each slot from a hidden, zero-height stack of its words under the visible one', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    const column =
      /\.statusSlotted > \.statusLabel,\s*\.typeSlotted > \.typeLabel\s*\{([^}]*)\}/.exec(sheet);
    expect(column).not.toBeNull();
    expect(column![1]).toMatch(/display:\s*inline-flex;/);
    expect(column![1]).toMatch(/flex-direction:\s*column;/);
    const sizer =
      /\.statusSlotted > \.statusLabel::after,\s*\.typeSlotted > \.typeLabel::after\s*\{([^}]*)\}/.exec(
        sheet,
      );
    expect(sizer).not.toBeNull();
    expect(sizer![1]).toMatch(/content:\s*attr\(data-sizer\);/);
    expect(sizer![1]).toMatch(/height:\s*0;/);
    expect(sizer![1]).toMatch(/visibility:\s*hidden;/);
    // One word a line, so the stack is as wide as its widest word.
    expect(sizer![1]).toMatch(/white-space:\s*pre;/);
    // At the status word's heaviest weight, so a lighter word's row is no narrower.
    const heaviest = /\.statusLabel\s*\{[^}]*font-weight:\s*(\d+);/.exec(sheet)![1];
    expect(sheet).toMatch(
      new RegExp(`\\.statusSlotted > \\.statusLabel::after\\s*\\{\\s*font-weight:\\s*${heaviest};`),
    );
    for (const m of sheet.matchAll(
      /\.status_[a-z_]+ \.statusLabel\s*\{[^}]*font-weight:\s*(\d+);/g,
    )) {
      expect(Number(m[1])).toBeLessThanOrEqual(Number(heaviest));
    }
  });

  it('keeps the type and the assignee on one line, the name cut short rather than wrapped', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    const pair = /\.line2Who\s*\{([^}]*)\}/.exec(sheet);
    expect(pair).not.toBeNull();
    expect(pair![1]).toMatch(/display:\s*inline-flex;/);
    expect(pair![1]).toMatch(/max-width:\s*100%;/);
    expect(pair![1]).not.toMatch(/flex-wrap:\s*wrap/);
    expect(sheet).toMatch(/\.line2Who > \.type\s*\{\s*flex:\s*none;\s*\}/);
    const name = /\.assigneeName\s*\{([^}]*)\}/.exec(sheet);
    expect(name).not.toBeNull();
    expect(name![1]).toMatch(/min-width:\s*0;/);
    expect(name![1]).toMatch(/overflow:\s*hidden;/);
    expect(name![1]).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it('leads a flat row with the queue’s grip room, so its second line starts at the queue’s x', () => {
    const sheet = readFileSync(resolve(__dirname, '../tracker/tracker.module.css'), 'utf8');
    // Desktop: the queue's status sits 35px into its section (1px border, the
    // 28px grip, half the 12px gap); a flat section's border is 3px.
    const flat = /\n\.flatRow\s*\{([^}]*)\}/.exec(sheet);
    expect(flat).not.toBeNull();
    expect(flat![1]).toMatch(
      /padding:\s*var\(--rag-space-1\) var\(--rag-space-3\) var\(--rag-space-1\) 32px;/,
    );
    expect(sheet).toMatch(/\.queue\s*\{[^}]*\[grip\] 28px/);
    expect(sheet).toMatch(/\.section_done\s*\{\s*border-left:\s*3px/);
    // The status column is the slot's own width, never a fitted length.
    expect(flat![1]).toMatch(/\[status\] max-content/);
    expect(flat![1]).not.toMatch(/\[status\] (calc|\d)/);
    // Phone: 1px border, 4px padding, the 28px grip and a 12px gap is 45px.
    const phone = /@media \(max-width: 40rem\)[\s\S]*?\n {2}\.flatRow\s*\{([^}]*)\}/.exec(sheet);
    expect(phone).not.toBeNull();
    expect(phone![1]).toMatch(/padding-left:\s*42px;/);
  });

  it('leaves the badge and the status unslotted where they are not on a row (the item page, history)', () => {
    const { container } = render(<TypeBadge type="dev" />);
    const badge = container.querySelector<HTMLElement>('[data-type="dev"]')!;
    expect(badge.className).not.toMatch(/typeSlotted/);
    expect(badge.querySelector('[data-sizer]')).toBeNull();
    expect(badge.textContent).toBe('Dev');
    const status = render(<StatusDot state="in_progress" />).container.querySelector<HTMLElement>(
      '[data-state]',
    )!;
    expect(status.className).not.toMatch(/statusSlotted/);
    expect(status.querySelector('[data-sizer]')).toBeNull();
    expect(status.textContent).toBe('In progress');
  });
});
