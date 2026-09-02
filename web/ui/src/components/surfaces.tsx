import { useId, type KeyboardEvent, type ReactNode } from 'react';
import styles from './surfaces.module.css';
import { Icon } from './Icon';
import { cx } from '../util';

/** A titled content box. */
export interface CardProps {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, children, className }: CardProps) {
  return (
    <section className={cx(styles.card, className)}>
      {title !== undefined && <h3 className={styles.cardTitle}>{title}</h3>}
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

export interface PanelProps {
  header?: ReactNode;
  /** Controls rendered on the right of the header. */
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  /**
   * Keep this panel's header on screen for as long as any of the panel is.
   *
   * **The case it answers is a panel whose controls have outrun its name**: a
   * tall form puts its submit button on the glass while the only text saying
   * which form it belongs to is a screen above. The reader sees a button and
   * cannot see what it will write.
   *
   * `position: sticky` keys off the panel's own box, never off a viewport
   * width, which is why this is a flag rather than a measurement: a panel that
   * fits the space it is read in never scrolls its own header out, so nothing
   * sticks and nothing moves. Opt-in, because pinning the header of a table
   * would be a change to every page on behalf of a complaint nobody made.
   */
  stickyHeader?: boolean;
  className?: string;
}

export function Panel({
  header,
  actions,
  children,
  padded = true,
  stickyHeader = false,
  className,
}: PanelProps) {
  return (
    <section className={cx(styles.panel, stickyHeader && styles.panelFollows, className)}>
      {(header !== undefined || actions !== undefined) && (
        <header className={cx(styles.panelHeader, stickyHeader && styles.panelHeaderFollows)}>
          <div className={styles.panelTitle}>{header}</div>
          {actions !== undefined && <div className={styles.panelActions}>{actions}</div>}
        </header>
      )}
      <div className={cx(styles.panelBody, padded && styles.padded)}>{children}</div>
    </section>
  );
}

export interface DisclosureProps {
  title: ReactNode;
  /** Shown whether the section is open or shut — it is what says why. */
  description?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * A titled section that folds away.
 *
 * **Controlled, with no internal state at all.** A fold that remembered its own
 * open-ness would be unopenable from outside, and the caller that needs to open
 * one is the caller that has just found a validation error inside it — a
 * reader staring at a form that will not save, with the cause folded out of
 * sight, is the failure this component exists to not cause.
 *
 * **Shut means not rendered**, rather than rendered and hidden. A collapsed
 * section is not merely invisible: nothing inside it should be fetching a
 * picker's options or holding a half-typed value.
 */
export function Disclosure({
  title,
  description,
  open,
  onToggle,
  children,
  className,
}: DisclosureProps) {
  const bodyId = useId();
  return (
    <section className={cx(styles.disclosure, className)}>
      <h3 className={styles.disclosureHeading}>
        <button
          type="button"
          className={styles.disclosureToggle}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => onToggle(!open)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          <span>{title}</span>
        </button>
      </h3>
      {description !== undefined && <p className={styles.disclosureNote}>{description}</p>}
      {open && (
        <div id={bodyId} className={styles.disclosureBody}>
          {children}
        </div>
      )}
    </section>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** Accessible name for the tab list. */
  label?: string;
}

export function Tabs({ tabs, active, onChange, label }: TabsProps) {
  const baseId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === active);
    if (index === -1) {
      return;
    }
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next !== undefined) {
      onChange(next.id);
      document.getElementById(`${baseId}-${next.id}`)?.focus();
    }
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`${baseId}-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cx(styles.tab, selected && styles.tabActive)}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
