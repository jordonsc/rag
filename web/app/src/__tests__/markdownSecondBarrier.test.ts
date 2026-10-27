/**
 * The second barrier, on its own.
 *
 * `render.ts` deliberately doubles up: the parser refuses to emit raw HTML
 * (`html: false`) **and** DOMPurify sanitises the result. The trouble with
 * testing two barriers through one function is that the first one hides the
 * second — with the parser escaping everything, a sanitiser that had been
 * quietly reduced to `(html) => html` would still pass every hostile-input
 * case in `markdown.test.ts`.
 *
 * So this file removes the first barrier. `markdown-it` is replaced with a
 * renderer that hands the source straight through as HTML — precisely what a
 * future `html: true` would produce — and the module's one public function is
 * asked to cope. What survives here is DOMPurify's work and nothing else.
 *
 * It lives in its own file because `vi.mock` is hoisted to the top of the
 * module it appears in: mixing it with the real-parser tests would mock them
 * too.
 */

import { renderMarkdown } from '../markdown/render';

vi.mock('markdown-it', () => ({
  default: class PassThroughParser {
    // `render.ts` installs its `att:` rules on the renderer at import; the
    // pass-through never calls them, so an empty table is all it needs.
    renderer = { rules: {} };
    render(source: string): string {
      return source;
    }
  },
}));

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('DOMPurify, with the parser barrier removed', () => {
  it('is really rendering raw HTML — the mock is in force', () => {
    // Guards the file against becoming vacuous: if the mock stopped applying,
    // this would fail rather than every case below silently testing the real
    // parser again.
    expect(parse(renderMarkdown('<b>bold</b>')).querySelector('b')).not.toBeNull();
  });

  const vectors: Array<[name: string, source: string]> = [
    ['a script element', '<p>ok</p><script>alert(1)</script>'],
    ['an image error handler', '<img src="x" onerror="alert(1)">'],
    ['a javascript href', '<a href="javascript:alert(1)">click</a>'],
    ['a data:text/html href', '<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>'],
    ['an svg script', '<svg><script>alert(1)</script></svg>'],
    ['an svg animate handler', '<svg><animate onbegin="alert(1)" attributeName="x"></svg>'],
    ['an iframe', '<iframe src="https://example.com/evil"></iframe>'],
    ['a style block', '<style>@import url(https://example.com/x.css);</style>'],
    ['a link element', '<link rel="stylesheet" href="https://example.com/x.css">'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://example.com">'],
    ['a base tag', '<base href="https://example.com/">'],
    ['a mixed-case handler', '<div OnMouseOver="alert(1)">hover</div>'],
    ['a mutation-XSS attempt', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ];

  for (const [name, source] of vectors) {
    it(`strips ${name}`, () => {
      const root = parse(renderMarkdown(source));
      for (const tag of ['script', 'iframe', 'style', 'link', 'meta', 'base', 'svg']) {
        expect(root.querySelector(tag)).toBeNull();
      }
      for (const element of root.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          expect(attribute.name.toLowerCase().startsWith('on')).toBe(false);
        }
        const href = (element.getAttribute('href') ?? '').replace(/\s/g, '').toLowerCase();
        expect(href.startsWith('javascript:')).toBe(false);
        expect(href.startsWith('data:text/html')).toBe(false);
      }
    });
  }

  /**
   * **The one thing the second barrier does not cover**, recorded rather than
   * papered over. DOMPurify's HTML profile allows `<form>` and `<input>`, so a
   * document that reached the sanitiser with a form in it would keep it — and a
   * form pointed at somebody else's server, drawn inside a trusted page, is a
   * credential-phishing surface.
   *
   * It cannot arrive today: `html: false` means the parser never emits one. The
   * point of asserting it is that the two barriers are **not** interchangeable,
   * so "DOMPurify catches everything anyway" is not a reason to relax the
   * parser. If this ever needs to change, the fix is `FORBID_TAGS` on the
   * sanitise call, not a wider parser.
   */
  it('does not, by itself, remove a form', () => {
    const root = parse(renderMarkdown('<form action="https://example.com/steal"></form>'));
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('keeps the harmless part of a hostile document', () => {
    // Sanitising is not blanking: the reader still gets the prose that came
    // with the payload, which is what makes stripping preferable to refusing.
    const root = parse(renderMarkdown('<p>the finding</p><script>alert(1)</script>'));
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('the finding');
  });
});
