import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';
import { Icon } from './Icon';
import { Spinner } from './Spinner';
import { cx } from '../util';

/**
 * `accent` and `caution` are the *tinted* pair, for controls that sit on a
 * surface rather than under one.
 *
 * `default` is a grey button on a grey ground: legible on a panel body and
 * invisible inside a table row, because the row's own hover colour is the
 * button's resting colour. The tinted pair carry a coloured border and text
 * over a mix of that colour with the ground, so they read as controls wherever
 * they land, without the weight of the solid `primary`/`danger` fills that
 * belong to a form's commit.
 *
 * `good` is a third tint, in the done green, for a control that finishes
 * something (the tracker's Confirm on an item in review, rag-t0041).
 */
export type ButtonVariant =
  'primary' | 'default' | 'ghost' | 'danger' | 'accent' | 'caution' | 'good';

/** `sm` is shorter than a table row, so a row action has air above and below. */
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], size === 'sm' && styles.small)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size={13} className={styles.buttonSpinner} />}
      <span className={styles.label}>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children' | 'aria-label'
> {
  /** Icon name from the registry — see `icons/registry.ts`. */
  icon: string;
  /** Required accessible name; also the hover title. */
  label: string;
  variant?: ButtonVariant;
  size?: number;
  /** When set, rendered as a toggle button (aria-pressed). */
  pressed?: boolean;
}

export function IconButton({
  icon,
  label,
  variant = 'default',
  size = 16,
  pressed,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(styles.iconButton, styles[variant], pressed === true && styles.pressed)}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
