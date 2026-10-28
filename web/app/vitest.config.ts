import react from '@vitejs/plugin-react';
import { availableParallelism } from 'node:os';
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
/**
 * Test timing on a shared host. These suites run on a box that other work
 * loads hard (load 21-32 on 12 threads has been seen), and every limit a test
 * meets is wall-clock: Vitest's per-test timeout and Testing Library's
 * findBy/waitFor deadline. A starved worker blows those budgets with no logic
 * fault, and a file's first test also carries about 1 s of cold-start CPU (JIT,
 * jsdom's first CSSOM build, the first accessible-name computation). So the
 * suite caps its workers, so that one run does not oversubscribe the box and
 * starve itself, and lifts the per-test budget to 15 s (the async-util one to
 * 3 s, in vitest.setup.ts). Per-test timeouts are not raised one by one.
 * Ledger rag-0033 (rag-t0043).
 */
const maxWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers,
    testTimeout: 15_000,
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: {
      include: [/\.module\.css$/],
      modules: { classNameStrategy: 'non-scoped' },
    },
  },
});
