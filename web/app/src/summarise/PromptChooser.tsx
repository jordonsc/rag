import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  type SelectOption,
} from '@rag/ui';

import {
  PROMPT_NAME_ERROR,
  PROMPT_NAME_MAX,
  asApiError,
  deletePrompt,
  isPromptName,
  savePrompt,
  type LedgerApiError,
  type SavedPrompt,
} from '../api';
import styles from './summarise.module.css';

/**
 * The chooser's value for the **built-in** prompt.
 *
 * The empty string, and it can only ever mean the built-in: a saved prompt's
 * name is a filename, and the server refuses a blank one. `Select` draws no
 * placeholder lead when the option set offers `''` itself, which is exactly the
 * case here — the built-in is a real choice with a label, not an absent one.
 */
export const BUILT_IN = '';

/** What the built-in is called on screen. */
export const BUILT_IN_LABEL = 'Default (built in)';

/** Said where the server has no prompts directory. Not an error: a deployment. */
export const NO_LIBRARY =
  'This server keeps no prompt library, so there is nothing to save to. The built-in ' +
  'instruction is still editable for a single run.';

export interface PromptChooserProps {
  /** Every saved prompt. The built-in is **not** among them and never is. */
  prompts: readonly SavedPrompt[];
  /** Whether the server has a prompts directory. `false` hides Save and New. */
  configured: boolean;
  /** The selection: {@link BUILT_IN}, or a saved prompt's name. */
  selected: string;
  /** Called once a switch is settled — after confirming any unsaved edit. */
  onSelect: (name: string) => void;
  /** What is in the instruction box now. This is what Save writes. */
  text: string;
  /** The box differs from the selected prompt's saved body. */
  edited: boolean;
  /** Everything is off (no Anthropic key, configuration still loading). */
  disabled?: boolean;
  /** A prompt was written. The list and the selection are the caller's to hold. */
  onSaved: (prompt: SavedPrompt) => void;
  /** A prompt was removed. */
  onDeleted: (name: string) => void;
}

/**
 * Pick, save and delete the instruction the Summarise run will use.
 *
 * A prompt is a Markdown file on the server (`~/rag/prompts/{name}.md`), and
 * this is the browser's view of that directory. Four decisions worth stating,
 * because each of them is a thing that could reasonably have gone the other
 * way:
 *
 * * **The built-in is permanent and is not a file.** It sits at the top of the
 *   list, comes from `/info` rather than from the library, and has no Delete.
 *   Saving an edited version of it is a *new* prompt and needs a name — which
 *   is why Save opens the naming dialog when the built-in is selected instead
 *   of failing or, worse, quietly overwriting something.
 * * **An unsaved edit is never lost to a change of selection.** Switching away
 *   from an edited box asks first. The alternative — silently discarding what
 *   someone just wrote because they wanted to look at another prompt — is the
 *   one failure here that destroys work.
 * * **The name rules are the server's**, mirrored here only so a person is told
 *   what to type before a round trip. The endpoint writes a file and has no
 *   authentication; the barrier is `crates/serve/src/prompts.rs`, not this.
 * * **A server with no prompts directory says so and offers no Save.** The
 *   built-in is still editable for a single run, because the instruction is
 *   sent with the request whether or not it was ever stored.
 */
