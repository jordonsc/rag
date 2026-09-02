import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { enGB, type Catalogue, type MessageKey } from './en-GB';
import {
  DEFAULT_LOCALE,
  formatDuration,
  formatDurationSeconds,
  formatNumber,
  formatStamp,
} from './format';

export { enGB } from './en-GB';
export type { Catalogue, MessageKey } from './en-GB';
export {
  DEFAULT_LOCALE,
  formatDuration,
  formatDurationSeconds,
  formatNumber,
  formatStamp,
  type DurationLabels,
} from './format';

// The context defaults to the en-GB catalogue, so components (and tests) work
// without a provider; I18nProvider exists to override messages when further
// locales arrive — adding one is translation work, not engineering.
const I18nContext = createContext<Catalogue>(enGB);

// The locale is a *separate* context from the catalogue on purpose. Which
// words are shown and how a number is punctuated move independently: a build
// serving en-GB strings to a machine set to de-DE should still group thousands
// the way that person reads them, and pinning the two together would make
// that a translation problem rather than a setting.
const LocaleContext = createContext<string>(DEFAULT_LOCALE);

export interface I18nProviderProps {
  children: ReactNode;
  /** Overrides merged over the en-GB catalogue. */
  messages?: Partial<Catalogue>;
  /** BCP 47 tag the platform formatters resolve against. */
  locale?: string;
}

export function I18nProvider({ children, messages, locale = DEFAULT_LOCALE }: I18nProviderProps) {
  const merged = useMemo<Catalogue>(() => ({ ...enGB, ...messages }), [messages]);
  return (
    <LocaleContext.Provider value={locale}>
      <I18nContext.Provider value={merged}>{children}</I18nContext.Provider>
    </LocaleContext.Provider>
  );
}

/** The BCP 47 tag in force. */
export function useLocale(): string {
  return useContext(LocaleContext);
}

export interface Formatters {
  /** A quantity, with the locale's group separators. */
  number: (value: number) => string;
  /** A length of time in milliseconds, as two human units. */
  duration: (millis: number) => string;
  /** A length of time stated in whole seconds. */
  durationSeconds: (seconds: number) => string;
  /** An instant, as a person reads it. */
  stamp: (at: Date | string | number) => string;
}

/**
 * The locale's formatters, with the catalogue's phrasing already bound in.
 *
 * A renderer should never reach for `Intl` itself: doing so either hard-codes
 * a locale or reads the browser's, and neither is the one this provider names.
 */
export function useFormat(): Formatters {
  const locale = useLocale();
  const t = useT();
  return useMemo<Formatters>(() => {
    const labels = { moment: t('format.duration.moment') };
    return {
      number: (value) => formatNumber(value, locale),
      duration: (millis) => formatDuration(millis, locale, labels),
      durationSeconds: (seconds) => formatDurationSeconds(seconds, locale, labels),
      stamp: (at) => formatStamp(at, locale),
    };
  }, [locale, t]);
}

export type TranslateParams = Record<string, string | number>;

/**
 * `t('key', {param})` — `{param}` placeholders are interpolated; a missing
 * key falls back to the key itself (visible, greppable, never a crash).
 */
export type Translate = (key: MessageKey | (string & {}), params?: TranslateParams) => string;

export function useT(): Translate {
  const messages = useContext(I18nContext);
  return useCallback<Translate>(
    (key, params) => {
      const template = (messages as Record<string, string>)[key] ?? key;
      if (params === undefined) {
        return template;
      }
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match,
      );
    },
    [messages],
  );
}
