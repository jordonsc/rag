/**
 * The tracker's client: every route m01 built, typed, in one module.
 *
 * The contract is `specs/tracker/api.md`. This mirrors `api/client.ts` in the
 * things that matter — relative paths (the bundle is served same-origin by
 * `rag-serve`, so there is no CORS and none should be added), the server's own
 * `{"error": …}` sentence as the message a person sees, an abort rethrown
 * untouched — and differs in three:
 *
 * * **Every write carries `surface: 'web'`** and no `agent` (D10, D17): the web
 *   app is the owner at the keyboard. The fields are built by
 *   {@link trackerAuthor} and nowhere else.
 * * **The queue view is a conditional read.** The dashboard polls it every
 *   10 s; {@link getQueue} sends `If-None-Match` and a 304 comes back as
 *   `unchanged`, so an idle dashboard costs a header round trip and no render.
 * * **A stale document write is a 409 carrying the current document**, kept on
 *   the error ({@link TrackerApiError.conflict}) so a caller can show the newer
 *   text without another request.
 *
 * The documents, specs, concepts and attachments calls are here although the
 * dashboard (m03) does not use them all: the documents pages (m04) build on
 * this same module rather than growing a second client.
 *
 * **Nothing is optimistic.** A write returns what the server sent; the caller
 * re-reads. The server decides the event, the timestamps, whether a transition
 * was legal and where a reopened item landed.
 */

import { LedgerApiError } from '../api';
import { isRepoName } from '../ledger/ids';
import { LABEL_MAX, labelKey, labelProblem, normaliseLabel } from './labels';
import type {
  AckDoneResponse,
  Attachment,
  AttachmentsResponse,
  CheckResponse,
  Concept,
  ConceptCreate,
  ConceptState,
  ConceptUpdate,
  ConceptsResponse,
  DiffResponse,
  DocCreate,
  DocEdit,
  DocRename,
  DocRestore,
  DocWrite,
  DocumentKind,
  DocumentView,
  DocumentsResponse,
  Item,
  ItemCreate,
  ItemStatus,
  ItemUpdate,
  ItemsResponse,
  LabelsResponse,
  Milestone,
  MilestoneCreate,
  MilestoneUpdate,
  Place,
  ProjectsResponse,
  QueueView,
  RevisionsResponse,
  Spec,
  SpecCreate,
  SpecUpdate,
  SpecsResponse,
  TrackerAuthor,
  TrackerSearchResponse,
} from './types';

// ---- Errors -----------------------------------------------------------------

/** What a 409 on a document write carries (api.md § Errors). */
export interface DocConflict {
  current_revision: number;
  current: DocumentView;
}

/**
 * A failed tracker request.
 *
 * A subclass of the ledger's error so that `asApiError`, and every view that
 * already renders one, handles it unchanged.
 */
export class TrackerApiError extends LedgerApiError {
  /** Set on a 409 from a document edit, write or restore. */
  readonly conflict: DocConflict | null;

  constructor(status: number, message: string, detail = '', conflict: DocConflict | null = null) {
    super(status, message, detail);
    this.name = 'TrackerApiError';
    this.conflict = conflict;
  }
}

function parsed(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorFor(status: number, body: string): TrackerApiError {
  const json = parsed(body);
  const stated =
    json !== null && typeof json.error === 'string' && json.error !== '' ? json.error : null;
  if (status === 422) {
    // Axum's own rejection, before the handler ran: plain text, not `{error}`.
    return new TrackerApiError(
      status,
      'The request was rejected before it reached the tracker — a required field was missing or the wrong type.',
      body,
    );
  }
  let conflict: DocConflict | null = null;
  if (status === 409 && json !== null && typeof json.current_revision === 'number') {
    conflict = {
      current_revision: json.current_revision,
      current: json.current as DocumentView,
    };
  }
  return new TrackerApiError(
    status,
    stated ?? `The server answered ${status} with no stated reason.`,
    body,
    conflict,
  );
}

/** A refusal raised here, before anything is sent. */
function refuse(message: string): never {
  throw new TrackerApiError(0, message);
}

// ---- Transport --------------------------------------------------------------

interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** JSON body; present makes it a POST. */
  json?: unknown;
  /** Multipart body; present makes it a POST. */
  form?: FormData;
  /** Sent as `If-None-Match`; a 304 then resolves `unchanged`. */
  etag?: string | null;
}

