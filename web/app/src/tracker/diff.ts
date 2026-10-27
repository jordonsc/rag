/**
 * Line diffs, for the two places a document's changes are shown (m04):
 *
 * * **a stale save** (TC-03): the newer revision against the text in the
 *   editor, which the server never saw, so the diff is made here
 *   ({@link diffLines});
 * * **the history** (TC-04): the server's unified diff between two revisions,
 *   parsed into the same rows ({@link parseUnified}).
 *
 * Both become {@link DiffRow}s and are drawn by one component (`LineDiff`), so a
 * reader learns one picture of a change.
 */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffOp {
  kind: DiffKind;
  text: string;
}

/** A row as drawn: a line, a hunk header, or a run of unchanged lines folded away. */
export type DiffRow =
  | { kind: DiffKind; text: string }
  | { kind: 'hunk'; text: string }
  | { kind: 'gap'; count: number };

/** Beyond this many edits the diff is drawn as "all of one, all of the other". */
const EDIT_LIMIT = 4000;

function lines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * Myers' O(ND) shortest edit script over two line arrays, or `null` when the
 * texts differ by more than {@link EDIT_LIMIT} lines.
 *
 * Each round's frontier is kept for the walk back, but only its live band
 * (`-d…d`), so the memory is the square of the edit count, not of the length.
 */
function myers(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d += 1) {
    if (d > EDIT_LIMIT) {
      return null;
    }
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const band = trace[d]!;
    const at = (k: number) => band[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'same', text: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: 'add', text: b[prevY]! });
    } else {
      ops.push({ kind: 'del', text: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'same', text: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/**
 * The line diff from `before` to `after`: every line of both, in order, each
 * marked unchanged, added (only in `after`) or deleted (only in `before`).
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a.slice(0, start).map((text): DiffOp => ({ kind: 'same', text }));
  const tail = a.slice(endA).map((text): DiffOp => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? [
    ...midA.map((text): DiffOp => ({ kind: 'del', text })),
    ...midB.map((text): DiffOp => ({ kind: 'add', text })),
  ];
  return [...head, ...middle, ...tail];
}

/** Whether a diff changes anything. */
export function changed(ops: readonly DiffOp[]): boolean {
  return ops.some((op) => op.kind !== 'same');
}

/**
 * The rows to draw: every change with `context` unchanged lines either side,
 * and each longer unchanged run folded into a `gap` that says how long it is.
 */
export function withContext(ops: readonly DiffOp[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind !== 'same') {
      for (
        let i = Math.max(0, index - context);
        i <= Math.min(ops.length - 1, index + context);
        i += 1
      ) {
        keep[i] = true;
      }
    }
  });
  const rows: DiffRow[] = [];
  let folded = 0;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (folded > 0) {
        rows.push({ kind: 'gap', count: folded });
        folded = 0;
      }
      rows.push(op);
    } else {
      folded += 1;
    }
  });
  if (folded > 0 && rows.length > 0) {
    rows.push({ kind: 'gap', count: folded });
  }
  return rows;
}

/**
 * The server's unified diff (api.md § `GET /tracker/docs/{id}/diff`) as rows:
 * the `---`/`+++` header dropped, each `@@` kept as a hunk header.
 */
export function parseUnified(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('@@')) {
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'same', text: line.slice(1) });
    }
  }
  return rows;
}
