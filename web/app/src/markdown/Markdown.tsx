import { useMemo } from 'react';

import { cx } from '../util';
import { renderMarkdown } from './render';
import styles from './markdown.module.css';

export interface MarkdownProps {
  /** The Markdown source. Untrusted — see `render.ts`. */
  source: string;
  className?: string;
}

/**
 * Rendered ledger prose.
 *
 * `dangerouslySetInnerHTML` is the whole point of the component: it is the one
 * call site in the application, and the string reaching it has been through
 * `renderMarkdown` and therefore through DOMPurify. Nothing else may set inner
 * HTML — a grep for `dangerouslySetInnerHTML` should return this file and
 * nothing else, which is what makes the guarantee checkable rather than
 * asserted.
 */
export function Markdown({ source, className }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={cx(styles.prose, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
