/**
 * The small pieces the documents pages (m04) are drawn from: a rendered
 * document whose links to other documents stay in the application, a line
 * diff, the Queue / Documents / History switch, and a record's state.
 */

import type { MouseEvent } from 'react';
import { Badge, Icon } from '@rag/ui';
import { Link, useNavigate } from 'react-router';

import { Markdown } from '../markdown/Markdown';
import { cx } from '../util';
import type { DiffRow } from './diff';
import styles from './docs.module.css';
import { docsPath, historyPath, projectPath } from './paths';
import { recordStateLabel, recordStateTone } from './vocab';

export interface DocMarkdownProps {
  project: string;
  /** The rendered document's own path: its relative links resolve from here. */
  path: string;
  source: string;
  className?: string;
}

/**
 * A tracker document, rendered: `att:` images resolved to their attachments,
 * and a link to another document (`[music](m03-music.md)`) resolved to that
 * document's page and opened in place (TC-02).
 *
 * The renderer emits those links as `/projects/…` paths without a target;
 * a plain click on one becomes a router navigation here, so following a link
 * keeps the application (and any draft in another tab) as it is. A modified
 * click (new tab, new window) is left to the browser.
 */
export function DocMarkdown({ project, path, source, className }: DocMarkdownProps) {
  const navigate = useNavigate();
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const anchor = (event.target as Element).closest('a');
    const href = anchor?.getAttribute('href');
    if (href !== null && href !== undefined && href.startsWith(`${projectPath(project)}/doc/`)) {
      event.preventDefault();
      navigate(href);
    }
  };
  return (
    // The click is the anchors' (a keyboard's Enter on a link is a click too);
    // the container only routes it.
    <div onClick={onClick} className={className}>
      <Markdown source={source} attachments documentLinks={{ project, from: path }} />
    </div>
  );
}

export interface LineDiffProps {
  rows: readonly DiffRow[];
  /** Said beside the colours, so the sign is never the only cue. */
  addedLabel?: string;
  deletedLabel?: string;
  label?: string;
}

/**
 * A line diff: additions and deletions coloured **and** signed (`+`, `−`), with
 * a legend in words, folded runs of unchanged lines said as a count.
 */
export function LineDiff({
  rows,
  addedLabel = 'added',
  deletedLabel = 'removed',
  label,
}: LineDiffProps) {
  return (
    <div className={styles.diff}>
      <p className={styles.diffLegend}>
        <span className={styles.legendAdd}>+ {addedLabel}</span>
        <span className={styles.legendDel}>− {deletedLabel}</span>
      </p>
      <ol className={styles.diffRows} aria-label={label ?? 'Line diff'}>
        {rows.map((row, index) => {
          if (row.kind === 'gap') {
            return (
              <li key={index} className={styles.diffGap} data-kind="gap">
                {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
              </li>
            );
          }
          const sign =
            row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : row.kind === 'hunk' ? '' : ' ';
          return (
            <li
              key={index}
              className={cx(styles.diffRow, styles[`diff_${row.kind}`])}
              data-kind={row.kind}
            >
              <span className={styles.diffSign} aria-hidden>
                {sign}
              </span>
              <span className={styles.diffText}>{row.text === '' ? ' ' : row.text}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Which of a project's pages the switch marks as the current one. */
export type ProjectPage = 'queue' | 'docs' | 'history';

/** The Queue / Documents / History switch at the head of a project's pages. */
export function ProjectTabs({ project, active }: { project: string; active: ProjectPage }) {
  const tab = (page: ProjectPage, to: string, icon: string, label: string) => (
    <Link
      to={to}
      className={cx(styles.projectTab, active === page && styles.projectTabActive)}
      aria-current={active === page ? 'page' : undefined}
    >
      <Icon name={icon} size={14} />
      {label}
    </Link>
  );
  return (
    <nav className={styles.projectTabs} aria-label={`${project} pages`}>
      {tab('queue', projectPath(project), 'list-todo', 'Queue')}
      {tab('docs', docsPath(project), 'file-text', 'Documents')}
      {tab('history', historyPath(project), 'history', 'History')}
    </nav>
  );
}

/** A spec's, milestone's or concept's state, in words and a tone. */
export function StateBadge({ state }: { state: string }) {
  return (
    <span className={styles.state} data-state={state}>
      <Badge tone={recordStateTone(state)}>{recordStateLabel(state)}</Badge>
    </span>
  );
}
