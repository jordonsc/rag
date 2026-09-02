import { Icon, TopNav, type TopNavItem } from '@rag/ui';
import { Route, Routes, useLocation, useNavigate } from 'react-router';

import styles from './App.module.css';
import { IdentityControl } from './identity';
import { OpenTopic } from './ledger/OpenTopic';
import { ArchivedView } from './views/ArchivedView';
import { CreateView } from './views/CreateView';
import { NotFoundView } from './views/NotFoundView';
import { SearchView } from './views/SearchView';
import { TopicView } from './views/TopicView';

const NAV: readonly TopNavItem[] = [
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'archived', icon: 'archive', label: 'Archived' },
];

/**
 * Search lives at `/`, and it has to.
 *
 * `rag-serve` serves this bundle from the same origin as the API, and the paths
 * it keeps for itself — `/search`, `/ledger`, `/health`, `/info`, `/reindex` —
 * are excluded from the SPA fallback so that a mistyped endpoint stays a JSON
 * 404 rather than quietly returning an HTML page. A client route called
 * `/search` would therefore never load on a refresh or a pasted link: the
 * server would route it to the retrieval endpoint instead. The same exclusion
 * list is mirrored by the dev proxy, so it would not work in development
 * either. Every other route here is checked against that list.
 */
const PATH_FOR: Record<string, string> = {
  search: '/',
  archived: '/archived',
};

/**
 * Which destination the current URL belongs to.
 *
 * A topic detail counts as **Search**: it is where a search lands, and leaving
 * the bar with nothing marked while a topic is open would read as the reader
 * having navigated out of the application.
 */
function activeNav(pathname: string): string | undefined {
  if (pathname.startsWith('/archived')) {
    return 'archived';
  }
  if (pathname === '/' || pathname.startsWith('/topic')) {
    return 'search';
  }
  return undefined;
}

/**
 * The shell: a bar, a main region, and the routes.
 *
 * **Every view is reachable by URL and says so in the address bar** — a search
 * carries its query and filters in the query string, a topic is `/topic/{id}`.
 * That is not tidiness: the reason this application exists is that an agent
 * quotes a topic id at somebody, and pasting `…/topic/rag-0009` has to work.
 * It is also what the write milestone will use after a write — go to the topic
 * by id, rather than re-running a search the index has not caught up with yet.
 */
export function App() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className={styles.shell}>
      <TopNav
        start={
          <span className={styles.brand}>
            <Icon name="book-open" size={18} />
            <span>Ledger</span>
          </span>
        }
        items={NAV}
        activeId={activeNav(location.pathname)}
        onSelect={(id) => {
          const path = PATH_FOR[id];
          if (path !== undefined) {
            navigate(path);
          }
        }}
        onAction={() => navigate('/new')}
        actionLabel="New topic"
        end={
          <>
            {/* **The id box lives in the shell, not on a page.** Opening a
                quoted id is the reason this viewer exists, and until now the
                only box that did it was on the 404 page — an affordance you
                find by first getting lost. In the bar it is on screen from
                every view, including the topic page, where the next thing a
                reader does with an id is usually to follow another one. */}
            <OpenTopic label="Open a topic by id" actionLabel="Open topic" compact />
            <IdentityControl />
          </>
        }
        label="Ledger views"
      />
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<SearchView />} />
          <Route path="/archived" element={<ArchivedView />} />
          <Route path="/topic/:id" element={<TopicView />} />
          <Route path="/new" element={<CreateView />} />
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </main>
    </div>
  );
}
