/**
 * Identity: who the person at the keyboard says they are.
 *
 * There is no login here and there is not meant to be — `rag-serve` has no
 * notion of a caller and never checks `author_email`. So the interesting cases
 * are not "does the password work", they are:
 *
 * * **The storage can throw.** A private window, a browser set to refuse site
 *   data, and `window.localStorage.getItem` raises rather than returning null.
 *   An identity that cannot be remembered must degrade to *no identity*, never
 *   to a blank page — the viewer's whole read side needs no identity at all.
 * * **`useAuthor()` returning null is the write gate**, and the house rule is
 *   easy to get backwards: the control stays visible and enabled, and pressing
 *   it opens the prompt rather than writing.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { IdentityProvider, isEmail, readStoredEmail, storeEmail, useIdentity } from '../identity';
import { useWriteGate } from '../writes';

const KEY = 'rag.ledger.author_email';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isEmail', () => {
  it.each([
    'alice@example.com',
    'a.b+tag@example.co.uk',
    '  alice@example.com  ',
    "o'brien@example.com",
  ])('accepts %j', (value) => {
    expect(isEmail(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'alice',
    'alice@',
    '@example.com',
    'alice@example',
    'alice example@com',
    'alice@exa mple.com',
    'alice@@example.com',
  ])('rejects %j', (value) => {
    expect(isEmail(value)).toBe(false);
  });
});

describe('stored identity', () => {
  it('reads back what was stored', () => {
    storeEmail('alice@example.com');
    expect(window.localStorage.getItem(KEY)).toBe('alice@example.com');
    expect(readStoredEmail()).toBe('alice@example.com');
  });

  it('clears with null', () => {
    storeEmail('alice@example.com');
    storeEmail(null);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(readStoredEmail()).toBeNull();
  });

  it('ignores a stored value that is not an address', () => {
    // Anything could have put this here — an older build, a hand-edited store.
    // Validating on read is what stops it reaching a write body.
    window.localStorage.setItem(KEY, 'not-an-address');
    expect(readStoredEmail()).toBeNull();
  });

  it('returns null when there is nothing stored', () => {
    expect(readStoredEmail()).toBeNull();
  });

  it('survives storage that throws on read', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('site data is blocked', 'SecurityError');
    });
    expect(readStoredEmail()).toBeNull();
  });

  it('survives storage that throws on write', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => storeEmail('alice@example.com')).not.toThrow();
  });

  it('survives storage that throws on clear', () => {
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('site data is blocked', 'SecurityError');
    });
    expect(() => storeEmail(null)).not.toThrow();
  });
});

// ---- The provider -----------------------------------------------------------

/** Reports the gate's answer, and offers the two things a caller can do. */
function Probe() {
  const gate = useWriteGate();
  const { email, setEmail } = useIdentity();
  return (
    <div>
      <p data-testid="fields">{gate.fields === null ? 'none' : JSON.stringify(gate.fields)}</p>
      <p data-testid="ready">{String(gate.ready)}</p>
      <p data-testid="email">{email ?? 'unset'}</p>
      <button type="button" onClick={gate.prompt}>
        Write something
      </button>
      <button type="button" onClick={() => setEmail('bob@example.com')}>
        Set directly
      </button>
      <button type="button" onClick={() => setEmail('nonsense')}>
        Set rubbish
      </button>
    </div>
  );
}

function mount() {
  return render(
    <IdentityProvider>
      <Probe />
    </IdentityProvider>,
  );
}

describe('IdentityProvider', () => {
  it('starts from the stored address', () => {
    window.localStorage.setItem(KEY, 'alice@example.com');
    mount();
    expect(screen.getByTestId('email')).toHaveTextContent('alice@example.com');
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
  });

  it('starts unset, and does not prompt on a first visit', () => {
    mount();
    expect(screen.getByTestId('email')).toHaveTextContent('unset');
    // Reads need no identity. A modal in front of somebody who came to read one
    // topic is a toll booth on the one thing this application does well.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders, unset, when storage throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('site data is blocked', 'SecurityError');
    });
    expect(() => mount()).not.toThrow();
    expect(screen.getByTestId('email')).toHaveTextContent('unset');
    expect(screen.getByTestId('ready')).toHaveTextContent('false');
  });

  it('keeps an identity for the session even when it cannot be persisted', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    mount();
    await user.click(screen.getByRole('button', { name: 'Set directly' }));
    // Failing the edit outright would be worse than not remembering it.
    expect(screen.getByTestId('email')).toHaveTextContent('bob@example.com');
  });

  it('refuses to set a value that is not an address', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Set rubbish' }));
    expect(screen.getByTestId('email')).toHaveTextContent('unset');
  });

  /**
   * The whole gate. `fields` is what a write spreads into its body, so a null
   * here is the difference between prompting and writing as nobody.
   */
  it('hands out author fields with a null agent, and null when unset', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByTestId('fields')).toHaveTextContent('none');

    await user.click(screen.getByRole('button', { name: 'Set directly' }));
    expect(screen.getByTestId('fields')).toHaveTextContent(
      JSON.stringify({ author_email: 'bob@example.com', author_agent: null }),
    );
  });

  it('opens the one editor when a write is attempted without an identity', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Write something' }));

    const dialog = screen.getByRole('dialog', { name: 'Who is writing?' });
    expect(dialog).toBeInTheDocument();
    // The prompt *is* the response to pressing a write control. It is not an
    // error, and the control was neither hidden nor disabled.
    expect(screen.getByRole('button', { name: 'Write something' })).toBeEnabled();
  });

  it('saves a valid address from the editor and remembers it', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Write something' }));
    await user.type(screen.getByLabelText('Your email'), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(window.localStorage.getItem(KEY)).toBe('alice@example.com');
  });

  it('refuses to save a malformed address and says why', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Write something' }));
    await user.type(screen.getByLabelText('Your email'), 'alice');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('That does not look like an email address.')).toBeInTheDocument();
    expect(screen.getByTestId('ready')).toHaveTextContent('false');
  });

  it('forgets an identity on request', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(KEY, 'alice@example.com');
    mount();
    await user.click(screen.getByRole('button', { name: 'Write something' }));
    await user.click(screen.getByRole('button', { name: 'Forget me' }));

    expect(screen.getByTestId('email')).toHaveTextContent('unset');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('offers nothing to forget when there is no identity', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Write something' }));
    expect(screen.queryByRole('button', { name: 'Forget me' })).not.toBeInTheDocument();
  });

  it('leaves the identity alone when the editor is cancelled', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(KEY, 'alice@example.com');
    mount();
    await user.click(screen.getByRole('button', { name: 'Write something' }));
    await user.clear(screen.getByLabelText('Your email'));
    await user.type(screen.getByLabelText('Your email'), 'bob@example.com');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByTestId('email')).toHaveTextContent('alice@example.com');
  });

  it('refuses to be used outside the provider', () => {
    // A write surface rendered outside the provider would otherwise silently
    // have no identity rather than failing where the mistake is.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/IdentityProvider/);
    quiet.mockRestore();
  });
});