type Fetched<T> = { kind: 'fresh'; data: T; etag: string | null } | { kind: 'unchanged' };

async function send<T>(path: string, options: RequestOptions = {}): Promise<Fetched<T>> {
  const { signal, json, form, etag } = options;
  const post = json !== undefined || form !== undefined;
  const headers: Record<string, string> = {};
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (etag !== undefined && etag !== null) {
    headers['if-none-match'] = etag;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: post ? 'POST' : 'GET',
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      ...(form !== undefined ? { body: form } : {}),
      // A conditional read is answered by the server, never by the browser's
      // cache: with the validator set by hand, the 304 must reach this code.
      ...(etag !== undefined ? { cache: 'no-store' as const } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new TrackerApiError(0, 'The server could not be reached.', String(cause));
  }

  if (response.status === 304) {
    return { kind: 'unchanged' };
  }
  const text = await response.text();
  if (!response.ok) {
    throw errorFor(response.status, text);
  }
  try {
    return {
      kind: 'fresh',
      data: JSON.parse(text) as T,
      etag: response.headers?.get('etag') ?? null,
    };
  } catch {
    throw new TrackerApiError(
      response.status,
      'The server answered with something that is not JSON.',
      text,
    );
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const fetched = await send<T>(path, options);
  if (fetched.kind === 'unchanged') {
    // Only a conditional read can see a 304, and none of those come here.
    throw new TrackerApiError(304, 'The server answered 304 to an unconditional request.');
  }
  return fetched.data;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

const enc = encodeURIComponent;

// ---- Names ------------------------------------------------------------------

/** Project names the server keeps for its own routes (api.md § Names). */
export const RESERVED_PROJECTS: readonly string[] = ['items', 'docs', 'attachments', 'projects'];

export const PROJECT_NAME_ERROR =
  'A project is a repository name: letters, digits, dots, dashes and underscores, starting with a letter or digit, at most 64 characters.';

/**
 * Whether a project name is one the server accepts.
 *
 * The charset is `isRepoName`'s (one module spells it); the first character,
 * the length and the reserved words are the tracker's own additions.
 */
export function isProjectName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    isRepoName(name) &&
    /^[0-9a-z]/i.test(name) &&
    !RESERVED_PROJECTS.includes(name)
  );
}

/**
 * The author fields for a write from this application.
 *
 * `surface: 'web'` is what marks a write as the owner's at the keyboard (D10),
 * and `agent` is never sent. Built here and nowhere else.
 */
export function trackerAuthor(email: string): TrackerAuthor {
  return { author_email: email, surface: 'web' };
}

function author(fields: TrackerAuthor): TrackerAuthor {
  if (fields.author_email.trim() === '') {
    refuse('No author address. Set your email before writing.');
  }
  return { author_email: fields.author_email, surface: 'web' };
}

function placeFields(place: Place | undefined): Record<string, string | boolean> {
  if (place === undefined) {
    return {};
  }
  return { ...place };
}

/** Said when a bare note (Add note) is blank: the one write a note is all of. */
const NOTE_NEEDED = 'A note needs some text.';

function blank(text: string | undefined): boolean {
  return text === undefined || text.trim() === '';
}

/**
 * The body as sent: a blank `note` is dropped. A note is optional on every
 * change (D7, amended by the owner 2026-10-27): without one the server writes
 * the event's body from the change (`Status: pending → done.`).
 */
function withoutBlankNote<T extends { note?: string }>(body: T): T {
  if (body.note === undefined || !blank(body.note)) {
    return body;
  }
  const { note: _blank, ...rest } = body;
  return rest as T;
}

/**
 * An update's body, refused when it would change nothing: with no field, it is
 * a bare note (Add note), which needs text.
 */
function updateBody<T extends { note?: string }>(body: T): T {
  const sent = withoutBlankNote(body);
  if (Object.values(sent).every((value) => value === undefined)) {
    refuse(body.note === undefined ? 'Nothing to send.' : NOTE_NEEDED);
  }
  return sent;
}

// ---- Projects and the queue -------------------------------------------------

export function listProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
  return request<ProjectsResponse>('/tracker/projects', { signal });
}

