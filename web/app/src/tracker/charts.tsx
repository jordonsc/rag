/**
 * The report's charts (spec:velocity D16, D17, D20): hand-drawn inline SVG,
 * no chart library.
 *
 * * **`BurnDown`**: a line of tickets remaining at the end of each period over
 *   bars of those added and done in it, a y-axis of whole-number ticks, the
 *   periods' labels along the bottom, and a legend.
 * * **`RangeBars`**: one row a state, a bar to the mean with ticks at the
 *   median and the 90th percentile, on a shared hours axis, the count beside
 *   each.
 *
 * Each is sized to its container: the SVG is the container's width (a
 * `viewBox` of the measured width, so text is drawn at its own size on any
 * screen), its colours the design tokens (`charts.module.css`). Every mark
 * says its numbers on hover (`<title>`), and every chart carries a visually
 * hidden table of the same numbers, so the picture is never their only
 * carrier (D19). The charts draw what they are given: the report page shapes
 * the points (`ReportView.tsx`, `reportMath.ts`).
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { cx } from '../util';
import styles from './charts.module.css';
import { niceTicks } from './reportMath';

/** The width drawn at before the container is measured, and where it cannot be. */
const DEFAULT_WIDTH = 640;
/** Narrower than this and the labels collide; the chart is drawn at it and scales. */
const MIN_WIDTH = 280;

/** The container's width, followed as it changes. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const measure = () => {
      const measured = Math.round(element.clientWidth);
      if (measured > 0) {
        setWidth(measured);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, Math.max(MIN_WIDTH, width)];
}

/** A coordinate to a tenth of a pixel: enough, and a stable attribute. */
const px = (n: number) => Math.round(n * 10) / 10;

// ---- The burn-down ------------------------------------------------------------

/** One period of the burn-down: an hour or a local day. */
export interface BurnPoint {
  key: string;
  /** The period in full, for the titles and the table ("Mon 2 Nov"). */
  label: string;
  /** Its axis label, or `''` for none. */
  tick: string;
  remaining: number;
  added: number;
  done: number;
}

export interface BurnDownProps {
  points: readonly BurnPoint[];
  /** What the chart shows, said to a screen reader and as the table's caption. */
  caption: string;
  /** The table's heading for a period: "Day" or "Hour". */
  period: string;
}

