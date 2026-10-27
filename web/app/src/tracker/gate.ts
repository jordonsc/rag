/**
 * The identity gate for tracker writes (D17).
 *
 * The ledger's rule, unchanged: the identity is the stored email, a write
 * control is **shown and enabled** without one, and pressing it opens the one
 * identity prompt instead of writing. What differs is the fields: the tracker
 * refuses unknown fields, so the ledger's `author_agent: null` must never
 * reach it, and its writes carry `surface: 'web'` instead.
 */

import { useCallback, useMemo } from 'react';

import { useIdentity } from '../identity';
import type { WriteGate } from '../writes';
import { trackerAuthor } from './api';
import type { TrackerAuthor } from './types';

/** Said beside a tracker write control that would prompt rather than write. */
export const TRACKER_IDENTITY_NEEDED =
  'The tracker records an author on every change. Set your email and this will write.';

export function useTrackerGate(): WriteGate<TrackerAuthor> {
  const { email, openEditor } = useIdentity();
  const fields = useMemo(() => (email === null ? null : trackerAuthor(email)), [email]);
  const prompt = useCallback(() => openEditor(), [openEditor]);
  return { fields, ready: fields !== null, prompt };
}
