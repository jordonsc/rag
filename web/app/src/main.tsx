import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@rag/ui';
import { BrowserRouter } from 'react-router';

// The whole theme, imported once at the root. `@rag/ui` ships tokens as CSS
// rather than as a provider, so this is the only place it belongs.
import '@rag/ui/src/tokens.css';

import { App } from './App';
import { IdentityProvider } from './identity';

/**
 * `I18nProvider` covers the strings `@rag/ui` draws for *itself* — a dialog's
 * close button, a table's empty message. Application strings are written where
 * they are used: this application ships one locale and inventing a catalogue
 * for it would put every sentence one indirection away from the code that
 * decides whether to say it.
 */
const root = document.getElementById('root');
if (root === null) {
  throw new Error('no #root element in index.html');
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <IdentityProvider>
          <App />
        </IdentityProvider>
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
);
