import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button, Dialog, Field, Form, Input } from '@rag/ui';

import { authorFields, creatorFields, type AuthorFields, type CreatorFields } from '../api';
import { isEmail, readStoredEmail, storeEmail } from './storage';

export interface Identity {
  /** The stored address, or `null` when the reader has not said who they are. */
  email: string | null;
  /** Set or clear the identity. A value that is not an address is ignored. */
  setEmail: (email: string | null) => void;
  /**
   * Open the editor.
   *
   * The one entry point for both "I want to change this" and "you are about to
   * write and have not told me who you are" — so a write flow calls this rather
   * than growing a second prompt of its own.
   */
  openEditor: () => void;
}

const IdentityContext = createContext<Identity | null>(null);

export function useIdentity(): Identity {
  const identity = useContext(IdentityContext);
  if (identity === null) {
    throw new Error('useIdentity used outside IdentityProvider');
  }
  return identity;
}

/**
 * The author fields for a write, or `null` when no identity is set.
 *
 * **The hook a write flow should use**, in preference to reading `email` and
 * assembling the body itself: the fields come from `authorFields`, which is
 * what guarantees `author_agent` is null and therefore that the write is filed
 * as a person's rather than an agent's.
 *
 * `null` is the answer to "can this person write yet", and the caller's move
 * when it comes back null is `openEditor()` — never a write with a guessed or
 * blank address, which the server would accept without complaint.
 */
export function useAuthor(): AuthorFields | null {
  const { email } = useIdentity();
  return useMemo(() => (email === null ? null : authorFields(email)), [email]);
}

/** The same, for `POST /ledger`, which names its pair `creator_*`. */
export function useCreator(): CreatorFields | null {
  const { email } = useIdentity();
  return useMemo(() => (email === null ? null : creatorFields(email)), [email]);
}

export interface IdentityProviderProps {
  children: ReactNode;
}

/**
 * Holds the identity and owns the one dialog that edits it.
 *
 * The dialog lives here rather than in the shell control so that anything can
 * summon it — the control in the top bar today, a write form tomorrow —
 * without two copies of the same form existing, and without a write flow
 * having to route a request for identity up through the tree.
 *
 * **It does not open itself on first visit.** Reads need no identity, and a
 * modal in front of a reader who came to read one topic is a toll booth on the
 * one thing this application does well. The prompt happens where it means
 * something: at the point of a write, via `openEditor`.
 */
export function IdentityProvider({ children }: IdentityProviderProps) {
  const [email, setEmailState] = useState<string | null>(() => readStoredEmail());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);

  const setEmail = useCallback((next: string | null) => {
    const value = next === null ? null : next.trim();
    if (value !== null && !isEmail(value)) {
      return;
    }
    setEmailState(value);
    storeEmail(value);
  }, []);

  const openEditor = useCallback(() => {
    setDraft(email ?? '');
    setTouched(false);
    setEditing(true);
  }, [email]);

  const identity = useMemo<Identity>(
    () => ({ email, setEmail, openEditor }),
    [email, setEmail, openEditor],
  );

  const valid = isEmail(draft);
  const submit = () => {
    setTouched(true);
    if (!valid) {
      return;
    }
    setEmail(draft);
    setEditing(false);
  };

  return (
    <IdentityContext.Provider value={identity}>
      {children}
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Who is writing?"
        width={480}
        footer={
          <>
            {email !== null && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEmail(null);
                  setEditing(false);
                }}
              >
                Forget me
              </Button>
            )}
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" onClick={submit}>
              Save
            </Button>
          </>
        }
      >
        <Form onSubmit={submit}>
          <Field
            label="Your email"
            help="Recorded as the author of anything you write to the ledger, and kept in this browser only. The server does not check it — nothing here is a login."
            error={touched && !valid ? 'That does not look like an email address.' : undefined}
          >
            <Input
              value={draft}
              onChange={(value) => setDraft(value)}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              invalid={touched && !valid}
            />
          </Field>
        </Form>
      </Dialog>
    </IdentityContext.Provider>
  );
}
