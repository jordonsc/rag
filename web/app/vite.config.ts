import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The built bundle is served same-origin by `rag-serve`, so this proxy exists
 * for `npm run dev` alone: it forwards the API paths to a live backend, which
 * means a dev session needs neither a local Qdrant nor a Voyage key.
 *
 * The default assumes `rag-serve` on this machine. A backend on another host
 * is named at the point of use — `RAG_SERVE=http://host:17793 npm run dev` —
 * rather than baked in here: this file is committed to a public repository
 * and someone else's server address is neither useful to a reader nor theirs
 * to publish.
 */
const target = process.env.RAG_SERVE ?? 'http://localhost:17793';

// The same prefixes `rag-serve` keeps out of its SPA fallback (`API_PREFIXES`
// in `crates/serve/src/web.rs`). `/projects` is deliberately absent: it is the
// tracker's pages, not its API.
const api = ['/search', '/ledger', '/health', '/info', '/reindex', '/prompts', '/tracker'];

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(api.map((path) => [path, { target, changeOrigin: true }])),
  },
});
