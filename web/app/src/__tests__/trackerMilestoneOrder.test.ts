/**
 * The pure halves of rag-t0003: a milestone move's writes (`planMove`) and
 * the document path a rename may name (`isDocPath`).
 */

import { planMove, sortMilestones, type Ordered } from '../tracker/milestoneOrder';
import { isDocPath } from '../tracker/paths';

function codesAfter(list: readonly Ordered[], writes: readonly { code: string; order: number }[]) {
  return sortMilestones(
    list.map((milestone) => {
      const write = writes.find((candidate) => candidate.code === milestone.code);
      return write === undefined ? milestone : { ...milestone, order: write.order };
    }),
  ).map((milestone) => milestone.code);
}

const LIST: Ordered[] = [
  { code: 'm01', order: 1 },
  { code: 'm02', order: 2 },
  { code: 'm03', order: 3 },
];

describe('planMove', () => {
  it('swaps the orders of the milestone and the one it passes, each with a note', () => {
    expect(planMove(LIST, 'm03', 'up')).toEqual([
      { code: 'm03', order: 2, note: 'Moved up, before m02.' },
      { code: 'm02', order: 3, note: 'Moved down, after m03.' },
    ]);
    expect(planMove(LIST, 'm01', 'down')).toEqual([
      { code: 'm01', order: 2, note: 'Moved down, after m02.' },
      { code: 'm02', order: 1, note: 'Moved up, before m01.' },
    ]);
  });

  it('sorts as the server does, whatever order the list arrives in', () => {
    const shuffled = [LIST[2]!, LIST[0]!, LIST[1]!];
    expect(codesAfter(shuffled, planMove(shuffled, 'm02', 'up')!)).toEqual(['m02', 'm01', 'm03']);
  });

  it('refuses a move past either end, or of a code not in the list', () => {
    expect(planMove(LIST, 'm01', 'up')).toBeNull();
    expect(planMove(LIST, 'm03', 'down')).toBeNull();
    expect(planMove(LIST, 'm09', 'up')).toBeNull();
    expect(planMove([], 'm01', 'down')).toBeNull();
  });

  it('renumbers when tied orders would make a swap land elsewhere', () => {
    // Sorted: m07 (1), m08 (1), m01 (2). Swapping m01 with m08 gives m01
    // order 1, which sorts it before m07 too: two places, not one.
    const tied: Ordered[] = [
      { code: 'm01', order: 2 },
      { code: 'm07', order: 1 },
      { code: 'm08', order: 1 },
    ];
    const writes = planMove(tied, 'm01', 'up')!;
    expect(codesAfter(tied, writes)).toEqual(['m07', 'm01', 'm08']);
    // m07 already holds 1 and is not written; m01 keeps 2 but is named, with its note.
    expect(writes.map((write) => write.code).sort()).toEqual(['m01', 'm08']);
    expect(writes.find((write) => write.code === 'm01')!.note).toBe('Moved up, before m08.');
  });

  it('renumbers when the two share an order, naming the others it touches', () => {
    const same: Ordered[] = [
      { code: 'a1', order: 5 },
      { code: 'a2', order: 5 },
      { code: 'a3', order: 0 },
    ];
    const writes = planMove(same, 'a2', 'up')!;
    expect(codesAfter(same, writes)).toEqual(['a3', 'a2', 'a1']);
    expect(writes).toContainEqual({ code: 'a3', order: 1, note: 'Renumbered when a2 moved up.' });
  });

  it('always lands one place over, on random lists with ties', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 300; round += 1) {
      const size = 2 + (next() % 6);
      const list: Ordered[] = Array.from({ length: size }, (_, index) => ({
        code: `m${String(index).padStart(2, '0')}`,
        order: next() % 4,
      }));
      const sorted = sortMilestones(list).map((milestone) => milestone.code);
      const index = next() % size;
      const direction = next() % 2 === 0 ? 'up' : 'down';
      const writes = planMove(list, sorted[index]!, direction);
      const other = direction === 'up' ? index - 1 : index + 1;
      if (other < 0 || other >= size) {
        expect(writes).toBeNull();
        continue;
      }
      const wanted = [...sorted];
      wanted[index] = sorted[other]!;
      wanted[other] = sorted[index]!;
      expect(codesAfter(list, writes!)).toEqual(wanted);
    }
  });
});

describe('isDocPath', () => {
  it('accepts what the server accepts', () => {
    expect(isDocPath('concepts/power.md')).toBe(true);
    expect(isDocPath('specs/audio/m03-music_v2.md')).toBe(true);
    expect(isDocPath(`${'a'.repeat(297)}.md`)).toBe(true);
  });

  it('refuses what the server refuses', () => {
    expect(isDocPath('')).toBe(false);
    expect(isDocPath('concepts/power.txt')).toBe(false);
    expect(isDocPath('/concepts/power.md')).toBe(false);
    expect(isDocPath('concepts//power.md')).toBe(false);
    expect(isDocPath('concepts/../power.md')).toBe(false);
    expect(isDocPath('./power.md')).toBe(false);
    expect(isDocPath('concepts/power plan.md')).toBe(false);
    expect(isDocPath('concepts/pöwer.md')).toBe(false);
    expect(isDocPath(`${'a'.repeat(298)}.md`)).toBe(false);
  });
});
