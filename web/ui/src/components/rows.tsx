import type { ReactNode } from 'react';
import styles from './rows.module.css';
import { Icon } from './Icon';
import { cx } from '../util';

export interface RowIdentityProps {
  /**
   * The row's glyph, named in the icon registry (`../icons/registry`). A name
   * the registry does not hold renders the generic circle rather than nothing:
   * an icon is never the reason a row fails to draw.
   */
  icon?: string;
  /** Accessible name for the glyph. Without one it is decorative. */
  iconLabel?: string;
  /** What the row is, drawn bright and given the row's spare width. */
  name: ReactNode;
  /** The quieter second line beneath the name — an address, a kind, an id. */
  secondary?: ReactNode;
  className?: string;
}

/**
 * The identity of a row: a glyph, a name, and a quieter second line.
 *
 * It is the one part of a row drawn as the *subject* rather than as a
 * property. Without it a table is a run of equal grey columns and nothing on
 * the row says which of them the row is *about*.
 *
 * Only the name is required. A row with no glyph and no second line renders as
 * one bright, ellipsised line.
 */
export function RowIdentity({ icon, iconLabel, name, secondary, className }: RowIdentityProps) {
  return (
    <span className={cx(styles.identity, className)}>
      {icon !== undefined && (
        <Icon name={icon} size={16} label={iconLabel} className={styles.identityIcon} />
      )}
      <span className={styles.identityText}>
        <span className={styles.identityName}>{name}</span>
        {secondary !== undefined && secondary !== '' && (
          <span className={styles.identitySecondary}>{secondary}</span>
        )}
      </span>
    </span>
  );
}
