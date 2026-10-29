import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

import { FakeWebSocket } from './src/__tests__/fakeSocket';

// A shared, loaded host starves workers, and findBy*/waitFor give up after a
// fixed wall-clock deadline (1 s by default) whatever the CPU did meanwhile.
// 3 s keeps a real hang failing fast while a starved worker is not failed for
// being slow. The per-test budget (15 s) and the worker cap are in
// vitest.config.ts; see the note there and ledger rag-0033.
configure({ asyncUtilTimeout: 3000 });

// No test reaches a server, and that includes the tracker's event feed: every
// WebSocket is a fake a test can drive (src/__tests__/fakeSocket.ts). Assigned,
// not stubbed, so a test's vi.unstubAllGlobals() leaves it in place.
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
beforeEach(() => {
  FakeWebSocket.made = [];
});
