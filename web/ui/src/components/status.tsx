import type { ReactNode } from 'react';
import styles from './status.module.css';
import { Button } from './Button';
import { Icon } from './Icon';
import { useT } from '../i18n';
import { cx } from '../util';

/**
 * The five colour roles anything status-shaped is drawn in.
 *
 * Deliberately not a vocabulary of *meanings* — nothing in this package knows
 * what a ledger topic's status is, and it should not. The surface rendering a
 * badge or a dot maps its own vocabulary onto a tone.
 */
export type Tone = 'neutral' | 'acc' | 'good' | 'warn' | 'crit';

export type BadgeTone = Tone;

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span className={cx(styles.badge, styles[`badge_${tone}`])}>{children}</span>;
}

export interface StateDotProps {
  /** The state as a reader sees it. Always rendered, as text or as aria-label. */
  label: string;
  tone?: Tone;
  /**
   * Draw as a filled pill rather than a dot beside text.
   *
   * For the state that must read as worse than the rest — one that needs a
   * person rather than a retry. A pill at `crit` carries more weight than a
   * red dot, and adds an icon so the meaning is not colour alone.
   */
  emphasis?: boolean;
  /** Hide the text label (an aria-label + title still carry it). */
  showLabel?: boolean;
  /** Machine-readable state, exposed as `data-state` for styling and tests. */
  state?: string;
}

/**
 * A state indicator: a coloured dot and its label.
 *
 * **Status is never colour alone.** Label text — or, when hidden, an
 * `aria-label` and a `title` — always accompanies the colour.
 */
export function StateDot({
  label,
  tone = 'neutral',
  emphasis = false,
  showLabel = true,
  state,
}: StateDotProps) {
  const aria = showLabel ? {} : ({ 'aria-label': label } as const);
  const data = state ?? label;

  if (emphasis) {
    return (
      <span
        className={cx(styles.stateDot, styles.emphasis, styles[`dot_${tone}`])}
        data-state={data}
        data-tone={tone}
        title={label}
        {...aria}
      >
        <Icon name="octagon-alert" size={11} />
        {showLabel && <span className={styles.stateLabel}>{label}</span>}
      </span>
    );
  }

  return (
    <span
      className={cx(styles.stateDot, styles[`dot_${tone}`])}
      data-state={data}
      data-tone={tone}
      title={label}
      {...aria}
    >
      <span className={styles.dot} aria-hidden />
      {showLabel && <span className={styles.stateLabel}>{label}</span>}
    </span>
  );
}

/** The severity vocabulary a message can carry. */
export type Severity = 'info' | 'warning' | 'critical';

/**
 * A severity as it arrives from a caller, which may name one **this build does
 * not know**.
 *
 * Open at the edge on purpose: an unrecognised token is shown as itself rather
 * than coerced onto `info` (which would state a severity nobody claimed) or
 * dropped (which loses the message with it).
 */
export type SeverityToken = Severity | (string & {});

const severityIconNames: Record<Severity, string> = {
  info: 'info',
  warning: 'triangle-alert',
  critical: 'octagon-alert',
};

/** The severities this build has an icon and a colour for. */
export function isKnownSeverity(severity: SeverityToken): severity is Severity {
  return severity in severityIconNames;
}

export interface SeverityIconProps {
  severity: SeverityToken;
  size?: number;
  /** Also render the severity as text beside the icon. */
  showLabel?: boolean;
}

export function SeverityIcon({ severity, size = 16, showLabel = false }: SeverityIconProps) {
  const t = useT();
  const known = isKnownSeverity(severity);
  const label = known ? t(`severity.${severity}`) : severity;
  return (
    <span
      className={known ? cx(styles.severity, styles[severity]) : styles.severity}
      data-severity={severity}
    >
      <Icon name={known ? severityIconNames[severity] : 'circle-help'} size={size} label={label} />
      {showLabel && <span>{label}</span>}
    </span>
  );
}

export interface EmptyStateProps {
  icon?: string;
  title?: ReactNode;
  message?: ReactNode;
}

export function EmptyState({ icon, title, message }: EmptyStateProps) {
  const t = useT();
  return (
    <div className={styles.stateBlock}>
      {icon !== undefined && <Icon name={icon} size={28} className={styles.stateIcon} />}
      <p className={styles.stateTitle}>{title ?? t('common.empty')}</p>
      {message !== undefined && <p className={styles.stateMessage}>{message}</p>}
    </div>
  );
}

export interface ErrorStateProps {
  /** The stated fault — the error the request came back with. */
  message?: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
}

/** Degraded behaviour is a first-class case: say what is wrong, offer retry. */
export function ErrorState({ message, detail, onRetry }: ErrorStateProps) {
  const t = useT();
  return (
    <div className={styles.stateBlock} role="alert">
      <Icon name="triangle-alert" size={28} className={cx(styles.stateIcon, styles.errorIcon)} />
      <p className={styles.stateTitle}>{message ?? t('common.error')}</p>
      {detail !== undefined && <p className={styles.stateMessage}>{detail}</p>}
      {onRetry !== undefined && (
        <Button onClick={onRetry} variant="default">
          {t('action.retry')}
        </Button>
      )}
    </div>
  );
}
