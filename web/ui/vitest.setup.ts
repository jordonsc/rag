import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// A shared, loaded host starves workers, and findBy*/waitFor give up after a
// fixed wall-clock deadline (1 s by default) whatever the CPU did meanwhile.
// 3 s keeps a real hang failing fast while a starved worker is not failed for
// being slow. The per-test budget (15 s) and the worker cap are in
// vitest.config.ts; see the note there and ledger rag-0033.
configure({ asyncUtilTimeout: 3000 });
