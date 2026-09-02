/**
 * Who the person at the keyboard is, as far as the ledger is concerned.
 *
 * `rag-serve` has no notion of a caller: `author_email` is a required field on
 * the body of every write and is never checked against anything. That is the
 * same posture as the rest of the system — any client on the LAN can already
 * write as any author — and this application does not pretend otherwise. It is
 * an identity a person asserts about themselves, held in their own browser, and
 * it is worth exactly what a self-asserted field is worth.
 *
 * What follows from that, and is built to rather than around:
 *
 * * **Reads need no identity at all.** Nothing here gates the viewer.
 * * The value must be **editable, visibly**, not captured once and buried.
 * * It must be validated *here*, because nothing downstream will.
 */

const STORAGE_KEY = 'rag.ledger.author_email';

/**
 * A shape check, not a proof.
 *
 * Deliberately loose: something before an `@`, something after it, a dot in the
 * domain, no whitespace anywhere. A stricter pattern would reject addresses
 * that are perfectly valid, and would still not tell us whether the person owns
 * the one they typed — which is the question that actually matters and which
 * nothing in this system can answer.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/**
 * The stored identity, or `null`.
 *
 * Every access is guarded: `localStorage` throws rather than returning
 * undefined when a browser is configured to refuse site data, and an identity
 * that cannot be remembered must degrade to *no identity* rather than to a
 * blank page.
 */
export function readStoredEmail(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && isEmail(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Store an identity, or clear it with `null`. */
export function storeEmail(email: string | null): void {
  try {
    if (email === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, email);
    }
  } catch {
    // Storage refused. The value still stands for this session — it lives in
    // React state — it simply will not survive a reload. Failing the edit
    // outright would be worse.
  }
}
