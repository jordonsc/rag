/**
 * Topic ids: what may be minted into one, and how one becomes a URL.
 *
 * Both halves are one-line functions, and both are here because the same
 * reasoning was previously written down at one call site and silently not
 * applied at the others. The tests that matter are therefore as much about the
 * *codebase* as about the functions: a rule kept in one place is only kept if
 * nothing bypasses it, and a second copy of `/topic/${id}` is exactly how the
 * bug came back.
 */

import {
  REPO_NAME_ERROR,
  TOPIC_ID_ERROR,
  isRepoName,
  isTopicId,
  parseTopicId,
  topicPath,
} from '../ledger/ids';
import { matching } from './sources';

describe('isRepoName', () => {
  it.each(['rag', 'my_proj', 'docs', 'a.b', 'a-b', 'A1', '_x'])('accepts %j', (value) => {
    expect(isRepoName(value)).toBe(true);
  });

  /**
   * **The slash is the one that strands a topic.** `docs/api` mints
   * `docs/api-0001`, and `/topic/:id` cannot match it — a route parameter
   * never spans a path separator — so the topic is unreachable at its own
   * address. On a *move* it is worse still: the id it came from is retired to a
   * pointer at that same unreachable address, and the destination's sequence
   * counter has already consumed the number, so nothing reissues either id.
   */
  it.each(['wiki/docs', 'a project', '', 'proj?ect', 'a#b', 'a%2Fb', 'ünïcode', 'a\\\\b'])(
    'refuses %j',
    (value) => {
      expect(isRepoName(value)).toBe(false);
    },
  );

  it('states the rule in the message it hands a reader', () => {
    expect(REPO_NAME_ERROR).toMatch(/Letters, digits, dots, dashes and underscores only/);
  });
});

describe('parseTopicId', () => {
  it.each(['demo-0001', 'example-0042', 'a.b-1234', '_x-9999'])('accepts %j', (value) => {
    expect(isTopicId(value)).toBe(true);
  });

  /**
   * **The final hyphen, not the first.** A project name may contain hyphens and
   * digits of its own, so `demo-v2-0001` is the project `demo-v2` and sequence
   * `0001`. Split at the first hyphen instead and every id belonging to such a
   * project stops being recognised — while `demo-0001` goes on working, which
   * is why the mistake survives a casual test.
   */
  it('splits at the final hyphen, so a project name may contain one', () => {
    expect(parseTopicId('demo-v2-0001')).toEqual({ repo: 'demo-v2', seq: '0001' });
    expect(parseTopicId('demo-0001')).toEqual({ repo: 'demo', seq: '0001' });
  });

  /**
   * Four digits is the *minimum* the server pads to (`{:04}`), not a width. A
   * project past 9,999 topics keeps minting ids, and they are still ids.
   */
  it('accepts a sequence that has outgrown four digits', () => {
    expect(parseTopicId('demo-10000')).toEqual({ repo: 'demo', seq: '10000' });
  });

  it('keeps the sequence as written, leading zeros and all', () => {
    // It is half of a string handed back to the server, not a number.
    expect(parseTopicId('demo-0042')?.seq).toBe('0042');
  });

  it.each([
    'demo', // no sequence at all
    'demo-1', // and not one the server would ever mint
    'demo-001',
    'demo-abcd',
    'demo-0001x',
    'demo-0001-', // a trailing hyphen leaves no digits after the split
    '-0001', // the id a blank repo mints: reachable by URL, not typeable here
    'wiki/docs-0001', // the repo half is checked, not assumed
    ' demo-0001', // the caller trims; this function does not guess
    'why did we choose podman',
  ])('refuses %j', (value) => {
    expect(parseTopicId(value)).toBeNull();
    expect(isTopicId(value)).toBe(false);
  });

  it('states the shape in the message it hands a reader', () => {
    // Someone who typed the wrong thing needs the rule, not "invalid".
    expect(TOPIC_ID_ERROR).toMatch(/demo-0001/);
    expect(TOPIC_ID_ERROR).toMatch(/four digits/);
  });
});

describe('topicPath', () => {
  it('is the route the application actually registers', () => {
    expect(topicPath('rag-0009')).toBe('/topic/rag-0009');
  });

  /**
   * An id this viewer did not mint still has to route somewhere honest — one
   * typed into the rescue box, one quoted in a `supersedes` link, one handed
   * back by the server when a move is followed. Encoded, a strange id is a 404;
   * unencoded, a slash in it silently addresses a different page.
   */
  it.each([
    ['wiki/docs-0001', '/topic/wiki%2Fdocs-0001'],
    ['a b-0001', '/topic/a%20b-0001'],
    ['a?b', '/topic/a%3Fb'],
    ['a#b', '/topic/a%23b'],
  ])('encodes %j', (id, expected) => {
    expect(topicPath(id)).toBe(expected);
  });
});

describe('the rules are kept in one place', () => {
  /**
   * **No second copy of the route.** Five call sites each built `/topic/${id}`
   * by hand and only one of them encoded — which is how a moved topic became
   * unreachable. The template is now spelled once, in `ledger/ids.ts`, and this
   * is what stops a sixth appearing.
   */
  it('builds a topic route in exactly one module', () => {
    expect(matching(/`\/topic\/\$\{/)).toEqual(['ledger/ids.ts']);
  });

  /**
   * **No second copy of the repo charset.** The defect this replaces was
   * precisely that: the rule and its reasoning existed in the create form and
   * nowhere else, so the move dialog — the other place an id is minted — had
   * only a non-blank check.
   */
  it('spells the repo charset in exactly one module', () => {
    expect(matching(/A-Za-z0-9\._-/)).toEqual(['ledger/ids.ts']);
  });

  /**
   * **No second copy of the split.** Two boxes recognise an id — the one in the
   * bar and the one on the 404 page — and a third place now reads it off the
   * search query. A private re-implementation in any of them would be the
   * first-hyphen bug waiting to happen, in one box and not the others.
   */
  it('splits an id in exactly one module', () => {
    expect(matching(/lastIndexOf\('-'\)/)).toEqual(['ledger/ids.ts']);
  });
});
