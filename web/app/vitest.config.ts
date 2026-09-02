import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The application's own test setup, deliberately the same arrangement as
 * `@rag/ui`'s: jsdom, globals, and CSS modules compiled rather than stubbed so
 * that a class name asserted in a test is the one the browser would carry.
 *
 * It differs from the design system's in one respect — the React plugin. These
 * tests render components that use hooks across module boundaries and rely on
 * Fast Refresh-free but plugin-provided JSX handling, so the same transform the
 * dev server and the production build use is the one the tests run against.
 * Nothing here proxies to a server: every test that touches the network stubs
 * `fetch` itself.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: {
      include: [/\.module\.css$/],
      modules: { classNameStrategy: 'non-scoped' },
    },
  },
});
