import styles from './Spinner.module.css';
import { useT } from '../i18n';
import { cx } from '../util';

export interface SpinnerProps {
  size?: number;
  /** Accessible label; defaults to the catalogue's loading message. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const t = useT();
  return (
    <span
      role="status"
      aria-label={label ?? t('common.loading')}
      className={cx(styles.spinner, className)}
      style={{ width: size, height: size }}
    />
  );
}
