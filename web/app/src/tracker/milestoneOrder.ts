/**
 * Moving a milestone up or down on the Specs tab (rag-t0003).
 *
 * The API has no "move" for milestones: each has an integer `order`, and a
 * spec's milestones sort by `order`, then by code (api.md § Specs and
 * milestones). A move is therefore a set of `order` writes, one per milestone
 * whose order changes, each its own event in that milestone's history.
 *
 * The plan is the fewest writes that put the list in the wanted arrangement
 * **as the server sorts it**:
 *
 * * normally two: the milestone and the neighbour it passes swap orders;
 * * when ties (two milestones with one order) make a swap land somewhere else,
 *   the spec's milestones are renumbered 1…n in the wanted arrangement, writing
 *   those whose order changes and always the two that change places (one whose
 *   order happens to stay is sent it unchanged with its note, which the server
 *   records as a note event).
 *
 * A swap is checked by sorting its result as the server would, and a renumber
 * sorts as wanted by construction, so a plan this module returns always puts
 * the list in the wanted order.
 */

/** What a move needs to know of a milestone. */
export interface Ordered {
  code: string;
  order: number;
}

export type Direction = 'up' | 'down';

/** One write: set this milestone's order, with the note its history keeps. */
export interface OrderWrite {
  code: string;
  order: number;
  note: string;
}

/** The server's sort: `order` ascending, then code. */
export function sortMilestones<T extends Ordered>(list: readonly T[]): T[] {
  return [...list].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

function arrangement(list: readonly Ordered[]): string[] {
  return sortMilestones(list).map((milestone) => milestone.code);
}

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

function applied(list: readonly Ordered[], writes: readonly OrderWrite[]): Ordered[] {
  return list.map((milestone) => {
    const write = writes.find((candidate) => candidate.code === milestone.code);
    return write === undefined ? milestone : { code: milestone.code, order: write.order };
  });
}

/**
 * The writes that move `code` one place `direction`, or `null` when it cannot
 * move (already first or last, or not in the list).
 */
export function planMove(
  list: readonly Ordered[],
  code: string,
  direction: Direction,
): OrderWrite[] | null {
  const sorted = sortMilestones(list);
  const index = sorted.findIndex((milestone) => milestone.code === code);
  const other = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || other < 0 || other >= sorted.length) {
    return null;
  }
  const moving = sorted[index]!;
  const passed = sorted[other]!;
  const wanted = sorted.map((milestone) => milestone.code);
  wanted[index] = passed.code;
  wanted[other] = moving.code;

  const movedNote =
    direction === 'up' ? `Moved up, before ${passed.code}.` : `Moved down, after ${passed.code}.`;
  const passedNote =
    direction === 'up' ? `Moved down, after ${moving.code}.` : `Moved up, before ${moving.code}.`;

  if (moving.order !== passed.order) {
    const swap: OrderWrite[] = [
      { code: moving.code, order: passed.order, note: movedNote },
      { code: passed.code, order: moving.order, note: passedNote },
    ];
    if (sameCodes(arrangement(applied(list, swap)), wanted)) {
      return swap;
    }
  }

  // Ties: renumber 1…n in the wanted arrangement (distinct orders, so it sorts as wanted).
  const writes: OrderWrite[] = [];
  wanted.forEach((wantedCode, position) => {
    const milestone = sorted.find((candidate) => candidate.code === wantedCode)!;
    const order = position + 1;
    const named = wantedCode === moving.code || wantedCode === passed.code;
    // The two that change places are always written, so each one's history
    // says so; an unchanged order with a note is a note event (api.md § Conventions).
    if (milestone.order === order && !named) {
      return;
    }
    const note =
      wantedCode === moving.code
        ? movedNote
        : wantedCode === passed.code
          ? passedNote
          : `Renumbered when ${moving.code} moved ${direction}.`;
    writes.push({ code: wantedCode, order, note });
  });
  return writes;
}