export function BurnDown({ points, caption, period }: BurnDownProps) {
  const [ref, width] = useWidth();
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 28, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const peak = Math.max(0, ...points.flatMap((p) => [p.remaining, p.added, p.done]));
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1]!;
  const y = (v: number) => px(pad.top + plotH - (v / top) * plotH);
  const band = plotW / Math.max(1, points.length);
  const bar = Math.max(1, px(band * 0.32));
  const centre = (i: number) => px(pad.left + band * (i + 0.5));
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${centre(i)},${y(p.remaining)}`)
    .join(' ');

  return (
    <div className={styles.chart} ref={ref}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${width} ${height}`}
        height={height}
        role="img"
        aria-label={`${caption}. The numbers are in the table that follows.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={styles.grid}
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
            />
            <text
              className={styles.axisText}
              x={pad.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
            >
              {t}
            </text>
          </g>
        ))}
        <line className={styles.axis} x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
        {points.map((p, i) => {
          const left = pad.left + band * i;
          return (
            <g key={p.key}>
              {p.added > 0 && (
                <rect
                  className={styles.added}
                  x={px(left + band * 0.16)}
                  y={y(p.added)}
                  width={bar}
                  height={px(y(0) - y(p.added))}
                >
                  <title>{`${p.label}: ${p.added} added`}</title>
                </rect>
              )}
              {p.done > 0 && (
                <rect
                  className={styles.done}
                  x={px(left + band * 0.52)}
                  y={y(p.done)}
                  width={bar}
                  height={px(y(0) - y(p.done))}
                >
                  <title>{`${p.label}: ${p.done} done`}</title>
                </rect>
              )}
              {p.tick !== '' && (
                <text
                  className={styles.axisText}
                  x={centre(i)}
                  y={height - pad.bottom + 16}
                  textAnchor="middle"
                >
                  {p.tick}
                </text>
              )}
            </g>
          );
        })}
        {points.length > 0 && <path className={styles.line} d={line} />}
        {points.map((p, i) => (
          <circle
            key={p.key}
            className={styles.point}
            cx={centre(i)}
            cy={y(p.remaining)}
            r={points.length > 12 ? 2 : 3}
          >
            <title>{`${p.label}: ${p.remaining} remaining, ${p.added} added, ${p.done} done`}</title>
          </circle>
        ))}
      </svg>
      <ul className={styles.legend} aria-hidden>
        <li>
          <span className={styles.swatchLine} />
          Remaining, at the end of each {period.toLowerCase()}
        </li>
        <li>
          <span className={cx(styles.swatch, styles.swatchAdded)} />
          Added
        </li>
        <li>
          <span className={cx(styles.swatch, styles.swatchDone)} />
          Done
        </li>
      </ul>
      <table className={styles.hidden}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{period}</th>
            <th scope="col">Remaining at its end</th>
            <th scope="col">Added</th>
            <th scope="col">Done</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <th scope="row">{p.label}</th>
              <td>{p.remaining}</td>
              <td>{p.added}</td>
              <td>{p.done}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Time in each state ---------------------------------------------------------

/** One state's lengths, in seconds; `null`s when nothing ended in it. */
export interface RangeRow {
  key: string;
  label: string;
  count: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
}

export interface RangeBarsProps {
  rows: readonly RangeRow[];
  caption: string;
  /** A length in words, for the titles and the table. */
  format: (seconds: number) => string;
}

export function RangeBars({ rows, caption, format }: RangeBarsProps) {
  const [ref, width] = useWidth();
  const rowH = 30;
  const pad = { top: 4, right: 76, bottom: 28, left: 92 };
  const height = pad.top + rows.length * rowH + pad.bottom;
  const plotW = width - pad.left - pad.right;
  const lengths = rows.flatMap((r) =>
    [r.mean, r.median, r.p90].filter((v): v is number => v !== null),
  );
  const ticks = niceTicks(Math.max(0, ...lengths) / 3600, { whole: false });
  const top = ticks[ticks.length - 1]!;
  const x = (seconds: number) => px(pad.left + (seconds / 3600 / top) * plotW);
  const bottom = pad.top + rows.length * rowH;
  const or = (v: number | null) => (v === null ? '—' : format(v));

  return (
    <div className={styles.chart} ref={ref}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${width} ${height}`}
        height={height}
        role="img"
        aria-label={`${caption}. The numbers are in the table that follows.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={styles.grid}
              x1={x(t * 3600)}
              x2={x(t * 3600)}
              y1={pad.top}
              y2={bottom}
            />
            <text
              className={styles.axisText}
              x={x(t * 3600)}
              y={bottom + 16}
              textAnchor="middle"
            >{`${t} h`}</text>
          </g>
        ))}
        <line className={styles.axis} x1={pad.left} x2={pad.left} y1={pad.top} y2={bottom} />
        {rows.map((r, i) => {
          const cy = pad.top + i * rowH + rowH / 2;
          return (
            <g key={r.key}>
              <text
                className={styles.rowLabel}
                x={pad.left - 8}
                y={cy}
                dy="0.32em"
                textAnchor="end"
              >
                {r.label}
              </text>
              {r.mean !== null && (
                <rect
                  className={styles.mean}
                  x={pad.left}
                  y={cy - 6}
                  width={Math.max(1, px(x(r.mean) - pad.left))}
                  height={12}
                >
                  <title>{`${r.label}: mean ${format(r.mean)}, over ${r.count}`}</title>
                </rect>
              )}
              {r.median !== null && (
                <line
                  className={styles.median}
                  x1={x(r.median)}
                  x2={x(r.median)}
                  y1={cy - 9}
                  y2={cy + 9}
                >
                  <title>{`${r.label}: median ${format(r.median)}`}</title>
                </line>
              )}
              {r.p90 !== null && (
                <line className={styles.p90} x1={x(r.p90)} x2={x(r.p90)} y1={cy - 9} y2={cy + 9}>
                  <title>{`${r.label}: 90th percentile ${format(r.p90)}`}</title>
                </line>
              )}
              <text className={styles.axisText} x={width - pad.right + 8} y={cy} dy="0.32em">
                {r.count === 0 ? 'none ended' : `${r.count} ended`}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className={styles.legend} aria-hidden>
        <li>
          <span className={cx(styles.swatch, styles.swatchMean)} />
          Mean
        </li>
        <li>
          <span className={styles.swatchMedian} />
          Median
        </li>
        <li>
          <span className={styles.swatchP90} />
          90th percentile
        </li>
      </ul>
      <table className={styles.hidden}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">Ended in the window</th>
            <th scope="col">Mean</th>
            <th scope="col">Median</th>
            <th scope="col">90th percentile</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.count}</td>
              <td>{or(r.mean)}</td>
              <td>{or(r.median)}</td>
              <td>{or(r.p90)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
