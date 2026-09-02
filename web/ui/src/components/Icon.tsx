import styles from './Icon.module.css';
import { iconRegistry } from '../icons/registry';
import { cx } from '../util';

export interface IconProps {
  /**
   * The glyph's name in `icons/registry.ts` — `"search"`, `"triangle-alert"`.
   * A name the registry does not hold renders a generic circle: an icon is
   * never the reason a page fails to draw.
   */
  name: string;
  size?: number;
  /** Accessible label. Without one the icon is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

function FallbackGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * One icon, drawn in `currentColor` at the size asked for.
 *
 * `absoluteStrokeWidth` keeps the stroke at 1.75px whatever the size, so a
 * 12px chevron in a table header and a 28px glyph in an empty state are drawn
 * at the same weight rather than the small one looking heavier.
 */
export function Icon({ name, size = 16, label, className }: IconProps) {
  const aria =
    label !== undefined
      ? ({ role: 'img', 'aria-label': label } as const)
      : ({ 'aria-hidden': true } as const);

  const Glyph = iconRegistry[name];
  const known = Glyph !== undefined;

  return (
    <span className={cx(styles.icon, className)} data-icon={known ? name : 'fallback'} {...aria}>
      {known ? (
        <Glyph size={size} strokeWidth={1.75} absoluteStrokeWidth />
      ) : (
        <FallbackGlyph size={size} />
      )}
    </span>
  );
}
