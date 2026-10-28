/**
 * The one place this application talks to `rag-serve`.
 *
 * Everything here uses **relative** paths. In production the bundle is served
 * by `rag-serve` itself, on its own origin, so `/ledger/rag-0001` is the API —
 * which is why no CORS handling exists on either side and none should be added.
 * In development Vite proxies the same paths to a live server (`vite.config.ts`).
 *
 * **A note on writes and the search index.** A write lands in SQLite
 * immediately, so `GET /ledger/{id}` reflects it at once; the vector index
 * reconciles through a trigger file and takes roughly 30 s to 3 min to catch
 * up. So after a write, go to the topic **by id** — re-running a search that
 * cannot yet see the change reads as the write having failed.
 */

import type {
  AppendBody,
  ArchiveBody,
  ArchivedSearchResponse,
  AuthorFields,
  CreateBody,
  CreatorFields,
  InfoResponse,
  LedgerEvent,
  LiveSearchResponse,
  MoveBody,
  MovedPointer,
  PromptSaveBody,
  PromptsResponse,
  SavedPrompt,
  SummariseBody,
  SummariseResponse,
  Topic,
  TopicRecord,
  TopicStatus,
  TopicType,
} from './types';
import { REPO_NAME_ERROR, isRepoName } from '../ledger/ids';

/**
 * A failed request, in the shape the caller has to render.
 *
 * `message` is fit to show a person; `detail` is the raw body, kept for the
 * cases where the message had to be invented (see {@link errorFor}).
 */
export class LedgerApiError extends Error {
  /** HTTP status, or `0` when the request never reached a server. */
  readonly status: number;
  /** The response body as received, before any interpretation. */
  readonly detail: string;

  constructor(status: number, message: string, detail = '') {
    super(message);
    this.name = 'LedgerApiError';
    this.status = status;
    this.detail = detail;
  }

  /** The server is up but a dependency is not — no Voyage key, no ledger DB. */
  get unavailable(): boolean {
    return this.status === 503;
  }
}

/**
 * The body shape every *deliberate* failure uses: `{"error": "…"}`.
 *
 * Every failure but one. A body that fails to deserialise into the handler's
 * struct — a missing `author_email`, say — is rejected by the framework before
 * the handler runs, and comes back as a **422 with a plain-text body**. That is
 * the one status whose message this client has to supply itself.
 */
function statedError(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const stated: unknown = (parsed as { error: unknown }).error;
      if (typeof stated === 'string' && stated !== '') {
        return stated;
      }
    }
  } catch {
    // Not JSON. Fall through — the caller has the raw body either way.
  }
  return null;
}

function errorFor(status: number, body: string): LedgerApiError {
  const stated = statedError(body);
  if (status === 422) {
    // Not the `{error}` shape, and the plain-text body is framework prose
    // ("Failed to deserialize the JSON body into the target type: missing
    // field `author_email`"). Say what it actually means, and keep the raw
    // text as the detail so the missing field name is still on screen.
    return new LedgerApiError(
      status,
      'The request was rejected before it reached the ledger — a required field was missing or the wrong type.',
      body,
    );
  }
  if (stated !== null) {
    return new LedgerApiError(status, stated, body);
  }
  return new LedgerApiError(status, `The server answered ${status} with no stated reason.`, body);
}

interface RequestOptions {
  signal?: AbortSignal;
  /** JSON body for a POST. Absent makes it a GET. */
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { signal, body } = options;
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    // An abort is the caller's own doing — a superseded search, a view left —
    // and is rethrown untouched so it can be recognised and ignored rather
    // than drawn as "the server could not be reached".
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new LedgerApiError(0, 'The server could not be reached.', String(cause));
  }

  const text = await response.text();
  if (!response.ok) {
    throw errorFor(response.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LedgerApiError(
      response.status,
      'The server answered with something that is not JSON.',
      text,
    );
  }
}

/** True when a rejection is the caller's own abort rather than a failure. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Narrow an unknown rejection to something renderable. */
export function asApiError(error: unknown): LedgerApiError {
  if (error instanceof LedgerApiError) {
    return error;
  }
  return new LedgerApiError(0, 'Something went wrong before the request completed.', String(error));
}

// ---- Reads ------------------------------------------------------------------

/** What `GET /ledger/{id}` can resolve to. See {@link MovedPointer}. */
export type TopicFetch =
  { kind: 'topic'; record: TopicRecord } | { kind: 'moved'; pointer: MovedPointer };

