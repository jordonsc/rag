/**
 * The four writes, as surfaces.
 *
 * Every one of them obeys the same three rules, which is the reason they live
 * together rather than inside the views that host them:
 *
 * * **The gate is an identity, not a permission.** `useWriteGate` is the only
 *   check, and a control it refuses stays visible and opens the prompt.
 * * **Nothing is optimistic.** A write is followed by a re-read of the topic by
 *   id, because the server decides ids, timestamps, status transitions and what
 *   `supersedes` did to the other topic.
 * * **A failed write says so.** The server's own `{"error": …}` message is what
 *   the reader sees; nothing is swallowed, and no form is left in a state where
 *   whether it saved is a guess.
 */

export { AppendPanel, type AppendPanelProps } from './AppendPanel';
export { ArchiveDialog, type ArchiveDialogProps } from './ArchiveDialog';
export { MoveDialog, type MoveDialogProps } from './MoveDialog';
export { TopicActions, type TopicActionsProps } from './TopicActions';
export { IDENTITY_NEEDED, INDEX_LAG, useCreateGate, useWriteGate, type WriteGate } from './gate';
