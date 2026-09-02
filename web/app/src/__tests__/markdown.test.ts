/**
 * The sanitiser, tested as a security boundary rather than as a formatter.
 *
 * `render.ts` is the single point in this application where a string somebody
 * else wrote stops being inert, and the ledger it renders accepts writes from
 * any client on the LAN with no authentication. So the interesting question is
 * not "does bold work" — it is "what happens when the body was written to get
 * script into a reader's page", and every case below is a vector that has
 * actually been used against a naive Markdown pipeline.
 *
 * Assertions are made against the **parsed DOM**, not against the HTML string.
 * A string test can pass while the browser still ends up executing something:
 * `&lt;img&gt;` and `<img>` are different strings and, once the browser has
 * decoded entities, sometimes the same element. Parsing is what the browser
 * does, so parsing is what is checked.
 */

import { join } from 'node:path';

import DOMPurify from 'dompurify';

import { renderMarkdown } from '../markdown/render';
import { SRC, matching, read } from './sources';

/** The rendered output as the browser would build it. */
function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

/** Every attribute name present anywhere in the rendered tree. */
function attributeNames(root: HTMLElement): string[] {
  const names: string[] = [];
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      names.push(attribute.name.toLowerCase());
    }
  }
  return names;
}

describe('renderMarkdown — hostile input', () => {
  const vectors: Array<[name: string, source: string]> = [
    ['a script element', '<script>alert(1)</script>'],
    ['a mixed-case script element', '<ScRiPt>alert(1)</ScRiPt>'],
    ['an entity-encoded script element', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['a double-encoded script element', '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;'],
    ['an unclosed script element', '<script>alert(1)'],
    ['a script split by a nested angle bracket', '<<script>script>alert(1)<</script>/script>'],
    ['an image with an error handler', '<img src=x onerror="alert(1)">'],
    ['an image with an unquoted error handler', '<img src=x onerror=alert(1)//>'],
    ['a body onload', '<body onload=alert(1)>'],
    ['an svg carrying script', '<svg><script>alert(1)</script></svg>'],
    ['an svg animate vector', '<svg><animate onbegin=alert(1) attributeName=x dur=1s></svg>'],
    ['an iframe with a javascript source', '<iframe src="javascript:alert(1)"></iframe>'],
    ['an iframe with a data source', '<iframe src="data:text/html,<script>alert(1)</script>">'],
    ['a form action', '<form action="javascript:alert(1)"><button>Go</button></form>'],
    ['a style element', '<style>body{background:url("javascript:alert(1)")}</style>'],
    ['an object element', '<object data="data:text/html;base64,PHNjcmlwdD4="></object>'],
    ['a details toggle handler', '<details open ontoggle=alert(1)>'],
    ['a malformed tag with a trailing handler', '<div/onmouseover="alert(1)">hover</div>'],
    ['a markdown link to javascript', '[click me](javascript:alert(1))'],
    ['a markdown link to javascript, mixed case', '[click me](JaVaScRiPt:alert(1))'],
    ['a markdown link to javascript with an entity', '[click me](java&#115;cript:alert(1))'],
    ['a markdown link to data html', '[click me](data:text/html;base64,PHNjcmlwdD4=)'],
    ['a markdown link to vbscript', '[click me](vbscript:msgbox(1))'],
    ['a markdown image with a javascript source', '![x](javascript:alert(1))'],
    ['a markdown image with an onerror in the title', '![x](x " onerror="alert(1))'],
    ['a reference link to javascript', '[click me][ref]\n\n[ref]: javascript:alert(1)'],
    ['an autolink to javascript', '<javascript:alert(1)>'],
  ];

  for (const [name, source] of vectors) {
    it(`neutralises ${name}`, () => {
      const root = parse(renderMarkdown(source));

      // No executable element survives, in either namespace.
      expect(root.querySelector('script')).toBeNull();
      expect(root.querySelector('iframe')).toBeNull();
      expect(root.querySelector('object')).toBeNull();
      expect(root.querySelector('embed')).toBeNull();
      expect(root.querySelector('style')).toBeNull();
      expect(root.querySelector('form')).toBeNull();
      expect(root.querySelector('svg')).toBeNull();

      // No event handler attribute survives, under any name.
      for (const attribute of attributeNames(root)) {
        expect(attribute.startsWith('on')).toBe(false);
      }

      // No URL-bearing attribute carries a scripting scheme.
      for (const element of root.querySelectorAll('[href], [src], [action], [data]')) {
        for (const name of ['href', 'src', 'action', 'data']) {
          const value = (element.getAttribute(name) ?? '').replace(/\s/g, '').toLowerCase();
          expect(value.startsWith('javascript:')).toBe(false);
          expect(value.startsWith('vbscript:')).toBe(false);
          expect(value.startsWith('data:text/html')).toBe(false);
        }
      }
    });
  }
});

describe('renderMarkdown — the two barriers', () => {
  /**
   * `html: false` on the parser, asserted through what it does rather than by
   * reading the option: raw HTML in the source comes out as **visible text**.
   *
   * This is the discriminating case. A `<b>` is on DOMPurify's allowlist, so
   * a pipeline with `html: true` would render a real bold element here and
   * still pass every hostile-input test above. Only the parser's own setting
   * makes the tag show up as characters.
   */
  it('escapes benign raw HTML instead of parsing it', () => {
    const root = parse(renderMarkdown('a <b>bold</b> claim'));
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('<b>bold</b>');
  });

  /**
   * DOMPurify runs on every render, asserted by spying on the module the
   * renderer calls. Removing the sanitiser as "redundant, the parser already
   * escapes HTML" is the plausible regression this catches — and it would
   * leave every test above still passing, because with `html: false` there is
   * nothing for the sanitiser to strip.
   */
  it('passes every string through DOMPurify', () => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    try {
      renderMarkdown('plain prose');
      expect(sanitize).toHaveBeenCalledTimes(1);
    } finally {
      sanitize.mockRestore();
    }
  });

  /** External links cannot reach back through `window.opener`. */
  it('opens links in a new tab without an opener', () => {
    const root = parse(renderMarkdown('[the docs](https://example.com/docs)'));
    const link = root.querySelector('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('renderMarkdown — ordinary prose still renders', () => {
  // Over-sanitisation is the other way to break this module, and it fails
  // quietly: a ledger entry whose code block or table has been eaten reads as
  // an agent that wrote nothing rather than as a renderer that dropped it.

  it('renders a fenced code block with its language class', () => {
    const root = parse(renderMarkdown('```rust\nlet x = 1;\n```'));
    const code = root.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code).toHaveClass('language-rust');
    expect(code?.textContent).toContain('let x = 1;');
  });

  it('escapes markup inside a code block rather than dropping it', () => {
    const root = parse(renderMarkdown('```\n<script>alert(1)</script>\n```'));
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('code')?.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders a table', () => {
    const source = ['| Field | Value |', '| --- | --- |', '| repo | rag |'].join('\n');
    const root = parse(renderMarkdown(source));
    expect(root.querySelector('table')).not.toBeNull();
    expect(root.querySelectorAll('th')).toHaveLength(2);
    expect(root.querySelectorAll('td')).toHaveLength(2);
    expect(root.textContent).toContain('rag');
  });

  it('renders lists, emphasis and inline code', () => {
    const root = parse(renderMarkdown('- **one**\n- _two_\n- `three`'));
    expect(root.querySelectorAll('li')).toHaveLength(3);
    expect(root.querySelector('strong')?.textContent).toBe('one');
    expect(root.querySelector('em')?.textContent).toBe('two');
    expect(root.querySelector('code')?.textContent).toBe('three');
  });

  it('linkifies a bare URL', () => {
    const root = parse(renderMarkdown('see https://example.com/x for the rest'));
    expect(root.querySelector('a')).toHaveAttribute('href', 'https://example.com/x');
  });

  it('renders a blockquote and a heading', () => {
    const root = parse(renderMarkdown('# Heading\n\n> quoted'));
    expect(root.querySelector('h1')?.textContent).toBe('Heading');
    expect(root.querySelector('blockquote')?.textContent).toContain('quoted');
  });

  it('does not turn a hard wrap into a line break', () => {
    // `breaks: false`. Agents hard-wrap their prose; honouring every wrap
    // would freeze somebody else's line length into this application's layout.
    const root = parse(renderMarkdown('one line\nwrapped here'));
    expect(root.querySelector('br')).toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(1);
  });

  it('renders an empty string as nothing', () => {
    expect(renderMarkdown('').trim()).toBe('');
  });

  /**
   * The module exports **one** renderer, and that is a security property
   * rather than tidiness: it used to export a second, inline one that nothing
   * called, so the audit of "where untrusted text becomes DOM" had to reason
   * about a path the application never took — and the export sat there as a
   * ready-made call site for somebody who had not read the module header. If
   * an inline renderer is ever wanted again it arrives with a caller, and this
   * assertion is what makes that a deliberate act.
   */
  it('exports exactly one renderer', () => {
    const source = read(join(SRC, 'markdown', 'render.ts'));
    expect(source.match(/^export function /gm)).toHaveLength(1);
    expect(source).not.toMatch(/md\.renderInline\(/);
  });
});

describe('the single audit point', () => {
  /**
   * The rule the whole module depends on: **one** place sets inner HTML, and it
   * is the one that has been through the sanitiser. A second call site
   * anywhere — a "quick" innerHTML for a highlighted snippet, say — reopens the
   * hole this design closed, and would not otherwise fail anything.
   */
  it('has exactly one dangerouslySetInnerHTML, in the markdown component', () => {
    const hits = matching(/dangerouslySetInnerHTML/);
    expect(hits).toEqual([join('markdown', 'Markdown.tsx')]);

    // One *use*, not one mention — the file's own comment names the prop too.
    const source = read(join(SRC, hits[0]!));
    expect(source.match(/dangerouslySetInnerHTML=\{/g)).toHaveLength(1);
  });

  /** And nothing else assigns `innerHTML` directly either. */
  it('never assigns innerHTML outside the tests', () => {
    expect(matching(/\.innerHTML\s*=/)).toEqual([]);
  });
});