/**
 * Fetch one topic with its whole history.
 *
 * The id may have been **retired by a move**, in which case the server answers
 * 200 with a pointer to where the content now lives rather than a 404. That is
 * a redirect, not a topic, and rendering it as one would show a reader an empty
 * page for an id that is perfectly good — so it is a separate arm of the
 * result rather than something to detect at the call site by accident.
 *
 * Archived topics resolve here normally: `get_topic` does not filter on the
 * archive flag, so a link out of the archived list works.
 */
export async function getTopic(id: string, signal?: AbortSignal): Promise<TopicFetch> {
  const body = await request<TopicRecord | MovedPointer>(
    `/ledger/${encodeURIComponent(id)}`,
    signal === undefined ? {} : { signal },
  );
  if ('moved' in body && body.moved === true) {
    return { kind: 'moved', pointer: body };
  }
  return { kind: 'topic', record: body as TopicRecord };
}

/** Filters both search paths accept. All are exact matches, not substrings. */
export interface LedgerSearchFilters {
  repo?: string;
  type?: TopicType;
  status?: TopicStatus;
}

export interface LiveSearchRequest extends LedgerSearchFilters {
  /** **Required and non-blank.** There is no zero-query browse for live topics. */
  query: string;
  top_k?: number;
}

/**
 * Semantic search over live topics.
 *
 * Costs an embed + ANN + rerank round trip — call it on a submitted query, not
 * on a keystroke. An empty query is a 400 from the server, so callers must not
 * send one; there is no "show me everything" for live topics, and the honest
 * thing for a view to draw in that state is a prompt.
 */
export function searchLedger(
  req: LiveSearchRequest,
  signal?: AbortSignal,
): Promise<LiveSearchResponse> {
  return request<LiveSearchResponse>('/ledger/search', {
    ...(signal === undefined ? {} : { signal }),
    body: {
      query: req.query,
      ...(req.top_k === undefined ? {} : { top_k: req.top_k }),
      ...(req.repo === undefined || req.repo === '' ? {} : { repo: req.repo }),
      ...(req.type === undefined ? {} : { type: req.type }),
      ...(req.status === undefined ? {} : { status: req.status }),
    },
  });
}

export interface ArchivedSearchRequest extends LedgerSearchFilters {
  /** **Optional here**, unlike the live path — blank lists the most recent. */
  query?: string;
  top_k?: number;
}

/**
 * List archived (soft-deleted) topics, most recently updated first.
 *
 * A different code path from the live search rather than a flag on it: archived
 * topics are absent from the vector index, so this is a SQL `LIKE` over SQLite
 * that needs no embedding and no Voyage key. Which is also why a blank query is
 * allowed here and rejected there, and why the response is a different shape.
 */
export function searchArchived(
  req: ArchivedSearchRequest = {},
  signal?: AbortSignal,
): Promise<ArchivedSearchResponse> {
  return request<ArchivedSearchResponse>('/ledger/search', {
    ...(signal === undefined ? {} : { signal }),
    body: {
      archived: true,
      query: req.query ?? '',
      ...(req.top_k === undefined ? {} : { top_k: req.top_k }),
      ...(req.repo === undefined || req.repo === '' ? {} : { repo: req.repo }),
      ...(req.type === undefined ? {} : { type: req.type }),
      ...(req.status === undefined ? {} : { status: req.status }),
    },
  });
}

/** Collection stats and the non-secret half of the server's configuration. */
export function getInfo(signal?: AbortSignal): Promise<InfoResponse> {
  return request<InfoResponse>('/info', signal === undefined ? {} : { signal });
}

/**
 * Ask a model to read one topic and summarise it.
 *
 * A read of the topic in the sense that matters here — it changes nothing and
 * writes nothing to the ledger — but it is a **POST that costs money**, so it
 * belongs beside the writes in one respect: nothing may call it on a keystroke,
 * on mount, or on a re-render. It is called when a person presses Go, and once
 * per press.
 *
 * **Nothing is cached, at either end.** The server holds no summaries table and
 * this client holds no map: pressing Go twice makes two calls and can produce
 * two different summaries. That is the design. A cache keyed on the topic would
 * quietly serve the summary of an entry that has since been appended to, and
 * the staleness would be invisible.
 *
 * The reply is Markdown from a model that has just read attacker-writable
 * prose. It goes through the same `renderMarkdown` path as everything else.
 *
 * A 503 here means the **server has no Anthropic key** — the feature is off,
 * not broken. `LedgerApiError.unavailable` is how to tell.
 */
export function summariseTopic(
  id: string,
  body: SummariseBody = {},
  signal?: AbortSignal,
): Promise<SummariseResponse> {
  return request<SummariseResponse>(`/ledger/${encodeURIComponent(id)}/summarise`, {
    ...(signal === undefined ? {} : { signal }),
    body,
  });
}

