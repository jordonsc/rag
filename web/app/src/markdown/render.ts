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
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Markdown in, sanitised HTML out.
 *
 * `USE_PROFILES: { html: true }` narrows the allowlist to HTML — no SVG, no
 * MathML — because nothing the Markdown parser emits needs either, and a
 * profile that permits what cannot arrive is surface for no benefit.
 */
export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), { USE_PROFILES: { html: true } });
}
