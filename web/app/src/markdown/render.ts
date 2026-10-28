/**
 * The **only** place agent-written text becomes HTML.
 *
 * Everything a ledger record carries as prose — an event body, a topic's
 * `summary`, its `current_state`, the state an event installed — is Markdown
 * written by whatever client wrote it. Rendering it means turning a string
 * somebody else authored into DOM, which is the single point in this
 * application where that text stops being inert. So there is one module, one
 * function, and one thing to audit.
 *
 * **One function is meant literally.** This module also carried a
 * `renderMarkdownInline` for a single-line fragment, which nothing ever called
 * — a second render path (`md.renderInline` parses by different rules) that was
 * exercised only by its own tests. An audit of "the place untrusted text
 * becomes DOM" that has to consider a code path the application never takes is
 * a worse audit, and an uncalled export is a ready-made call site for somebody
 * who has not read this comment. Restore it only alongside a caller.
 *
 * **Why the sanitiser is here even though the parser is already locked down.**
 * `markdown-it` is configured with `html: false`, so raw HTML in the source is
 * escaped rather than passed through, and on that basis DOMPurify is
 * redundant. It runs anyway, on every string, without exception:
 *
 * * The ledger endpoint has **no authentication**. Any client on the LAN can
 *   write any body under any author's name. The content is therefore untrusted
 *   in the strict sense — not "written by us and probably fine".
 * * `html: false` is one option on one constructor call. A future edit that
 *   enables it for one legitimate-sounding reason would silently remove the
 *   only defence, and nothing would fail to compile or fail a test.
 * * Sanitising costs microseconds against a network round trip that costs
 *   hundreds of milliseconds.
 *
 * Two independent barriers, either of which alone would do. Neither is to be
 * removed as "duplication" — the duplication is the design.
 */

import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

import { docPath, resolveDocLink } from '../tracker/paths';

const md = new MarkdownIt({
  // The load-bearing option. Raw HTML in the source is escaped and shown as
  // text rather than parsed. See the note above before ever changing it.
  html: false,
  // Bare URLs become links. Ledger prose is full of them and a reader should
  // not have to select-and-copy an address out of a paragraph.
  linkify: true,
  // Standard Markdown paragraph behaviour: a single newline reflows, a blank
  // line starts a paragraph. Not `true` — agents hard-wrap prose, and turning
  // every wrap into a `<br>` would freeze someone else's line length into ours.
  breaks: false,
  typographer: false,
});

/**
 * External links open in a new tab, and cannot reach back through `opener`.
 *
 * Registered on the module's singleton so it applies to every call, and set in
 * an `afterSanitizeAttributes` hook rather than by post-processing the HTML
 * string: the hook sees a parsed element, so there is no second pass over
 * markup with a regular expression — which is the class of code this module
 * exists to avoid.
 */
