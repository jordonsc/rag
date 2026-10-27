/**
 * The tracker's pages, as addresses, and the one place each is built.
 *
 * **Not under `/tracker/`.** That prefix is the API's, and `rag-serve` never
 * falls back to the single-page app on an API path, so a browser navigating to
 * `/tracker/ubu` would get the queue view's JSON (api.md § *Web UI paths*,
 * ledger rag-0035). The pages are:
 *
 * | Page | Path |
 * |---|---|
 * | the project list | `/projects` |
 * | the dashboard (D14) | `/projects/{project}` |
 * | an item (D15) | `/projects/{project}/item/{id}` |
 * | the documents page (D16, m04) | `/projects/{project}/docs` |
 * | a document (m04) | `/projects/{project}/doc/{path…}` |
 * | the history: done, cancelled and failed items (rag-t0008) | `/projects/{project}/history` |
 *
 * Every segment is encoded, as `topicPath` encodes a topic id: a project or an
 * id this application did not mint may carry a character that changes what
 * the path means.
 */

import { topicPath } from '../ledger/ids';
import type { Link } from './types';

const enc = encodeURIComponent;

export const PROJECTS_PATH = '/projects';

export function projectPath(project: string): string {
  return `${PROJECTS_PATH}/${enc(project)}`;
}

export function itemPath(project: string, id: string): string {
  return `${projectPath(project)}/item/${enc(id)}`;
}

/** The documents page (m04). */
export function docsPath(project: string): string {
  return `${projectPath(project)}/docs`;
}

/** The history page: the project's done, cancelled and failed items (rag-t0008). */
export function historyPath(project: string): string {
  return `${projectPath(project)}/history`;
}

/** A document by its path within the project (m04); `/` is kept as `/`. */
export function docPath(project: string, path: string): string {
  return `${projectPath(project)}/doc/${path.split('/').map(enc).join('/')}`;
}

/** Where **New concept** writes (m04, TC-01). */
export function newConceptPath(project: string): string {
  return `${docsPath(project)}/new`;
}

// ---- Links between documents ------------------------------------------------

/**
 * A document path segment (api.md § Names): ASCII letters, digits, `.`, `_`
 * and `-` (`\w` without the `u` flag is exactly the first three). `.` and `..`
 * are handled before it is asked.
 */
const DOC_SEGMENT = /^[\w.-]+$/;

/**
 * The top-level folders of a project's documents (D4). A link that starts
 * with one is read from the project's root, as the repository's own files
 * wrote them (`specs/audio/m03-music.md` in a CLAUDE.md), not from the folder
 * of the document it is in.
 */
const DOC_ROOTS = ['specs', 'concepts'];

/**
 * The project path a link inside a document points at, or `null` when it is
 * not a link to another document.
 *
 * A link is a document link when it has no scheme and no host, and its path
 * ends in `.md`. It is resolved as the repository resolved it:
 *
 * * `/specs/x/master.md` — from the project's root;
 * * `specs/x/master.md`, `concepts/y.md` — from the root too (see `DOC_ROOTS`);
 * * anything else (`m03-music.md`, `../audio/master.md`) — from the folder of
 *   the document it is in (`from`).
 *
 * A path that climbs above the root, or holds a character a document path
 * may not, is not a document link: it stays as written.
 */
export function resolveDocLink(
  from: string,
  href: string,
): { path: string; fragment: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return null;
  }
  const hash = href.indexOf('#');
  const fragment = hash === -1 ? '' : href.slice(hash);
  let target = hash === -1 ? href : href.slice(0, hash);
  if (target.includes('?')) {
    return null;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (!/\.md$/i.test(target)) {
    return null;
  }
  let base: string[];
  if (target.startsWith('/')) {
    base = [];
    target = target.slice(1);
  } else if (DOC_ROOTS.includes(target.split('/')[0] ?? '')) {
    base = [];
  } else {
    base = from.split('/').slice(0, -1);
  }
  const out = [...base];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    if (!DOC_SEGMENT.test(segment)) {
      return null;
    }
    out.push(segment);
  }
  const path = out.join('/');
  return path === '' || path.length > 300 ? null : { path, fragment };
}

/**
 * A slug from a title: lowercase letters, digits and `-` (api.md § Names),
 * as the server slugifies a milestone's name.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Whether a slug is one the server accepts. */
export function isSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/** Said under a rename's path when the server would refuse it (api.md § Names). */
export const DOC_PATH_RULE =
  'A relative path of letters, digits, “.”, “_” and “-” segments, ending in .md (at most 300 characters).';

/**
 * Whether a document path is one the server accepts (api.md § Names, the
 * store's `validate_path`): relative, `/`-separated segments of ASCII letters,
 * digits, `.`, `_` and `-` (never `.` or `..`, never empty), ending in `.md`,
 * at most 300 characters.
 */
export function isDocPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    path.endsWith('.md') &&
    path
      .split('/')
      .every((segment) => segment !== '.' && segment !== '..' && DOC_SEGMENT.test(segment))
  );
}

/**
 * The project an item id belongs to: everything before the final `-t`.
 *
 * Item ids are `<project>-t<seq:04>`, and a project name may hold hyphens of
 * its own, so the split is at the last `-t` followed by digits.
 */
export function itemProject(id: string): string | null {
  const match = /^(.+)-t[0-9]{4,}$/.exec(id);
  return match === null ? null : match[1]!;
}

/**
 * Where a link chip goes, or `null` when it has nowhere to go yet.
 *
 * A milestone's document path holds its name (`specs/<spec>/<code>-<name>.md`),
 * which the link does not carry, so it resolves through `resolved` (the path a
 * caller looked up) and is otherwise not a link.
 */
export function linkHref(project: string, link: Link, resolved?: string): string | null {
  switch (link.kind) {
    case 'ledger':
      return topicPath(link.target);
    case 'item': {
      const owner = itemProject(link.target);
      return owner === null ? null : itemPath(owner, link.target);
    }
    case 'spec':
      return docPath(project, `specs/${link.target}/master.md`);
    case 'concept':
      return docPath(project, `concepts/${link.target}.md`);
    case 'milestone':
      return resolved === undefined ? null : docPath(project, resolved);
    default:
      return null;
  }
}

const ATTACHMENT_REF = /^(?:att:)?([0-9a-f]{12,64})$/i;

/**
 * The URL of an attachment, from an `att:` reference, a full sha256 or a
 * prefix of at least 12 hex characters. `null` for anything else, so a
 * malformed reference never becomes a request.
 */
export function attachmentUrl(ref: string): string | null {
  const match = ATTACHMENT_REF.exec(ref.trim());
  return match === null ? null : `/tracker/attachments/${match[1]!.toLowerCase()}`;
}

// ---- The last project used --------------------------------------------------

const STORAGE_KEY = 'rag.tracker.project';

/**
 * The project the reader last opened, or `null`.
 *
 * Guarded as `identity/storage.ts` guards the email: `localStorage` throws
 * rather than returning undefined when a browser refuses site data, and a
 * preference that cannot be remembered degrades to no preference.
 */
export function readLastProject(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null || stored === '' ? null : stored;
  } catch {
    return null;
  }
}

export function storeLastProject(project: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, project);
  } catch {
    // Storage refused: the picker still works, it just will not remember.
  }
}
