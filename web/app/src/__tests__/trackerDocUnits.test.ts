/**
 * The documents pages' pure parts (specs/tracker m04): how a link inside a
 * document resolves to another document, the line diff a stale save and the
 * history draw, the draft store, and the renderer's document links.
 */

import { renderMarkdown } from '../markdown/render';
import { changed, diffLines, parseUnified, withContext } from '../tracker/diff';
import { clearDraft, draftKey, readDraft, writeDraft } from '../tracker/drafts';
import { isSlug, resolveDocLink, slugify } from '../tracker/paths';

describe('resolveDocLink', () => {
  const from = 'specs/audio/master.md';

  it('resolves a sibling from the document’s folder', () => {
    expect(resolveDocLink(from, 'm03-music.md')).toEqual({
      path: 'specs/audio/m03-music.md',
      fragment: '',
    });
    expect(resolveDocLink(from, './m03-music.md#acceptance')).toEqual({
      path: 'specs/audio/m03-music.md',
      fragment: '#acceptance',
    });
  });

  it('climbs with .. and reads specs/ and concepts/ from the project’s root', () => {
    expect(resolveDocLink(from, '../tracker/master.md')?.path).toBe('specs/tracker/master.md');
    expect(resolveDocLink(from, 'specs/audio/m03-music.md')?.path).toBe('specs/audio/m03-music.md');
    expect(resolveDocLink(from, 'concepts/power.md')?.path).toBe('concepts/power.md');
    expect(resolveDocLink(from, '/specs/x/master.md')?.path).toBe('specs/x/master.md');
  });

  it('leaves anything that is not a document link alone', () => {
    expect(resolveDocLink(from, 'https://example.com/a.md')).toBeNull();
    expect(resolveDocLink(from, '//example.com/a.md')).toBeNull();
    expect(resolveDocLink(from, '#section')).toBeNull();
    expect(resolveDocLink(from, 'picture.png')).toBeNull();
    expect(resolveDocLink(from, 'att:3fa9c2e1b07d')).toBeNull();
    expect(resolveDocLink(from, 'mailto:someone@example.com')).toBeNull();
    // Above the project's root, or with a character no document path holds.
    expect(resolveDocLink(from, '../../../outside.md')).toBeNull();
    expect(resolveDocLink(from, 'with space.md')).toBeNull();
    expect(resolveDocLink(from, 'a.md?x=1')).toBeNull();
  });
});

describe('slugs', () => {
  it('slugifies a title as the server names things', () => {
    expect(slugify('Power generation')).toBe('power-generation');
    expect(slugify('  Ünïcode & co. ')).toBe('unicode-co');
    expect(slugify('***')).toBe('');
  });

  it('accepts only lowercase letters, digits and dashes from a letter or digit', () => {
    expect(isSlug('power-generation')).toBe(true);
    expect(isSlug('m03')).toBe(true);
    expect(isSlug('-lead')).toBe(false);
    expect(isSlug('Upper')).toBe(false);
    expect(isSlug('')).toBe(false);
  });
});

describe('diffLines', () => {
  it('marks each line unchanged, added or deleted, in order', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nb2\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'add', text: 'b2' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles empty texts and identical texts', () => {
    expect(diffLines('', 'one')).toEqual([{ kind: 'add', text: 'one' }]);
    expect(diffLines('one', '')).toEqual([{ kind: 'del', text: 'one' }]);
    expect(changed(diffLines('same\ntext', 'same\ntext'))).toBe(false);
  });

  it('finds the shortest edit inside a long unchanged run', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 20', 'line twenty');
    const ops = diffLines(before, after);
    expect(ops.filter((op) => op.kind !== 'same')).toEqual([
      { kind: 'del', text: 'line 20' },
      { kind: 'add', text: 'line twenty' },
    ]);
    const rows = withContext(ops, 3);
    expect(rows[0]).toEqual({ kind: 'gap', count: 17 });
    expect(rows.at(-1)).toEqual({ kind: 'gap', count: 16 });
    expect(rows.filter((row) => row.kind === 'same')).toHaveLength(6);
  });

  it('interleaves changes correctly (the walk back is right)', () => {
    const ops = diffLines('x\na\ny\nb\nz', 'a\nq\nb\nr');
    const before = ops.filter((op) => op.kind !== 'add').map((op) => op.text);
    const after = ops.filter((op) => op.kind !== 'del').map((op) => op.text);
    expect(before.join('\n')).toBe('x\na\ny\nb\nz');
    expect(after.join('\n')).toBe('a\nq\nb\nr');
    expect(ops.filter((op) => op.kind === 'same').map((op) => op.text)).toEqual(['a', 'b']);
  });
});

describe('parseUnified', () => {
  it('reads the server’s unified diff into rows without its header', () => {
    const diff = '--- revision 1\n+++ revision 2\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+b2\n c\n';
    expect(parseUnified(diff)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,4 @@' },
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'add', text: 'b2' },
      { kind: 'same', text: 'c' },
    ]);
    expect(parseUnified('')).toEqual([]);
  });
});

describe('drafts', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps, reads and clears a draft per project and document', () => {
    const key = draftKey('demo', 'demo-d0001');
    expect(readDraft(key)).toBeNull();
    const draft = {
      body: 'text',
      base_revision: 3,
      message: 'm',
      saved_at: '2026-01-01T00:00:00Z',
    };
    expect(writeDraft(key, draft)).toBe(true);
    expect(readDraft(key)).toEqual(draft);
    expect(readDraft(draftKey('other', 'demo-d0001'))).toBeNull();
    clearDraft(key);
    expect(readDraft(key)).toBeNull();
  });

  it('ignores a malformed draft and survives storage that throws', () => {
    const key = draftKey('demo', 'demo-d0002');
    window.localStorage.setItem(key, '{"body": 3}');
    expect(readDraft(key)).toBeNull();
    window.localStorage.setItem(key, 'not json');
    expect(readDraft(key)).toBeNull();

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(writeDraft(key, { body: 'x', base_revision: 1, message: '', saved_at: 'now' })).toBe(
      false,
    );
    spy.mockRestore();
  });
});

describe('renderMarkdown with document links', () => {
  const links = { project: 'demo', from: 'specs/audio/master.md' };

  it('rewrites a link to another document to its page, in the same tab', () => {
    const html = renderMarkdown('[music](m03-music.md) and [x](specs/audio/m03-music.md)', {
      documentLinks: links,
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a'));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      '/projects/demo/doc/specs/audio/m03-music.md',
      '/projects/demo/doc/specs/audio/m03-music.md',
    ]);
    expect(anchors.every((a) => !a.hasAttribute('target'))).toBe(true);
  });

  it('leaves external links opening in a new tab, and is off unless asked', () => {
    const external = renderMarkdown('[site](https://example.com/a.md)', { documentLinks: links });
    expect(external).toContain('href="https://example.com/a.md"');
    expect(external).toContain('target="_blank"');

    const ledger = renderMarkdown('[music](m03-music.md)');
    expect(ledger).toContain('href="m03-music.md"');
  });

  it('still resolves attachments alongside document links', () => {
    const html = renderMarkdown('![t](att:3fa9c2e1b07d)', {
      attachments: true,
      documentLinks: links,
    });
    expect(html).toContain('src="/tracker/attachments/3fa9c2e1b07d"');
  });
});
