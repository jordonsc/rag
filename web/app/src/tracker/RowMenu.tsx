import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, IconButton } from '@rag/ui';

import { cx } from '../util';
import styles from './tracker.module.css';

export interface RowMenuAction {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface RowMenuProps {
  /** The menu button's accessible name: say whose menu it is. */
  label: string;
  actions: readonly RowMenuAction[];
}

const MENU_WIDTH = 208;

/**
 * A row's action menu: Open, Move to top, Move to bottom, Defer, Remove.
 *
 * The keyboard and touch route to every reordering a drag can do (TD-04), so
 * it has to be reachable without a pointer: a real button, a `menu` of
 * `menuitem`s, arrow keys between them, Escape back to the button.
 *
 * **Drawn through a portal, fixed to the button.** The queue sits in a panel
 * that clips its children to its rounded corners, and a menu opened on the last
 * row would be cut off by its own panel.
 */
export function RowMenu({ label, actions }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const id = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      anchor.current?.querySelector('button')?.focus();
    }
  };

  useLayoutEffect(() => {
    if (!open || anchor.current === null) {
      return;
    }
    const rect = anchor.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 0;
    const below = rect.bottom + 4;
    const top =
      below + height > window.innerHeight && rect.top - height - 4 > 0
        ? rect.top - height - 4
        : below;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setPosition({ top, left });
    menu.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && !menu.current?.contains(target) && !anchor.current?.contains(target)) {
        setOpen(false);
      }
    };
    const away = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [open]);

  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    // The row moves on Alt+arrows; nothing here may reach it.
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <span ref={anchor} className={styles.menuAnchor}>
      <IconButton
        icon="ellipsis"
        label={label}
        variant="ghost"
        size={16}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((was) => !was)}
      />
      {open &&
        createPortal(
          <ul
            ref={menu}
            id={id}
            role="menu"
            aria-label={label}
            className={styles.menu}
            style={{
              width: MENU_WIDTH,
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
            }}
            onKeyDown={onKey}
          >
            {actions.map((action) => (
              <li key={action.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={cx(styles.menuItem, action.danger === true && styles.menuDanger)}
                  disabled={action.disabled}
                  onClick={() => {
                    close(false);
                    action.onSelect();
                  }}
                >
                  <Icon name={action.icon} size={14} />
                  <span>{action.label}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </span>
  );
}