/** What {@link getQueue} resolves to. `unchanged` is a 304: keep what you have. */
export type QueueFetch =
  { kind: 'fresh'; view: QueueView; etag: string | null } | { kind: 'unchanged' };

/**
 * The dashboard's read (D14): done, the queue in list order, blocked.
 *
 * Pass the `etag` of the view in hand to make it conditional; `null` or
 * absent fetches it whole.
 */
export async function getQueue(
  project: string,
  etag?: string | null,
  signal?: AbortSignal,
): Promise<QueueFetch> {
  const fetched = await send<QueueView>(`/tracker/${enc(project)}`, {
    signal,
    etag: etag ?? null,
  });
  return fetched.kind === 'unchanged'
    ? fetched
    : { kind: 'fresh', view: fetched.data, etag: fetched.etag };
}

export function checkQueue(project: string, signal?: AbortSignal): Promise<CheckResponse> {
  return request<CheckResponse>(`/tracker/${enc(project)}/check`, { signal });
}

/** Acknowledge every done item: they leave the dashboard, not the history. */
export async function ackDone(
  project: string,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<AckDoneResponse> {
  return request<AckDoneResponse>(`/tracker/${enc(project)}/ack-done`, {
    signal,
    json: author(fields),
  });
}

// ---- Items ------------------------------------------------------------------

export function listItems(
  project: string,
  status?: ItemStatus,
  signal?: AbortSignal,
): Promise<ItemsResponse> {
  return request<ItemsResponse>(`/tracker/${enc(project)}/items${query({ status })}`, { signal });
}

/**
 * A project's label vocabulary (rag-t0027): each label its items carry, in the
 * project's casing, with how many items carry it. The editors' suggestions.
 */
export function listLabels(project: string, signal?: AbortSignal): Promise<LabelsResponse> {
  return request<LabelsResponse>(`/tracker/${enc(project)}/labels`, { signal });
}

/** Why a gate cannot be parallel: it is what parallel work lands after. */
export const PARALLEL_GATE = 'A gate cannot be parallel.';

/** Blocking on a dependency names what it waits on (rag-t0018). */
export const DEPENDS_ON_NEEDED = 'Choose at least one ticket it waits on.';

/** Refuse a label set the server would refuse (rag-t0027), before sending it. */
function checkLabels(labels: readonly string[] | undefined): void {
  if (labels === undefined) {
    return;
  }
  for (const label of labels) {
    const problem = labelProblem(label);
    if (problem !== null) {
      refuse(problem);
    }
  }
  if (new Set(labels.map((label) => labelKey(normaliseLabel(label)))).size > LABEL_MAX) {
    refuse(`A ticket carries at most ${LABEL_MAX} labels.`);
  }
}

/** Create an item. It joins the bottom unless `place` says otherwise. */
export async function createItem(
  project: string,
  body: ItemCreate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Item> {
  if (body.title.trim() === '') {
    refuse('A ticket needs a title.');
  }
  if (body.type === 'gate' && body.intensity === undefined) {
    refuse('A gate needs an intensity.');
  }
  if (body.type === 'gate' && body.parallel === true) {
    refuse(PARALLEL_GATE);
  }
  checkLabels(body.labels);
  const { place, ...rest } = withoutBlankNote(body);
  return request<Item>(`/tracker/${enc(project)}/items`, {
    signal,
    json: { ...rest, ...placeFields(place), ...author(fields) },
  });
}

export function getItem(
  id: string,
  options: { history?: boolean } = {},
  signal?: AbortSignal,
): Promise<Item> {
  const history = options.history === false ? query({ history: false }) : '';
  return request<Item>(`/tracker/items/${enc(id)}${history}`, { signal });
}

/**
 * Update an item. The note is optional with any change (D7, amended
 * 2026-10-27); an update that changes nothing else is a note, and needs text.
 */
export async function updateItem(
  id: string,
  body: ItemUpdate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Item> {
  if (body.title !== undefined && body.title.trim() === '') {
    refuse('A ticket needs a title.');
  }
  if (
    body.block_reason === 'dependency' &&
    (body.depends_on ?? []).every((id) => id.trim() === '') &&
    (body.depends_on !== undefined || body.blocked === true)
  ) {
    refuse(DEPENDS_ON_NEEDED);
  }
  checkLabels(body.labels);
  const sent = updateBody(body);
  return request<Item>(`/tracker/items/${enc(id)}`, {
    signal,
    json: { ...sent, ...author(fields) },
  });
}

/** Move a queued item. Never by position: before, after, top or bottom. */
export async function moveItem(
  id: string,
  place: Place,
  fields: TrackerAuthor,
  note?: string,
  signal?: AbortSignal,
): Promise<Item> {
  return request<Item>(`/tracker/items/${enc(id)}/move`, {
    signal,
    json: { ...place, ...(blank(note) ? {} : { note }), ...author(fields) },
  });
}

// ---- Documents --------------------------------------------------------------

export function listDocs(
  project: string,
  filter: { kind?: DocumentKind; prefix?: string } = {},
  signal?: AbortSignal,
): Promise<DocumentsResponse> {
  return request<DocumentsResponse>(
    `/tracker/${enc(project)}/docs${query({ kind: filter.kind, prefix: filter.prefix })}`,
    { signal },
  );
}

/** A free-standing document (kind `doc`). */
export async function createDoc(
  project: string,
  body: DocCreate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(`/tracker/${enc(project)}/docs`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

export interface DocRead {
  /** An older revision's body; the response's `revision` stays the current one. */
  revision?: number;
  history?: boolean;
}

/** A document by path. An old path redirects (`redirected_from`). */
export function getDocByPath(
  project: string,
  path: string,
  read: DocRead = {},
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(
    `/tracker/${enc(project)}/doc${query({
      path,
      revision: read.revision,
      history: read.history === false ? false : undefined,
    })}`,
    { signal },
  );
}

export function getDoc(
  id: string,
  read: DocRead = {},
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(
    `/tracker/docs/${enc(id)}${query({
      revision: read.revision,
      history: read.history === false ? false : undefined,
    })}`,
    { signal },
  );
}

/** Exact replacements against a base revision; a stale base is a 409. */
export async function editDoc(
  id: string,
  body: DocEdit,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(`/tracker/docs/${enc(id)}/edit`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

/** A whole new body against a base revision; a stale base is a 409. */
export async function writeDoc(
  id: string,
  body: DocWrite,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(`/tracker/docs/${enc(id)}/write`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

export async function renameDoc(
  id: string,
  body: DocRename,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(`/tracker/docs/${enc(id)}/rename`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

export function listRevisions(id: string, signal?: AbortSignal): Promise<RevisionsResponse> {
  return request<RevisionsResponse>(`/tracker/docs/${enc(id)}/revisions`, { signal });
}

/** A unified diff; `to` defaults to the current revision, `from` to `to - 1`. */
export function diffDoc(
  id: string,
  range: { from?: number; to?: number } = {},
  signal?: AbortSignal,
): Promise<DiffResponse> {
  return request<DiffResponse>(
    `/tracker/docs/${enc(id)}/diff${query({ from: range.from, to: range.to })}`,
    { signal },
  );
}

/** Write an old revision's body as a new revision. */
export async function restoreDoc(
  id: string,
  body: DocRestore,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<DocumentView> {
  return request<DocumentView>(`/tracker/docs/${enc(id)}/restore`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

// ---- Specs and milestones ---------------------------------------------------

export function listSpecs(project: string, signal?: AbortSignal): Promise<SpecsResponse> {
  return request<SpecsResponse>(`/tracker/${enc(project)}/specs`, { signal });
}

export async function createSpec(
  project: string,
  body: SpecCreate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Spec> {
  return request<Spec>(`/tracker/${enc(project)}/specs`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

export function getSpec(project: string, slug: string, signal?: AbortSignal): Promise<Spec> {
  return request<Spec>(`/tracker/${enc(project)}/specs/${enc(slug)}`, { signal });
}

export async function updateSpec(
  project: string,
  slug: string,
  body: SpecUpdate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Spec> {
  const sent = updateBody(body);
  return request<Spec>(`/tracker/${enc(project)}/specs/${enc(slug)}`, {
    signal,
    json: { ...sent, ...author(fields) },
  });
}

export async function createMilestone(
  project: string,
  slug: string,
  body: MilestoneCreate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Milestone> {
  return request<Milestone>(`/tracker/${enc(project)}/specs/${enc(slug)}/milestones`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

export function getMilestone(
  project: string,
  slug: string,
  code: string,
  signal?: AbortSignal,
): Promise<Milestone> {
  return request<Milestone>(`/tracker/${enc(project)}/specs/${enc(slug)}/milestones/${enc(code)}`, {
    signal,
  });
}

export async function updateMilestone(
  project: string,
  slug: string,
  code: string,
  body: MilestoneUpdate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Milestone> {
  const sent = updateBody(body);
  return request<Milestone>(`/tracker/${enc(project)}/specs/${enc(slug)}/milestones/${enc(code)}`, {
    signal,
    json: { ...sent, ...author(fields) },
  });
}

// ---- Concepts ---------------------------------------------------------------

export function listConcepts(
  project: string,
  state?: ConceptState,
  signal?: AbortSignal,
): Promise<ConceptsResponse> {
  return request<ConceptsResponse>(`/tracker/${enc(project)}/concepts${query({ state })}`, {
    signal,
  });
}

export async function createConcept(
  project: string,
  body: ConceptCreate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Concept> {
  return request<Concept>(`/tracker/${enc(project)}/concepts`, {
    signal,
    json: { ...body, ...author(fields) },
  });
}

export function getConcept(project: string, slug: string, signal?: AbortSignal): Promise<Concept> {
  return request<Concept>(`/tracker/${enc(project)}/concepts/${enc(slug)}`, { signal });
}

export async function updateConcept(
  project: string,
  slug: string,
  body: ConceptUpdate,
  fields: TrackerAuthor,
  signal?: AbortSignal,
): Promise<Concept> {
  const sent = updateBody(body);
  return request<Concept>(`/tracker/${enc(project)}/concepts/${enc(slug)}`, {
    signal,
    json: { ...sent, ...author(fields) },
  });
}

// ---- Attachments ------------------------------------------------------------

/** At most 50 MB a file (api.md § Attachments). */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/** Upload a file; the response's `ref` (`att:…`) is what a document embeds. */
export async function uploadAttachment(
  project: string,
  file: Blob & { name?: string },
  fields: TrackerAuthor,
  name?: string,
  signal?: AbortSignal,
): Promise<Attachment> {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    refuse('An attachment may be at most 50 MB.');
  }
  const checked = author(fields);
  const form = new FormData();
  form.append('file', file, name ?? file.name ?? 'upload');
  form.append('author_email', checked.author_email);
  form.append('surface', checked.surface);
  if (name !== undefined && name.trim() !== '') {
    form.append('name', name.trim());
  }
  return request<Attachment>(`/tracker/${enc(project)}/attachments`, { signal, form });
}

export function listAttachments(
  project: string,
  signal?: AbortSignal,
): Promise<AttachmentsResponse> {
  return request<AttachmentsResponse>(`/tracker/${enc(project)}/attachments`, { signal });
}

// ---- Search -----------------------------------------------------------------

/** The corpus the tracker's documents and items are indexed as (D13). */
export const TRACKER_CORPUS = 'tracker';

/**
 * Semantic search over the tracker's documents and items: `POST /search`
 * with `filters.corpus = "tracker"` (D13, m05), and `repo` for one project.
 * An embed, a vector search and a rerank: call it on a submitted query.
 */
export function searchTracker(
  req: { query: string; project?: string; top_k?: number },
  signal?: AbortSignal,
): Promise<TrackerSearchResponse> {
  if (req.query.trim() === '') {
    refuse('A search needs something to look for.');
  }
  const project = req.project?.trim() ?? '';
  return request<TrackerSearchResponse>('/search', {
    signal,
    json: {
      query: req.query,
      ...(req.top_k === undefined ? {} : { top_k: req.top_k }),
      filters: { corpus: TRACKER_CORPUS, ...(project === '' ? {} : { repo: project }) },
    },
  });
}

export { attachmentUrl } from './paths';
