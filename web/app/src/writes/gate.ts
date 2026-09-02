/**
 * What every write surface shares: the identity gate, and the two sentences
 * that have to be said in the same words wherever a write happens.
 *
 * **The gate is `useAuthor()` returning null.** That is the whole check — there
 * is no session, no permission and nothing to ask the server. What follows from
 * it is a house rule rather than a technical constraint, and it is easy to get
 * backwards: a write control belonging to a reader with no identity set is
 * **shown and enabled**, and pressing it opens the identity prompt instead of
 * writing. Hiding it would leave a reader wondering whether the application can
 * do the thing at all; disabling it would leave them with a dead control and no
 * way to work out what would revive it.
 */

import { useCallback } from 'react';

import type { AuthorFields, CreatorFields } from '../api';
import { useAuthor, useCreator, useIdentity } from '../identity';

/**
 * Said beside a write control that would prompt rather than write.
 *
 * One string, because a reader who meets it in three places should recognise
 * it as the same condition rather than read three near-misses and wonder
 * whether they mean different things.
 */
export const IDENTITY_NEEDED =
  'The ledger files every entry under an author. Set your email and this will write.';

/**
 * Said **after** a successful write, wherever the reader might next go looking
 * for it in search.
 *
 * The lag is real and unavoidable: a write lands in SQLite at once, and the
 * vector index reconciles through a trigger file over the following ~30 s to
 * 3 min. A reader who does not know that searches for what they just wrote,
 * finds nothing and concludes the save failed — so the interface says it,
 * rather than leaving them to discover it.
 */
export const INDEX_LAG =
  'Saved. This page is already current; search results catch up in about 30 seconds to 3 minutes.';

export interface WriteGate<T> {
  /** The author fields to spread into a body, or `null` when unidentified. */
  fields: T | null;
  /** True when a write can proceed. */
  ready: boolean;
  /**
   * What a write control does when `ready` is false: open the identity prompt.
   * The same prompt the top bar opens — there is only ever one.
   */
  prompt: () => void;
}

/** The gate for the three writes whose author fields are named `author_*`. */
export function useWriteGate(): WriteGate<AuthorFields> {
  const fields = useAuthor();
  const { openEditor } = useIdentity();
  const prompt = useCallback(() => openEditor(), [openEditor]);
  return { fields, ready: fields !== null, prompt };
}

/** The same, for `POST /ledger`, which names the pair `creator_*`. */
export function useCreateGate(): WriteGate<CreatorFields> {
  const fields = useCreator();
  const { openEditor } = useIdentity();
  const prompt = useCallback(() => openEditor(), [openEditor]);
  return { fields, ready: fields !== null, prompt };
}
