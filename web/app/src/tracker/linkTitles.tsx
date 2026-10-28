import { useEffect, useState } from 'react';

import { asApiError, getTopic, isAbort } from '../api';
import { getConcept, getItem, getMilestone, getSpec } from './api';
import styles from './item.module.css';
import type { Link } from './types';

/**
 * What a link's target is called, read from its own record (rag-t0046).
 *
 * `loading` until its read answers; `ready` with the title (and, for a ledger
 * id retired by a move, the id it now lives at; for a milestone, its document's
 * path, which is what its link opens); `missing` when the target does not exist
 * (404, or a move whose new id does not); `failed` when the read failed for any
 * other reason.
 */
export type LinkTitle =
  | { state: 'loading' }
  | { state: 'ready'; title: string; movedTo?: string; path?: string }
  | { state: 'missing'; movedTo?: string }
  | { state: 'failed' };

/** One link's key in the map [`useLinkTitles`] returns. */
export function linkKey(link: Link): string {
  return `${link.kind}:${link.target}`;
}

/** At most this many moves are followed, so a pointer loop cannot spin. */
const MOVE_HOPS = 3;

/** A ledger topic's title, following a moved id to where its content lives. */
async function topicTitle(id: string, signal: AbortSignal): Promise<LinkTitle> {
  let at = id;
  let movedTo: string | undefined;
  for (let hop = 0; hop <= MOVE_HOPS; hop += 1) {
    let fetched;
    try {
      fetched = await getTopic(at, signal);
    } catch (error) {
      if (movedTo !== undefined && !isAbort(error) && asApiError(error).status === 404) {
        return { state: 'missing', movedTo };
      }
      throw error;
    }
    if (fetched.kind === 'topic') {
      return movedTo === undefined
        ? { state: 'ready', title: fetched.record.title }
        : { state: 'ready', title: fetched.record.title, movedTo };
    }
    at = fetched.pointer.moved_to;
    movedTo = at;
  }
  return movedTo === undefined ? { state: 'failed' } : { state: 'missing', movedTo };
}

/**
 * Read one link's target. `project` is the linking item's: a spec, milestone
 * or concept link names a slug inside it, as `linkHref` reads them.
 */
async function readTitle(project: string, link: Link, signal: AbortSignal): Promise<LinkTitle> {
  switch (link.kind) {
    case 'ledger':
      return topicTitle(link.target, signal);
    case 'item':
    case 'from':
    case 'became':
      return {
        state: 'ready',
        title: (await getItem(link.target, { history: false }, signal)).title,
      };
    case 'spec':
      return { state: 'ready', title: (await getSpec(project, link.target, signal)).title };
    case 'concept':
      return { state: 'ready', title: (await getConcept(project, link.target, signal)).title };
    case 'milestone': {
      const [spec, code, ...rest] = link.target.split('/');
      if (spec === undefined || spec === '' || code === undefined || code === '' || rest.length) {
        return { state: 'missing' };
      }
      const milestone = await getMilestone(project, spec, code, signal);
      return { state: 'ready', title: milestone.title, path: milestone.path };
    }
    default:
      return { state: 'failed' };
  }
}

/**
 * The titles of `links`' targets (rag-t0046), keyed by [`linkKey`].
 *
 * Every target is read at once, in parallel, and each title lands as its own
 * read answers, so one slow or failing target holds up none of the others.
 * The reads are keyed on the links themselves, not on the record carrying
 * them: a re-read after a write that leaves the links alone keeps the titles
 * already on screen instead of blanking and refetching them.
 */
export function useLinkTitles(project: string, links: readonly Link[]): Record<string, LinkTitle> {
  const [titles, setTitles] = useState<Record<string, LinkTitle>>({});
  const wanted = [...new Set(links.map(linkKey))].sort().join('\n');

  useEffect(() => {
    const controller = new AbortController();
    const keys = wanted === '' ? [] : wanted.split('\n');
    setTitles(Object.fromEntries(keys.map((key) => [key, { state: 'loading' } as LinkTitle])));
    for (const key of keys) {
      const split = key.indexOf(':');
      const link = { kind: key.slice(0, split), target: key.slice(split + 1) } as Link;
      readTitle(project, link, controller.signal)
        .then((title) => setTitles((known) => ({ ...known, [key]: title })))
        .catch((error: unknown) => {
          if (isAbort(error)) {
            return;
          }
          const missing = asApiError(error).status === 404;
          setTitles((known) => ({ ...known, [key]: { state: missing ? 'missing' : 'failed' } }));
        });
    }
    return () => controller.abort();
  }, [project, wanted]);

  return titles;
}

/**
 * A link target's title, beside its id (rag-t0046).
 *
 * The span is there from the first paint, holding one line, so a title that
 * arrives later fills a slot that is already laid out: it is one line, cut
 * with an ellipsis (the whole title is its tooltip), and it never moves what
 * is under it. A target that cannot be read says so, muted.
 */
export function LinkTitleText({ title }: { title: LinkTitle | undefined }) {
  if (title === undefined || title.state === 'loading') {
    return (
      <span className={styles.linkTitle} aria-busy="true">
        {' '}
      </span>
    );
  }
  if (title.state === 'ready') {
    return (
      <span className={styles.linkTitle} title={title.title}>
        {title.title}
        {title.movedTo !== undefined && (
          <span className={styles.linkTitleNote}> · moved to {title.movedTo}</span>
        )}
      </span>
    );
  }
  const text =
    title.state === 'missing'
      ? title.movedTo === undefined
        ? 'Not found'
        : `Moved to ${title.movedTo}, not found`
      : 'Title unavailable';
  return <span className={`${styles.linkTitle} ${styles.linkTitleMissing}`}>{text}</span>;
}