// ---- Writes -----------------------------------------------------------------
//
// Four calls, and one rule that governs all of them: **the response is not the
// new truth**. The server computes ids, timestamps, status transitions and the
// link side-effects of `supersedes`; a caller that patched its local copy from
// the body it sent would be guessing at every one of them. So a write is
// followed by a re-fetch of the topic by id — which is also why these return
// what the server sent rather than trying to look like readers.

/**
 * The author fields for a write by a **person**.
 *
 * The `author_agent: null` is not an omission and not a default that a caller
 * may fill in: a null agent is precisely what distinguishes a human's write
 * from an agent's in the ledger, and this application only ever makes the
 * former. Build the fields here rather than spelling them out at a call site,
 * so there is one line to audit rather than four.
 */
export function authorFields(email: string): AuthorFields {
  return { author_email: email, author_agent: null };
}

/** The same, for `POST /ledger`, which names the pair `creator_*`. */
export function creatorFields(email: string): CreatorFields {
  return { creator_email: email, creator_agent: null };
}

/**
 * The last guard before a request leaves.
 *
 * Every one of these conditions is *also* checked by the form that raises it,
 * and that duplication is deliberate: a form's check exists to tell a person
 * what to type, and this one exists so that a caller added later cannot send
 * a body the ledger will either reject or, worse, accept and mangle — a blank
 * `repo` used to mint a topic called `-0001`. Thrown from an `async` function
 * so it arrives as a rejection like any other failure, not as an exception at
 * the call site.
 */
function refuse(message: string): never {
  throw new LedgerApiError(0, message);
}

/**
 * Append an event — the only write that can also amend a topic.
 *
 * **The note body is required whatever else the event does.** A status change
 * with no prose is a fact with no reason attached, and the reason is the thing
 * the ledger exists to keep; the server rejects a blank one and so does this.
 *
 * `set_tags` **replaces** the tag set rather than adding to it, so a caller
 * that sends a single tag has deleted the rest. Send the whole intended set.
 *
 * `supersedes` is not a note: it links the two topics *and flips the other one
 * to `superseded`*. Nothing here can undo that, so whatever offers it has to
 * say so before it is pressed.
 *
 * Returns the event the server recorded. A moved id fails here with the
 * server's own message naming the id to append to instead.
 */
export async function appendEvent(
  id: string,
  body: AppendBody,
  signal?: AbortSignal,
): Promise<LedgerEvent> {
  if (body.body.trim() === '') {
    refuse('An entry needs a note saying why. Write one before saving.');
  }
  if (body.author_email.trim() === '') {
    refuse('No author address. Set your email before writing.');
  }
  return request<LedgerEvent>(`/ledger/${encodeURIComponent(id)}/append`, {
    ...(signal === undefined ? {} : { signal }),
    body,
  });
}

/**
 * Create a topic — the **only** place a summary is ever set.
 *
 * `repo` is interpolated straight into the id the server mints
 * (`{repo}-l{seq:04}`), which is why it is checked here as well as in the form
 * and as well as on the server. Returns the new topic, whose `topic_id` is the
 * one thing a caller cannot have predicted and the one thing it needs.
 */
export async function createTopic(body: CreateBody, signal?: AbortSignal): Promise<Topic> {
  if (body.repo.trim() === '') {
    refuse('A project is required: it becomes the first half of the topic id.');
  }
  if (!isRepoName(body.repo.trim())) {
    refuse(REPO_NAME_ERROR);
  }
  if (body.title.trim() === '' || body.summary.trim() === '') {
    refuse('A title and a summary are both required.');
  }
  if (body.creator_email.trim() === '') {
    refuse('No author address. Set your email before writing.');
  }
  return request<Topic>('/ledger', {
    ...(signal === undefined ? {} : { signal }),
    body,
  });
}

/**
 * Archive (`archived: true`) or restore (`false`) a topic.
 *
 * A soft delete: the topic stays in SQLite and stays readable by id, and it is
 * **purged from the search index**, so an archived topic is findable only
 * through the archived listing. The server records the change as an event of
 * its own, so the history says who did it and when.
 */
export async function setArchived(
  id: string,
  body: ArchiveBody,
  signal?: AbortSignal,
): Promise<Topic> {
  if (body.author_email.trim() === '') {
    refuse('No author address. Set your email before writing.');
  }
  return request<Topic>(`/ledger/${encodeURIComponent(id)}/archive`, {
    ...(signal === undefined ? {} : { signal }),
    body,
  });
}