export function PromptChooser({
  prompts,
  configured,
  selected,
  onSelect,
  text,
  edited,
  disabled = false,
  onSaved,
  onDeleted,
}: PromptChooserProps) {
  // A selection waiting on the reader to agree that an unsaved edit may go.
  const [pending, setPending] = useState<string | null>(null);
  // The naming dialog: `null` is closed. Open when Save has nowhere to write
  // (the built-in is selected) and whenever New is pressed.
  const [naming, setNaming] = useState<string | null>(null);
  const [named, setNamed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const isBuiltIn = selected === BUILT_IN;
  const options: readonly SelectOption[] = [
    { value: BUILT_IN, label: BUILT_IN_LABEL },
    ...prompts.map((prompt) => ({ value: prompt.name, label: prompt.name })),
  ];

  const trimmed = (naming ?? '').trim();
  const nameError =
    trimmed === ''
      ? 'A prompt needs a name — it becomes a file on the server.'
      : !isPromptName(trimmed)
        ? PROMPT_NAME_ERROR
        : undefined;
  const replacing = prompts.some((prompt) => prompt.name === trimmed);

  /** Move the selection, asking first if that would throw away an edit. */
  const choose = (name: string) => {
    if (name === selected) {
      return;
    }
    setError(null);
    if (edited) {
      setPending(name);
      return;
    }
    onSelect(name);
  };

  const write = (name: string) => {
    setBusy(true);
    setError(null);
    savePrompt({ name, body: text })
      .then((saved) => {
        setBusy(false);
        setNaming(null);
        setNamed(false);
        onSaved(saved);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  const save = () => {
    // Nothing to write to: the built-in is a constant, not a file. Ask for a
    // name rather than refusing — "save this" and "save this as" are the same
    // intention, and only one of them is possible here.
    if (isBuiltIn) {
      setNaming('');
      setNamed(false);
      setError(null);
      return;
    }
    write(selected);
  };

  const remove = () => {
    setBusy(true);
    setError(null);
    deletePrompt(selected)
      .then(() => {
        setBusy(false);
        setConfirmDelete(false);
        onDeleted(selected);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setConfirmDelete(false);
        setError(asApiError(cause));
      });
  };

  return (
    <>
      {/* The chooser and its actions on one line. The Field wraps the Select
          alone — its label has to point at a real control, and the Instruction
          box below carries its own. */}
      <div className={styles.library}>
        <Field label="Saved prompt">
          <Select value={selected} onChange={choose} options={options} disabled={disabled} />
        </Field>
        {configured && (
          <div className={styles.libraryActions}>
            <Button
              onClick={save}
              disabled={disabled || busy || text.trim() === ''}
              title={isBuiltIn ? 'Save this instruction as a new prompt' : `Save over ${selected}`}
            >
              Save
            </Button>
            <Button
              onClick={() => {
                setNaming('');
                setNamed(false);
                setError(null);
              }}
              disabled={disabled || busy || text.trim() === ''}
              title="Save this instruction under a new name"
            >
              New
            </Button>
            {/* No Delete for the built-in, rather than a disabled one: it is
                not a file, so deleting it is not a thing that could happen. */}
            {!isBuiltIn && (
              <Button
                variant="danger"
                onClick={() => setConfirmDelete(true)}
                disabled={disabled || busy}
              >
                Delete
              </Button>
            )}
          </div>
        )}
      </div>

      {!configured && (
        <p className={styles.notice}>
          <Icon name="info" size={14} />
          <span>{NO_LIBRARY}</span>
        </p>
      )}

      {/* A failure from the row's own Save or Delete. Suppressed while the
          naming dialog is open, which draws the same error where the reader is
          actually looking — two copies of one failure read as two failures. */}
      {error !== null && naming === null && (
        <p className={styles.failed} role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{error.message}</span>
        </p>
      )}

      {/* Switching selection with an edit in the box. Not a silent discard:
          the box is where someone's thinking went, and the list is one click
          away from throwing it out. */}
      <ConfirmDialog
        open={pending !== null}
        title="Discard your unsaved changes?"
        danger
        confirmLabel="Discard and switch"
        message={
          <p>
            The instruction has been edited and not saved
            {isBuiltIn ? '' : ` to ${selected}`}. Switching to{' '}
            <strong>{pending === BUILT_IN ? BUILT_IN_LABEL : pending}</strong> replaces what is in
            the box.
          </p>
        }
        onConfirm={() => {
          const next = pending;
          setPending(null);
          if (next !== null) {
            onSelect(next);
          }
        }}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete the prompt “${selected}”?`}
        danger
        busy={busy}
        confirmLabel="Delete it"
        message={
          <p>
            The file <code>{selected}.md</code> is removed from the server. Nothing else is
            affected, and the built-in instruction is always available.
          </p>
        }
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />

      <Dialog
        open={naming !== null}
        onClose={() => {
          setNaming(null);
          setNamed(false);
          setError(null);
        }}
        title="Save this instruction as…"
        footer={
          <>
            <Button
              onClick={() => {
                setNaming(null);
                setNamed(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                setNamed(true);
                if (nameError === undefined && !busy) {
                  write(trimmed);
                }
              }}
            >
              {replacing ? 'Replace it' : 'Save it'}
            </Button>
          </>
        }
      >
        <div className={styles.dialogBody}>
          <Field
            label="Name"
            help={`Letters, digits, spaces, - and _; at most ${PROMPT_NAME_MAX} characters. It becomes the filename.`}
            error={named ? nameError : undefined}
          >
            <Input
              value={naming ?? ''}
              onChange={setNaming}
              placeholder="e.g. What changed"
              spellCheck={false}
              invalid={named && nameError !== undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  setNamed(true);
                  if (nameError === undefined && !busy) {
                    write(trimmed);
                  }
                }
              }}
            />
          </Field>
          {replacing && (
            <p className={styles.notice}>
              <Icon name="triangle-alert" size={14} />
              <span>
                A prompt called <strong>{trimmed}</strong> already exists and will be replaced.
              </span>
            </p>
          )}
          {error !== null && (
            <p className={styles.failed} role="alert">
              <Icon name="triangle-alert" size={14} />
              <span>{error.message}</span>
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
