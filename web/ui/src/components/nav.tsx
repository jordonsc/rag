import type { ReactNode } from 'react';
import styles from './nav.module.css';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { Tooltip } from './overlays';
import { cx } from '../util';

export interface NavRailItem {
  id: string;
  /** Icon name from the registry — see `icons/registry.ts`. */
  icon: string;
  /**
   * What the destination **is**. The button's accessible name, and the
   * emphasised first line of its hover hint.
   */
  title: string;
  /**
   * What the destination is **for**, drawn beneath the title in the hint.
   *
   * Two fields rather than one collapsed label: a tip that explains a page
   * without naming it reads as an unattributed sentence over an icon nobody
   * recognises yet. An item with no hint gets a tip carrying its title alone —
   * not the title twice.
   */
  hint?: string;
}

export interface NavRailProps {
  items: readonly NavRailItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  /** Accessible name for the rail. */
  label: string;
}

/** The vertical icon rail down the left edge. */
export function NavRail({ items, activeId, onSelect, label }: NavRailProps) {
  return (
    <nav className={styles.rail} aria-label={label}>
      <ul className={styles.railList}>
        {items.map((item) => (
          <li key={item.id}>
            {/* The rail is pinned to the left edge, so a tooltip centred
                beneath its icon would hang off the viewport. */}
            <Tooltip
              title={item.hint === undefined ? undefined : item.title}
              text={item.hint ?? item.title}
              placement="right"
            >
              <button
                type="button"
                className={cx(styles.railButton, item.id === activeId && styles.active)}
                aria-label={item.title}
                aria-current={item.id === activeId ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
              >
                <Icon name={item.icon} size={20} />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface TopNavItem {
  id: string;
  /** Icon name from the registry — see `icons/registry.ts`. */
  icon: string;
  label: string;
}

export interface TopNavProps {
  /** Leading chrome — a product mark, or a menu button on a narrow layout. */
  start?: ReactNode;
  /** The destinations, in a stable order. */
  items?: readonly TopNavItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /**
   * When provided, renders a trailing "+" button. `actionLabel` is its
   * accessible name, so a caller that wants one must say what it does.
   */
  onAction?: () => void;
  actionLabel?: string;
  /** Right-aligned chrome. */
  end?: ReactNode;
  /** Accessible name for the destination list. */
  label?: string;
}

/**
 * The top bar: leading chrome, one button per destination (the selected one
 * shows icon + label, the others icon-only with a tooltip), right-aligned
 * chrome.
 */
export function TopNav({
  start,
  items = [],
  activeId,
  onSelect,
  onAction,
  actionLabel,
  end,
  label,
}: TopNavProps) {
  return (
    <header className={styles.topNav}>
      {start}
      <nav className={styles.items} aria-label={label}>
        {items.map((item) => {
          const active = item.id === activeId;
          const button = (
            <button
              type="button"
              className={cx(styles.itemButton, active && styles.active)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect?.(item.id)}
            >
              <span className={styles.itemIcon}>
                <Icon name={item.icon} size={18} />
              </span>
              {active && <span className={styles.itemLabel}>{item.label}</span>}
            </button>
          );
          return active ? (
            <span key={item.id}>{button}</span>
          ) : (
            <Tooltip key={item.id} text={item.label}>
              {button}
            </Tooltip>
          );
        })}
        {onAction !== undefined && actionLabel !== undefined && (
          <IconButton icon="plus" label={actionLabel} variant="ghost" onClick={onAction} />
        )}
      </nav>
      <div className={styles.end}>{end}</div>
    </header>
  );
}