/** Where a tracker document's page lives: see the document-link rewrite below. */
const DOCUMENT_PAGES = '/projects';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    // A link to another tracker document stays in this tab: it is a page of
    // this application, and the caller turns the click into a navigation.
    if (node.getAttribute('href')?.startsWith(`${DOCUMENT_PAGES}/`) === true) {
      node.removeAttribute('target');
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Tracker attachments: `![terrain](att:3fa9c2e1b07d)` (specs/tracker D8).
 *
 * An `att:` reference is not a URL a browser can fetch, and DOMPurify would
 * strip it as an unknown scheme. So, **when the caller asks for it**, an image
 * source or a link target that is exactly `att:` and 12 to 64 hex characters
 * is rewritten to the attachment route, `/tracker/attachments/<hex>`: a
 * same-origin path built from hex alone, which is all the rewrite can emit.
 * Anything else is left as it was and meets the sanitiser like every other
 * string. The rewrite happens on parsed tokens, before rendering, never on the
 * HTML string, and the sanitiser still runs over the result.
 *
 * Opt-in, through the render environment, so ledger prose renders exactly as it
 * always has: the ledger has no attachments.
 */
const ATTACHMENT = /^att:([0-9a-f]{12,64})$/i;

/**
 * Tracker documents link to each other as the repository's files did:
 * `[music](m03-music.md)` (specs/tracker D4, m04 TC-02). **When the caller
 * names the document being rendered**, a link target that resolves to a
 * document path (`tracker/paths.ts`'s `resolveDocLink`: no scheme, no host,
 * ending in `.md`) is rewritten to that document's page,
 * `/projects/<project>/doc/<path>`. Like the attachment rewrite it works on
 * parsed tokens, emits only a path built from encoded segments, and the
 * sanitiser still runs over the result. Nothing else changes.
 */
/** The document being rendered, for resolving its relative links. */
export interface DocumentLinks {
  project: string;
  /** The rendered document's own path, e.g. `specs/audio/master.md`. */
  from: string;
}

interface RenderEnv {
  attachments?: boolean;
  documentLinks?: DocumentLinks;
}

type Rule = NonNullable<typeof md.renderer.rules.image>;

function resolvingAttachment(attribute: 'src' | 'href', fallback: Rule | undefined): Rule {
  return (tokens, index, options, env: RenderEnv, self) => {
    const token = tokens[index]!;
    const value = token.attrGet(attribute);
    const match = env.attachments === true && value !== null ? ATTACHMENT.exec(value) : null;
    if (match !== null) {
      token.attrSet(attribute, `/tracker/attachments/${match[1]!.toLowerCase()}`);
    } else if (attribute === 'href' && value !== null && env.documentLinks !== undefined) {
      const resolved = resolveDocLink(env.documentLinks.from, value);
      if (resolved !== null) {
        token.attrSet(
          'href',
          `${docPath(env.documentLinks.project, resolved.path)}${resolved.fragment}`,
        );
      }
    }
    return fallback === undefined
      ? self.renderToken(tokens, index, options)
      : fallback(tokens, index, options, env, self);
  };
}

/** Whether the token at `index` sits between a `link_open` and its `link_close`. */
function insideLink(tokens: ReadonlyArray<{ type: string }>, index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    const type = tokens[i]!.type;
    if (type === 'link_open') {
      depth += 1;
    } else if (type === 'link_close') {
      depth -= 1;
    }
  }
  return depth > 0;
}

/**
 * An attached image opens whole (rag-t0053): where it is not already inside a
 * link, it is wrapped in one to its own attachment route, so a page that shows
 * it small (the ticket history) still lets the reader reach the file. A plain
 * click is taken by the image viewer (`Markdown.tsx`, rag-t0055); the link is
 * what a modifier-click, a middle click or a page without script follows. The
 * link's address is the same hex-only path the image was given, and the
 * sanitiser runs over it like everything else (and gives it the new tab).
 */
function linkingAttachedImage(inner: Rule): Rule {
  return (tokens, index, options, env: RenderEnv, self) => {
    const html = inner(tokens, index, options, env, self);
    const src = tokens[index]!.attrGet('src');
    if (
      env.attachments !== true ||
      src === null ||
      !/^\/tracker\/attachments\/[0-9a-f]{12,64}$/.test(src) ||
      insideLink(tokens, index)
    ) {
      return html;
    }
    return `<a href="${src}">${html}</a>`;
  };
}

md.renderer.rules.image = linkingAttachedImage(resolvingAttachment('src', md.renderer.rules.image));
md.renderer.rules.link_open = resolvingAttachment('href', md.renderer.rules.link_open);

/** What a caller may ask of the renderer. */
export interface RenderOptions {
  /** Resolve `att:` references to tracker attachments (see above). */
  attachments?: boolean;
  /** Resolve links to other tracker documents from this one (see above). */
  documentLinks?: DocumentLinks;
}

/**
 * Markdown in, sanitised HTML out.
 *
 * `USE_PROFILES: { html: true }` narrows the allowlist to HTML — no SVG, no
 * MathML — because nothing the Markdown parser emits needs either, and a
 * profile that permits what cannot arrive is surface for no benefit.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const env: RenderEnv = {
    attachments: options.attachments === true,
    ...(options.documentLinks === undefined ? {} : { documentLinks: options.documentLinks }),
  };
  return DOMPurify.sanitize(md.render(source, env), { USE_PROFILES: { html: true } });
}
