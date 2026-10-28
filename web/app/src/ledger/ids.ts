/**
 * Topic ids: what may be minted into one, how one is recognised, and how one
 * becomes a URL.
 *
 * The first and last of those exist because the same reasoning was previously
 * written down at one call site and silently not applied at the others. A topic
 * id is `{repo}-l{seq:04}` (or, minted before rag-t0051, `{repo}-{seq:04}`)
 * and it is the string an agent quotes, a person pastes
 * into an address bar and this application routes on — so the rule about what
 * may go into one, and the rule about how one comes back out again, each belong
 * in exactly one place. Recognising one — telling `demo-l0001` apart from a
 * search phrase — is the same rule read backwards, so it lives here too rather
 * than in whichever box happened to need it first.
 */

/**
 * A repo name that survives being interpolated into an id and then into a URL.
 *
 * The server checks only that it is not blank. This is stricter on purpose:
 * the value becomes the first half of the id, and a space or — far worse — a
 * slash produces an id that is technically valid and practically broken. A
 * slash is the sharp one: `/topic/:id` never spans a path separator, so a topic
 * minted as `project/sub-0001` is unreachable at its own address, its old id is
 * a pointer to that same unreachable address, and the sequence counter has
 * already moved past the number it used. Nothing in this viewer recovers it.
 *
 * Both places that mint an id — creating a topic, and moving one to another
 * project — check against this. There is no third.
 */
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** The message shown when a repo name carries something an id cannot hold. */
export const REPO_NAME_ERROR =
  'Letters, digits, dots, dashes and underscores only — this ends up in an id and a URL.';

/** Whether a (trimmed) repo name is safe to mint an id from. */
export function isRepoName(value: string): boolean {
  return REPO_NAME.test(value);
}

/**
 * The sequence half of an id: an optional `l`, then the digits.
 *
 * The server writes it with `format_topic_id` (`crates/core/src/ledger.rs`),
 * `{repo}-l{seq:04}` — *l* for ledger, which sets a topic apart from the
 * tracker's `-t` tickets and `-d` documents. Topics minted before rag-t0051
 * keep their unmarked `{repo}-{seq:04}` for ever, so both are ids. Four digits
 * is a **minimum** and not a width: a project that passes 9,999 topics mints
 * `demo-l10000`. Anything that insisted on exactly four would stop recognising
 * a project's ids at the moment it became the busiest one in the ledger.
 */
const TOPIC_SEQ = /^(l?)([0-9]{4,})$/;

/** The two halves of a topic id, once split. */
export interface TopicIdParts {
  repo: string;
  /** The digits as written, leading zeros kept — part of the id, not a number. */
  seq: string;
  /** Whether it carries the `l` (minted since rag-t0051) or is a legacy id. */
  marked: boolean;
}

/**
 * Split `{repo}-l{seq:04}`, or a legacy `{repo}-{seq:04}`, into its halves, or
 * `null` if it is not an id.
 *
 * **The split is at the _final_ hyphen, and that is the thing to get right.** A
 * repo name may itself contain hyphens and digits — `foo-v2` is a perfectly
 * ordinary project — so `foo-v2-0001` is repo `foo-v2`, sequence `0001`, not
 * repo `foo` and some nonsense after it. Splitting at the first hyphen, or
 * matching a non-greedy repo half, reads correctly against `demo-0001` and then
 * quietly refuses every id belonging to a project whose name has a dash in it.
 *
 * The repo half is checked against [`isRepoName`] rather than being taken on
 * trust: the halves are what make the string an id, and the charset rule for
 * one of them already exists above.
 *
 * **This is a recogniser for what a person typed, not a gate on the route.**
 * `/topic/:id` stays permissive on purpose — the ledger contains ids this
 * function rejects, because `POST /ledger` does not validate `repo` and a blank
 * one mints `-0001` — so a pasted address still reaches the server and gets an
 * honest answer. Only the boxes a person types into use this, and only to avoid
 * a round trip that could not have succeeded.
 */
export function parseTopicId(value: string): TopicIdParts | null {
  const cut = value.lastIndexOf('-');
  if (cut <= 0) {
    return null;
  }
  const repo = value.slice(0, cut);
  const tail = TOPIC_SEQ.exec(value.slice(cut + 1));
  if (tail === null || !isRepoName(repo)) {
    return null;
  }
  return { repo, seq: tail[2]!, marked: tail[1] === 'l' };
}

/** Whether a (trimmed) string has the shape of a topic id. */
export function isTopicId(value: string): boolean {
  return parseTopicId(value) !== null;
}

/** The message shown to someone who typed something that is not an id. */
export const TOPIC_ID_ERROR =
  'That is not a topic id. One looks like demo-l0001 — a project name, a dash, an l, then at least four digits (older ones have no l: demo-0001).';

/**
 * The client route for a topic.
 *
 * The encoding is not decoration. Ids are supposed to come from
 * [`isRepoName`]-checked repos, but this viewer also routes on ids it did not
 * mint — one typed into the rescue box on a 404 page, one quoted in a
 * `supersedes` link, one handed back by the server when a move is followed —
 * and any of those may carry a character that changes what the path means.
 * React Router decodes the parameter back on the way in, so a reader who asks
 * for a strange id gets an honest 404 rather than a route that silently means
 * something else.
 */
export function topicPath(id: string): string {
  return `/topic/${encodeURIComponent(id)}`;
}
