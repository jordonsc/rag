/**
 * Which of the two applications this browser was last in: the ledger or the
 * tracker (rag-t0072). Search opens on that one's corpus when its address
 * names none, so a reader who has been working tickets searches tickets.
 *
 * Set by the shell from the page open (a tracker page or a ledger page; Search
 * itself is neither, so passing through it changes nothing) and by a search
 * run, which is an explicit choice of corpus. With nothing remembered it is
 * the tracker.
 *
 * Kept per browser in `localStorage`, guarded as `tracker/paths.ts` guards the
 * last project: storage that throws reads as nothing remembered, and a choice
 * that cannot be stored is simply not remembered.
 */

export type App = 'tracker' | 'ledger';

const STORAGE_KEY = 'rag.lastApp';

export function isApp(value: unknown): value is App {
  return value === 'tracker' || value === 'ledger';
}

export function readLastApp(): App {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isApp(stored) ? stored : 'tracker';
  } catch {
    return 'tracker';
  }
}

export function storeLastApp(app: App): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, app);
  } catch {
    // Storage refused: Search falls back to the tracker.
  }
}

/**
 * The application a page belongs to: the tracker's pages are `/projects…`, the
 * ledger's are a topic, the archive and New topic. Search (`/`) and the 404
 * page are neither: `null`, so they leave the last one standing.
 */
export function appOfPath(pathname: string): App | null {
  if (pathname === '/projects' || pathname.startsWith('/projects/')) {
    return 'tracker';
  }
  if (
    pathname.startsWith('/topic/') ||
    pathname === '/archived' ||
    pathname.startsWith('/archived/') ||
    pathname === '/new'
  ) {
    return 'ledger';
  }
  return null;
}
