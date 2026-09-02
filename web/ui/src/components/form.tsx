import {
  cloneElement,
  isValidElement,
  useId,
  type FormHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import styles from './form.module.css';
import { cx } from '../util';

export interface FieldProps {
  label: ReactNode;
  /** Help text below the control. */
  help?: ReactNode;
  /** Error text; also marks the control aria-invalid. */
  error?: ReactNode;
  /** Explicit control id; generated when omitted. */
  id?: string;
  children: ReactNode;
}

/**
 * Label + control + help + error. When the child is a single element, the
 * control id, aria-describedby and aria-invalid are injected into it.
 */
export function Field({ label, help, error, id: idProp, children }: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const helpId = help !== undefined ? `${id}-help` : undefined;
  const errorId = error !== undefined ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-describedby': describedBy,
        ...(error !== undefined ? { 'aria-invalid': true } : {}),
      })
    : children;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {control}
      {help !== undefined && (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface FieldsetProps {
  legend: ReactNode;
  children: ReactNode;
}

/** A titled group of related fields. */
export function Fieldset({ legend, children }: FieldsetProps) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.fieldsetBody}>{children}</div>
    </fieldset>
  );
}

export interface FormProps extends Omit<
  FormHTMLAttributes<HTMLFormElement>,
  'onSubmit' | 'className'
> {
  onSubmit?: () => void;
  children: ReactNode;
  /** Action buttons rendered in a trailing row. */
  actions?: ReactNode;
}

export function Form({ onSubmit, children, actions, ...rest }: FormProps) {
  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
      {...rest}
    >
      {children}
      {actions !== undefined && <div className={cx(styles.actions)}>{actions}</div>}
    </form>
  );
}
