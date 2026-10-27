import { useMemo } from 'react';

import { cx } from '../util';
import { renderMarkdown, type DocumentLinks } from './render';
import styles from './markdown.module.css';

export interface MarkdownProps {
  /** The Markdown source. Untrusted — see `render.ts`. */
  source: string;
  className?: string;
  /** Resolve `att:` references to tracker attachments. Off for ledger prose. */
  attachments?: boolean;
  /**
   * Resolve links to other tracker documents from this one (`render.ts`).
   * Off for everything but a tracker document.
   */
  documentLinks?: DocumentLinks;
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
export function Markdown({ source, className, attachments = false, documentLinks }: MarkdownProps) {
  const project = documentLinks?.project;
  const from = documentLinks?.from;
  const html = useMemo(
    () =>
      renderMarkdown(source, {
        attachments,
        ...(project === undefined || from === undefined
          ? {}
          : { documentLinks: { project, from } }),
      }),
    [source, attachments, project, from],
  );
  // One object per distinct string. React 19 compares this prop by identity,
  // so a fresh `{ __html }` on every render rewrites the element's whole
  // subtree each time the parent renders: a link under the reader's pointer
  // is replaced between press and release, and the click never lands.
  const inner = useMemo(() => ({ __html: html }), [html]);
  return <div className={cx(styles.prose, className)} dangerouslySetInnerHTML={inner} />;
}
