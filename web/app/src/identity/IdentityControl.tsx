import { Icon, Tooltip } from '@rag/ui';

import styles from './identity.module.css';
import { useIdentity } from './IdentityProvider';

/**
 * The identity, in the top bar, always visible and always editable.
 *
 * A button rather than a label, because the failure this exists to avoid is an
 * address captured once on a first visit and then unreachable — the person who
 * typed it on the wrong machine, or typed it wrong, has nowhere to go. It reads
 * out what is stored, and pressing it opens the same editor a write flow does.
 *
 * Unset is drawn as an ordinary, quiet prompt rather than as a warning. Nothing
 * is broken while it is empty: the whole viewer works without it, and it is
 * only a write that needs an answer.
 */
export function IdentityControl() {
  const { email, openEditor } = useIdentity();
  const set = email !== null;

  return (
    <Tooltip
      title={set ? 'Signed as' : 'Not signed'}
      text={
        set
          ? `${email} — kept in this browser, sent as the author of anything you write.`
          : 'Set the address the ledger records as the author of your writes.'
      }
      placement="bottom"
    >
      <button
        type="button"
        className={styles.control}
        onClick={openEditor}
        aria-label={set ? `Signed as ${email}. Change.` : 'Set your email'}
      >
        <Icon name="user" size={14} />
        <span className={styles.value}>{set ? email : 'Set your email'}</span>
      </button>
    </Tooltip>
  );
}
