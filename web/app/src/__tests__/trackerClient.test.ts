/**
 * The tracker client (specs/tracker m03, TD-01) and the two pieces of plumbing
 * beside it: the `att:` rewrite in the Markdown renderer and the page paths.
 *
 * The wire is what matters: `surface: 'web'` on every write and never an
 * `agent` (the server refuses unknown fields, and records an absent agent as
 * the owner's web write); the queue read conditional; a 409 handed back with
 * the current document; refusals made before a request leaves.
 */

import {
  TrackerApiError,
  ackDone,
  attachmentUrl,
  createItem,
  editDoc,
  getDocByPath,
  getQueue,
  isProjectName,
  listItems,
  moveItem,
  trackerAuthor,
  updateConcept,
  updateItem,
  uploadAttachment,
} from '../tracker/api';
import { docPath, itemPath, itemProject, linkHref, projectPath } from '../tracker/paths';
import { renderMarkdown } from '../markdown/render';
import { matching } from './sources';
import { TrackerServer, item, queueView } from './trackerFixtures';

const AUTHOR = trackerAuthor('alice@example.com');

let server: TrackerServer;

beforeEach(() => {
  server = new TrackerServer();
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the author fields', () => {
  it('are the email and surface web, and nothing else', () => {
    expect(AUTHOR).toEqual({ author_email: 'alice@example.com', surface: 'web' });
  });

  it('reach the wire on a create, with the place flattened', async () => {
    server.on('/tracker/demo/items', { body: item('demo-t0001') });
    await createItem('demo', { type: 'dev', title: 'One', place: { top: true } }, AUTHOR);
    expect(server.last('/tracker/demo/items').body).toEqual({
      type: 'dev',
      title: 'One',
      top: true,
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  it('carry no agent on any write, whatever a caller spreads in', async () => {
    server.on(/\/move$/, { body: item('demo-t0001') });
    await moveItem('demo-t0001', { after: 'demo-t0002' }, {
      ...AUTHOR,
      agent: 'smuggled',
    } as typeof AUTHOR);
    expect(server.last(/\/move$/).body).toEqual({
      after: 'demo-t0002',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });

  /** One module builds them; a second would be a place to forget `surface`. */
  it('are built in one module', () => {
    expect(matching(/surface: 'web'\s*[,}]/)).toEqual(['tracker/api.ts']);
  });
});

describe('the queue read', () => {
  it('is unconditional without a validator and conditional with one', async () => {
    server.on('/tracker/demo', { body: queueView(), headers: { etag: '"abc"' } });
    const first = await getQueue('demo');
    expect(first).toMatchObject({ kind: 'fresh', etag: '"abc"' });
    expect(server.last('/tracker/demo').headers['if-none-match']).toBeUndefined();

    server.onceOn('/tracker/demo', { status: 304, headers: { etag: '"abc"' } });
    const second = await getQueue('demo', '"abc"');
    expect(second).toEqual({ kind: 'unchanged' });
    expect(server.last('/tracker/demo').headers['if-none-match']).toBe('"abc"');
  });

  it('acknowledges with the author fields alone', async () => {
    server.on('/tracker/demo/ack-done', { body: { project: 'demo', acknowledged: [] } });
    await ackDone('demo', AUTHOR);
    expect(server.last('/tracker/demo/ack-done').body).toEqual(AUTHOR);
  });

  it('filters items by status in the query string', async () => {
    server.on(/\/tracker\/demo\/items/, { body: { project: 'demo', items: [] } });
    await listItems('demo', 'done');
    expect(server.last(/items/).path).toBe('/tracker/demo/items?status=done');
  });
});

describe('errors', () => {
  it('shows the server’s own sentence', async () => {
    server.on(/\/move$/, { status: 400, body: { error: 'the anchor is not queued' } });
    await expect(moveItem('demo-t0001', { top: true }, AUTHOR)).rejects.toMatchObject({
      status: 400,
      message: 'the anchor is not queued',
    });
  });

  it('hands back the current document on a stale edit', async () => {
    const current = { id: 'demo-d0001', revision: 4, body: 'newer' };
    server.on(/\/edit$/, {
      status: 409,
      body: { error: 'stale', current_revision: 4, current },
    });
    const failure = await editDoc(
      'demo-d0001',
      { base_revision: 3, replacements: [{ old: 'a', new: 'b' }] },
      AUTHOR,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrackerApiError);
    expect((failure as TrackerApiError).conflict).toEqual({ current_revision: 4, current });
  });
});

describe('notes (D7, amended by the owner 2026-10-27)', () => {
  it('sends a status change, a block or an approval with no note, dropping a blank one', async () => {
    server.on('/tracker/items/demo-t0001', { body: item('demo-t0001') }, 'POST');
    for (const body of [
      { status: 'done' as const },
      { blocked: true, block_reason: 'review' as const },
      { approval: 'owner' as const },
      { status: 'done' as const, note: '   ' },
    ]) {
      await updateItem('demo-t0001', body, AUTHOR);
      const { note: _blank, ...expected } = body as typeof body & { note?: string };
      expect(server.last('/tracker/items/demo-t0001', 'POST').body).toEqual({
        ...expected,
        author_email: 'alice@example.com',
        surface: 'web',
      });
    }
  });

  it('creates an approved item with no note', async () => {
    server.on('/tracker/demo/items', { body: item('demo-t0001') });
    await createItem('demo', { type: 'dev', title: 'One', approval: 'owner' }, AUTHOR);
    expect(server.last('/tracker/demo/items').body).toEqual({
      type: 'dev',
      title: 'One',
      approval: 'owner',
      author_email: 'alice@example.com',
      surface: 'web',
    });
  });
});

describe('refusals before anything is sent', () => {
  it('refuses a bare note that is blank, and an update with nothing in it', async () => {
    for (const body of [{ note: '' }, { note: '   ' }]) {
      await expect(updateItem('demo-t0001', body, AUTHOR)).rejects.toThrow(/needs some text/);
    }
    await expect(updateItem('demo-t0001', {}, AUTHOR)).rejects.toThrow(/Nothing to send/);
    await expect(updateConcept('demo', 'power', { note: ' ' }, AUTHOR)).rejects.toThrow(
      /needs some text/,
    );
    expect(server.sent).toHaveLength(0);
  });

  it('refuses a blank title and a gate with no intensity', async () => {
    await expect(createItem('demo', { type: 'dev', title: '  ' }, AUTHOR)).rejects.toThrow(/title/);
    await expect(createItem('demo', { type: 'gate', title: 'Gate' }, AUTHOR)).rejects.toThrow(
      /intensity/,
    );
    expect(server.sent).toHaveLength(0);
  });

  it('refuses a write with no author address', async () => {
    await expect(ackDone('demo', trackerAuthor(''))).rejects.toThrow(/author address/);
    expect(server.sent).toHaveLength(0);
  });

  it('refuses an attachment over 50 MB', async () => {
    const big = { size: 50 * 1024 * 1024 + 1, name: 'big.bin' } as Blob & { name: string };
    await expect(uploadAttachment('demo', big, AUTHOR)).rejects.toThrow(/50 MB/);
    expect(server.sent).toHaveLength(0);
  });
});

describe('documents by path', () => {
  it('puts the path, revision and history in the query string', async () => {
    server.on(/\/tracker\/demo\/doc\?/, { body: {} });
    await getDocByPath('demo', 'specs/audio/m03-music.md', { revision: 2, history: false });
    expect(server.last(/doc\?/).path).toBe(
      '/tracker/demo/doc?path=specs%2Faudio%2Fm03-music.md&revision=2&history=false',
    );
  });
});

describe('names and paths', () => {
  it('accepts a repository name and refuses the reserved and the malformed', () => {
    for (const good of ['ubu', 'argus-v2', 'a.b_c', '9lives']) {
      expect(isProjectName(good), good).toBe(true);
    }
    for (const bad of ['', '-x', '.x', 'a b', 'a/b', 'items', 'docs', 'projects', 'x'.repeat(65)]) {
      expect(isProjectName(bad), bad).toBe(false);
    }
  });

  it('builds the pages under /projects, never under the API’s /tracker', () => {
    expect(projectPath('demo')).toBe('/projects/demo');
    expect(itemPath('demo', 'demo-t0001')).toBe('/projects/demo/item/demo-t0001');
    expect(docPath('demo', 'specs/a b/master.md')).toBe('/projects/demo/doc/specs/a%20b/master.md');
  });

  it('finds an item id’s project at its final -t', () => {
    expect(itemProject('argus-v2-t0003')).toBe('argus-v2');
    expect(itemProject('demo-0042')).toBeNull();
  });

  it('links each kind to its page', () => {
    expect(linkHref('demo', { kind: 'ledger', target: 'rag-0035' })).toBe('/topic/rag-0035');
    expect(linkHref('demo', { kind: 'item', target: 'rag-t0003' })).toBe(
      '/projects/rag/item/rag-t0003',
    );
    expect(linkHref('demo', { kind: 'concept', target: 'power' })).toBe(
      '/projects/demo/doc/concepts/power.md',
    );
    expect(linkHref('demo', { kind: 'milestone', target: 'audio/m03' })).toBeNull();
  });

  it('resolves an attachment reference, and nothing else', () => {
    expect(attachmentUrl('att:3FA9C2E1B07D')).toBe('/tracker/attachments/3fa9c2e1b07d');
    expect(attachmentUrl('att:short')).toBeNull();
    expect(attachmentUrl('att:../../etc')).toBeNull();
  });
});

describe('att: references in rendered Markdown', () => {
  function parse(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  }

  it('resolves to the attachment route when asked', () => {
    const root = parse(
      renderMarkdown('![terrain](att:3fa9c2e1b07d) and [notes](att:3fa9c2e1b07d00)', {
        attachments: true,
      }),
    );
    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      '/tracker/attachments/3fa9c2e1b07d',
    );
    expect(root.querySelector('a')?.getAttribute('href')).toBe(
      '/tracker/attachments/3fa9c2e1b07d00',
    );
  });

  it('leaves ledger prose alone: no option, no rewrite', () => {
    const root = parse(renderMarkdown('![terrain](att:3fa9c2e1b07d)'));
    expect(root.querySelector('img')?.getAttribute('src') ?? null).not.toBe(
      '/tracker/attachments/3fa9c2e1b07d',
    );
  });

  it('rewrites nothing that is not exactly att: and hex', () => {
    const root = parse(
      renderMarkdown('![x](att:3fa9c2e1b07d/../../ledger) ![y](javascript:alert(1))', {
        attachments: true,
      }),
    );
    for (const image of root.querySelectorAll('img')) {
      expect(image.getAttribute('src') ?? '').not.toMatch(/^\/tracker\/attachments\//);
      expect(image.getAttribute('src') ?? '').not.toMatch(/javascript/i);
    }
  });
});
