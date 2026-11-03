/**
 * A key figure, designed (owner request rag-t0062): the value carries the
 * weight, the label and the unit stand back.
 *
 * * **`tile`** (the report): a small muted label over a large bright value,
 *   its unit smaller and muted beside it, and any quieter detail under it, on
 *   a bordered tile. A grid of them wraps to two columns on a phone.
 * * **`inline`** (the queue page's velocity row): the label muted and the
 *   value emphasised on one line, so the row stays one compact row.
 *
 * **Read together.** Each figure is a list item (the caller gives the list
 * its name) whose name is the whole sentence, "Velocity: 8/day" or "Mean time
 * to completion: 1.9 hours, median 1.1 hours, over 349 tickets", and whose
 * content reads the same in the same order (a visually hidden colon after the
 * label, a hidden comma before each detail), so a screen reader that takes the
 * name and one that reads the content both hear label and value together.
 * The tooltip, the native `title` as before (D14), becomes its description.
 */

import { cx } from '../util';
import styles from './stat.module.css';
import { joinParts, type Parts } from './velocity';

export interface StatProps extends Parts {
  label: string;
  /** How the value reads aloud when what is shown does not ("unknown" for "—"). */
  spoken?: string;
  /** Quieter facts under the value ("median 1.1 hours", "over 349 tickets"). */
  detail?: readonly string[];
  /** The native tooltip (D14). */
  title?: string;
  variant?: 'tile' | 'inline';
  /** A tile set inside a panel: drawn without its own ground. */
  inset?: boolean;
}

/** The figure's name: "Label: value, detail, detail". */
export function statName(label: string, spoken: string, detail: readonly string[] = []): string {
  return [`${label}: ${spoken}`, ...detail].join(', ');
}

export function Stat({
  label,
  value,
  unit,
  spoken,
  detail = [],
  title,
  variant = 'tile',
  inset = false,
}: StatProps) {
  const said = spoken ?? joinParts({ value, unit });
  return (
    <li
      className={cx(styles.stat, styles[variant], inset && styles.inset)}
      title={title}
      aria-label={statName(label, said, detail)}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.hidden}>: </span>
      <Value value={value} unit={unit} spoken={spoken} />
      {detail.length > 0 && (
        <span className={styles.detail}>
          {detail.map((d, i) => (
            <span key={`${i}:${d}`} className={styles.detailPart}>
              <span className={styles.hidden}>, </span>
              {d}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}

/** The value and its unit, the unit set apart (a real space, so it reads as two words). */
function Value({ value, unit, spoken }: Parts & { spoken?: string }) {
  return (
    <span className={styles.value}>
      {spoken === undefined ? (
        value
      ) : (
        <>
          <span aria-hidden="true">{value}</span>
          <span className={styles.hidden}>{spoken}</span>
        </>
      )}
      {unit !== '' && (
        <span className={styles.unit} aria-hidden={spoken === undefined ? undefined : 'true'}>
          {unit.startsWith('/') ? unit : ` ${unit}`}
        </span>
      )}
    </span>
  );
}

/** One side of a split: "41 confirmed". */
export interface SplitPart {
  count: number;
  /** "confirmed", "sent back". */
  label: string;
  tone: 'good' | 'warn';
}

/**
 * Two counts and how they divide (the report's confirmed against sent back):
 * each count large with its word, a swatch matching its share of a thin bar
 * under them. The bar is a picture of the two numbers already in words, so
 * it is hidden from the accessibility tree; with both at 0 it is an empty
 * track.
 */
export function SplitStat({
  label,
  parts,
  title,
  inset = false,
}: {
  label: string;
  parts: readonly [SplitPart, SplitPart];
  title?: string;
  inset?: boolean;
}) {
  const total = parts[0].count + parts[1].count;
  const spoken = parts.map((p) => `${p.count} ${p.label}`).join(', ');
  return (
    <li
      className={cx(styles.stat, styles.tile, inset && styles.inset)}
      title={title}
      aria-label={`${label}: ${spoken}`}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.hidden}>: </span>
      <span className={styles.splitFigures}>
        {parts.map((p, i) => (
          <span key={p.label} className={styles.splitFigure}>
            {i > 0 && <span className={styles.hidden}>, </span>}
            <span className={cx(styles.swatch, styles[p.tone])} aria-hidden="true" />
            <span className={styles.value}>
              {p.count}
              <span className={styles.unit}>{` ${p.label}`}</span>
            </span>
          </span>
        ))}
      </span>
      <span className={styles.splitBar} aria-hidden="true">
        {total > 0 &&
          parts.map(
            (p) =>
              p.count > 0 && (
                <span
                  key={p.label}
                  className={cx(styles.splitPart, styles[p.tone])}
                  style={{ flexGrow: p.count }}
                />
              ),
          )}
      </span>
    </li>
  );
}
