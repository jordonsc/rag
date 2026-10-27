/**
 * The tracker's pages: the dashboard and the item page (specs/tracker m03),
 * the documents page, a document with its editor and history, and New concept
 * (m04), the History page of finished items (rag-t0008), and the client every
 * tracker page builds on.
 *
 * The routes are `/projects/…`, never `/tracker/…` (the API's prefix): see
 * `paths.ts`.
 */

export { DocsView } from './DocsView';
export { DocView } from './DocView';
export { HistoryView } from './HistoryView';
export { ItemView } from './ItemView';
export { NewConceptView } from './NewConceptView';
export { ProjectsView } from './ProjectsView';
export { QueueView } from './QueueView';
export {
  PROJECTS_PATH,
  docPath,
  docsPath,
  historyPath,
  itemPath,
  projectPath,
  readLastProject,
  storeLastProject,
} from './paths';
