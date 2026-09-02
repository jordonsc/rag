/**
 * What every rendered test needs: a router, the design system's string
 * catalogue, and an identity that is either set or deliberately absent.
 *
 * The identity argument is the interesting one. Half the assertions in the
 * write tests are about the *unidentified* case — the gate — so "signed in or
 * not" is a parameter of the harness rather than something each test sets up.
 */

import type { ReactElement, ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { I18nProvider } from '@rag/ui';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { IdentityProvider } from '../identity';

export const AUTHOR = 'alice@example.com';
const STORAGE_KEY = 'rag.ledger.author_email';

export interface MountOptions {
  /** The address the browser has stored. `null` leaves the reader unidentified. */
  identity?: string | null;
  /** The initial URL. */
  route?: string;
}

/** Reports the current URL into the DOM so a navigation can be asserted. */
function Address() {
  const location = useLocation();
  return (
    <p data-testid="address">
      {location.pathname}
      {location.search}
    </p>
  );
}

export function mount(ui: ReactNode, options: MountOptions = {}): RenderResult {
  const { identity = AUTHOR, route = '/' } = options;
  window.localStorage.clear();
  if (identity !== null) {
    window.localStorage.setItem(STORAGE_KEY, identity);
  }
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[route]}>
        <IdentityProvider>
          <Address />
          {ui}
        </IdentityProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/**
 * The same, for a view that reads `useParams` — the route pattern has to exist
 * for `/topic/rag-0009` to resolve into an `id`.
 */
export function mountAt(pattern: string, element: ReactElement, options: MountOptions = {}) {
  return mount(
    <Routes>
      <Route path={pattern} element={element} />
      <Route path="*" element={<p>elsewhere</p>} />
    </Routes>,
    options,
  );
}
