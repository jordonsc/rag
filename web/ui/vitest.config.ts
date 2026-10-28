import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

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