/**
 * Move a topic to another project.
 *
 * **This mints a new id and retires the old one.** The topic, its whole
 * monologue and its links are re-filed under `{repo}-l{seq:04}` in the
 * destination, and the id that was quoted in a commit message, a comment or a
 * chat log becomes a pointer. The server refuses a move to the repo the topic
 * is already in.
 *
 * The returned topic carries the **new** id, which is the only way to find out
 * what it is — so the caller's next move is to that id, not to a re-fetch of
 * the one it just retired.
 */
export async function moveTopic(id: string, body: MoveBody, signal?: AbortSignal): Promise<Topic> {
  if (body.repo.trim() === '') {
    refuse('A destination project is required.');
  }
  // The same rule the create path applies, and for the same reason: a move
  // mints `{repo}-l{seq:04}` too. It is worse here, because a move also retires
  // the id it came from — an unreachable destination leaves nothing to go back
  // to, and the sequence number is spent either way.
  if (!isRepoName(body.repo.trim())) {
    refuse(REPO_NAME_ERROR);
  }
  if (body.author_email.trim() === '') {
    refuse('No author address. Set your email before writing.');
  }
  return request<Topic>(`/ledger/${encodeURIComponent(id)}/move`, {
    ...(signal === undefined ? {} : { signal }),
    body,
  });
}

// ---- Saved prompts ----------------------------------------------------------
//
// Three calls against a directory of Markdown files on the server. Two of them
// **write to disk over an endpoint with no authentication**, which is why the
// name rules are enforced server-side and merely *mirrored* here: the checks
// below exist to tell a person what to type, not to be the barrier.

/**
 * What the server will accept as a prompt name.
 *
 * A deliberate mirror of `validate_name` in `crates/serve/src/prompts.rs`, and
 * the weaker of the two: this one can be bypassed by anything that is not this
 * application, so it is a courtesy to whoever is typing rather than a guard.
 * Keep the two in step — a name this accepts and the server rejects is a 400
 * arriving from a field that said it was fine.
 */
export const PROMPT_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

/** The longest name the server stores. */
export const PROMPT_NAME_MAX = 64;

export const PROMPT_NAME_ERROR =
  'A prompt name may hold only letters, digits, spaces, hyphens and underscores — it becomes a filename on the server.';

/** Whether `name` is one the server would store, once trimmed. */
export function isPromptName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && trimmed.length <= PROMPT_NAME_MAX && PROMPT_NAME_PATTERN.test(trimmed);
}

/**
 * List the saved prompts, bodies and all.
 *
 * One round trip for the whole library: the bodies come with the names, so
 * switching selection in the chooser costs nothing and an edit is never held
 * against a body that has not arrived yet. They are small and capped in number.
 *
 * A server with no prompts directory answers `configured: false` with an empty
 * list rather than an error — that is a valid deployment, and the built-in
 * default prompt (from `/info`) is available either way.
 */
export function listPrompts(signal?: AbortSignal): Promise<PromptsResponse> {
  return request<PromptsResponse>('/prompts', signal === undefined ? {} : { signal });
}

/**
 * Save a prompt under a name, creating it or replacing it.
 *
 * An **upsert**: there is no separate create, because Save is one button and a
 * "this already exists" failure on it would be a dialog asking the operator to
 * confirm what they just asked for. Whatever offers this has to say plainly
 * when it is about to replace something.
 *
 * A 503 means the server has no prompts directory; a 400 means the name or the
 * body was refused, and the server's own sentence says which.
 */
export async function savePrompt(body: PromptSaveBody, signal?: AbortSignal): Promise<SavedPrompt> {
  if (!isPromptName(body.name)) {
    refuse(body.name.trim() === '' ? 'A prompt needs a name.' : PROMPT_NAME_ERROR);
  }
  if (body.body.trim() === '') {
    refuse('A prompt needs an instruction. An empty one is not a prompt.');
  }
  return request<SavedPrompt>('/prompts/save', {
    ...(signal === undefined ? {} : { signal }),
    body: { name: body.name.trim(), body: body.body },
  });
}

/**
 * Delete a saved prompt. **The built-in default is not deletable** and is not a
 * file, so nothing should ever pass its label here.
 */
export async function deletePrompt(name: string, signal?: AbortSignal): Promise<void> {
  if (!isPromptName(name)) {
    refuse(PROMPT_NAME_ERROR);
  }
  await request<{ name: string; deleted: boolean }>('/prompts/delete', {
    ...(signal === undefined ? {} : { signal }),
    body: { name: name.trim() },
  });
}
