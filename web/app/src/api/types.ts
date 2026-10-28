/**
 * The shapes `rag-serve` actually sends and accepts.
 *
 * Written against the handlers in `crates/serve/src/main.rs` and the records in
 * `crates/core/src/ledger.rs`, not against a description of them. Where the wire
 * name and the Rust field name differ (`type` for `topic_type`) the **wire** name
 * is what appears here — this file describes JSON, not Rust.
 *
 * Two conventions worth stating once:
 *
 * * A field the server serialises with `skip_serializing_if = "Option::is_none"`
 *   is **absent** from the body, so it is optional (`field?:`) here. A field it
 *   always serialises but may send as `null` is `T | null`. The difference
 *   matters: `'field' in body` is a meaningful test for the first and not for
 *   the second.
 * * The enum vocabularies are declared once, as `const` arrays, and the union
 *   types are derived from them. A control that offers the choices and a type
 *   that constrains them then cannot drift apart.
 */

// ---- Enum vocabularies ------------------------------------------------------

/** What question a topic answers. Mirrors `TopicType` in `core::ledger`. */
export const TOPIC_TYPES = ['decision', 'incident', 'defect', 'investigation'] as const;
export type TopicType = (typeof TOPIC_TYPES)[number];

/** A topic's lifecycle status. Mirrors `Status` in `core::ledger`. */
export const TOPIC_STATUSES = [
  'open',
  'resolved',
  'proposed',
  'accepted',
  'superseded',
  'reverted',
  'wontfix',
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

/** The kind of a monologue event. Mirrors `EventKind` in `core::ledger`. */
export const EVENT_KINDS = ['note', 'state_change', 'status_change', 'correction', 'link'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A typed relationship between two topics. Mirrors `LinkRel` in `core::ledger`. */
export const LINK_RELS = ['supersedes', 'superseded_by', 'related', 'caused_by'] as const;
export type LinkRel = (typeof LINK_RELS)[number];

// ---- Records ----------------------------------------------------------------

/** A topic: the root node of the ledger. */
export interface Topic {
  topic_id: string;
  type: TopicType;
  repo: string;
  /** Amendable handle. References between topics are by `topic_id`, never by title. */
  title: string;
  /**
   * The **immutable** original framing, set at creation and never revised.
   *
   * There is no `set_summary` on any code path, deliberately: a topic framed
   * wrongly is worth more than one tidied to match its outcome. Anything in
   * this application that lets a person edit a topic must leave this alone.
   */
  summary: string;
  /** Current understanding — changed only by appending an event. */
  current_state: string;
  status: TopicStatus;
  created_at: string;
  updated_at: string;
  creator_email: string;
  /** `null` marks a **human** author. See {@link AuthorFields}. */
  creator_agent: string | null;
  tags: string[];
  /** Soft-deleted: retained in SQLite, purged from the search index. */
  archived: boolean;
  archived_at: string | null;
}

/** One event in a topic's append-only monologue. */
export interface LedgerEvent {
  event_id: number;
  ts: string;
  author_email: string;
  /** `null` marks a **human** author. See {@link AuthorFields}. */
  author_agent: string | null;
  kind: EventKind;
  body: string;
  /** The state this event installed, if it amended one. */
  new_state: string | null;
  new_status: string | null;
  new_title: string | null;
  /** The tag set this event installed — a wholesale replacement, not a delta. */
  new_tags: string[] | null;
}

export interface TopicLink {
  rel: LinkRel;
  other_topic_id: string;
}

/**
 * The full record from `GET /ledger/{id}`.
 *
 * The topic's own fields are `#[serde(flatten)]`-ed alongside `events` and
 * `links`, so this is one flat object rather than a nested `topic` key.
 */
export interface TopicRecord extends Topic {
  events: LedgerEvent[];
  links: TopicLink[];
}

/**
 * The **other** thing `GET /ledger/{id}` can return, with a 200 rather than a
 * redirect status: the id was retired by a move and its content lives elsewhere.
 *
 * Distinguished from a {@link TopicRecord} by the `moved` discriminant — a topic
 * body never carries that key.
 */
export interface MovedPointer {
  moved: true;
  /** The id that was asked for. */
  topic_id: string;
  /** The id to fetch instead. */
  moved_to: string;
  moved_at: string;
  detail: string;
}

// ---- Search -----------------------------------------------------------------

export interface Timings {
  embed_ms: number;
  search_ms: number;
  rerank_ms: number;
  total_ms: number;
}

/**
 * One live search result.
 *
 * `corpus`/`repo`/`text`/`ann_score` are the general retrieval shape; the
 * `topic_*`, `status` and `title` fields are populated for `corpus = ledger`
 * hits only, which is every hit `POST /ledger/search` returns. `rel_path`,
 * `path` and `language` come back as empty strings for a ledger hit — a topic
 * is not a file — so nothing should try to cite one.
 *
 * `title` is the display label and `text` is the matched chunk. They are not
 * interchangeable: a topic point's text is title + summary + state, but an
 * **event** point's text is mid-monologue prose with no heading in it at all.
 */
export interface RankedHit {
  corpus: string;
  repo: string;
  rel_path: string;
  path: string;
  language: string;
  start_line: number;
  end_line: number;
  text: string;
  ann_score: number;
  /** Present only when the rerank stage ran. */
  rerank_score?: number;
  topic_id?: string;
  type?: TopicType;
  status?: TopicStatus;
  title?: string;
}

/** The response to a **live** ledger search (`archived` absent or false). */
export interface LiveSearchResponse {
  query: string;
  top_k: number;
  reranked: boolean;
  /** Candidates after filtering, before the top-k cut. */
  candidates: number;
  timings: Timings;
  /**
   * Already collapsed to **one hit per topic** by the server's `finalise` step.
   * Do not dedupe by `topic_id` here; it would be dead code shadowing a
   * server-side guarantee.
   */
  results: RankedHit[];
}

/**
 * One archived topic.
 *
 * A different shape from {@link RankedHit}, because it comes from a different
 * place: archived topics are absent from the vector index, so this is a plain
 * SQLite row with no scores and no chunk text.
 */
export interface ArchivedHit {
  topic_id: string;
  type: TopicType;
  status: TopicStatus;
  repo: string;
  title: string;
  summary: string;
  current_state: string;
  updated_at: string;
  archived_at: string | null;
}

/** The response to an **archived** ledger search (`archived: true`). */
export interface ArchivedSearchResponse {
  query: string;
  archived: true;
  count: number;
  results: ArchivedHit[];
}

export interface InfoResponse {
  collection: string;
  /**
   * Points in the collection, or `null` when the server could not ask Qdrant
   * (unreachable, or no retriever). `/info` still answers 200 then, so the
   * readiness flags below stay readable during a Qdrant outage.
   */
  points: number | null;
  /** Why `points` is `null` when Qdrant was asked and failed; `null` otherwise. */
  qdrant_error: string | null;
  embed_model: string;
  rerank_model: string;
  dimensions: number;
  over_fetch: number;
  default_top_k: number;
  qdrant_url: string;
  retrieval_ready: boolean;
  /**
   * Whether `POST /ledger/{id}/summarise` will do anything but 503 — the
   * server holds an Anthropic key. The key itself never comes near the
   * browser; this boolean is the whole of what the client is told about it.
   */
  summarise_ready: boolean;
  /**
   * The model ids that endpoint accepts, as an allow-list the **server** owns.
   *
   * Read rather than hardcoded, so the picker cannot offer a model the server
   * would reject. Display labels are this application's business (an unknown
   * id is drawn as itself); the *set* is not.
   */
  summarise_models: string[];
  summarise_default_model: string;
  /**
   * The default instruction, defined once in Rust.
   *
   * The prompt box is prefilled from this rather than from a copy written
   * here: two copies of a prompt drift, and the one on screen would stop being
   * the one the server falls back to.
   */
  summarise_system_prompt: string;
}

// ---- Summarise --------------------------------------------------------------

/**
 * `POST /ledger/{id}/summarise`.
 *
 * **There is no content field, deliberately.** The server reads the topic from
 * the id in the path; a body carrying the prose would make the endpoint a
 * general-purpose LLM proxy for anything on the network. Both fields are
 * optional — absent means the server's default model and default prompt.
 */
export interface SummariseBody {
  model?: string;
  system_prompt?: string;
}

/**
 * A summary, and what it cost.
 *
 * The usage is here because **nothing is cached**: every press of Go is a fresh
 * billed call, which is the design rather than an oversight, and the reader
 * paying for it should be able to see the size of what they just did.
 */
export interface SummariseResponse {
  /**
   * Markdown, written by a model that has just read unauthenticated prose.
   * Untrusted twice over — render it through `markdown/render.ts` like any
   * other ledger string.
   */
  summary: string;
  /** The model that actually served it, as the API reported it. */
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** The summary ran into the output ceiling and stops mid-thought. */
  truncated: boolean;
}

// ---- Saved prompts ----------------------------------------------------------

/**
 * One saved system prompt: `~/rag/prompts/{name}.md` on the server.
 *
 * A prompt is a **file**, and that is the whole storage design — no database,
 * no metadata, no ids. An operator with a text editor can add, edit or delete
 * one and the chooser shows the result on its next read. Which is why `name` is
 * restricted server-side to letters, digits, spaces, `-` and `_`: it has to
 * survive a round trip through a filename, and it is the only thing deciding
 * which file gets written on a service with no authentication.
 */
export interface SavedPrompt {
  name: string;
  /** The instruction itself, sent verbatim as the API call's `system` field. */
  body: string;
}

/**
 * `GET /prompts`.
 *
 * **The built-in default is not in this list.** It is a Rust constant served by
 * `/info` as `summarise_system_prompt`: always offered, never deletable, and
 * never written to disk. An empty `prompts` means the library is empty, not
 * that a default is missing.
 */
export interface PromptsResponse {
  /**
   * Whether the server has a prompts directory at all (`server.prompts_dir`).
   *
   * `false` is a **valid deployment**, not a fault: the chooser then offers the
   * built-in alone and draws no Save, because the write routes would 503.
   */
  configured: boolean;
  /** Every saved prompt, name and body, ordered by name. */
  prompts: SavedPrompt[];
}

/** `POST /prompts/save` — an upsert keyed on the name. Both fields required. */
export interface PromptSaveBody {
  name: string;
  body: string;
}

// ---- Write bodies -----------------------------------------------------------
//
// The four bodies `client.ts` sends. They are typed here, rather than inline at
// the call sites, so that the `author_agent: null` rule below is a *compile*
// error rather than a code review someone has to remember to do.

/**
 * The author fields every ledger write carries.
 *
 * **`author_agent` is typed as `null` and only `null`.** A null agent is what
 * marks a write as coming from a person; populating it — even with the name of
 * this application — would file a human's amendment as an agent's. The type is
 * the enforcement: {@link authorFields} is the only thing that builds one, and
 * a caller cannot widen it without changing this line.
 */
export interface AuthorFields {
  readonly author_email: string;
  readonly author_agent: null;
}

/** The same rule for `POST /ledger`, which names its author fields differently. */
export interface CreatorFields {
  readonly creator_email: string;
  readonly creator_agent: null;
}

/** `POST /ledger/{id}/append`. `body` is required and must not be blank. */
export interface AppendBody extends AuthorFields {
  body: string;
  kind?: EventKind;
  set_state?: string;
  set_status?: TopicStatus;
  /** Amend the title. Blank is rejected by the store. */
  set_title?: string;
  /** Replace the tag set wholesale; `[]` clears it, absent leaves it. */
  set_tags?: string[];
  supersedes?: string;
}

/**
 * `POST /ledger`.
 *
 * `repo` is interpolated straight into the new topic id (`{repo}-l{seq:04}`), so
 * it must be validated client-side as well — a blank one used to mint `-0001`.
 * There is no `summary` amendment anywhere else: this is the only place a
 * summary is ever set.
 */
export interface CreateBody extends CreatorFields {
  type: TopicType;
  repo: string;
  title: string;
  summary: string;
  initial_state: string;
  status?: TopicStatus;
  tags?: string[];
}

/** `POST /ledger/{id}/archive`. `archived: false` restores. */
export interface ArchiveBody extends AuthorFields {
  archived: boolean;
}

/**
 * `POST /ledger/{id}/move`.
 *
 * **Mints a new topic id and retires the old one.** Whatever offers this must
 * state that consequence before it happens, not after.
 */
export interface MoveBody extends AuthorFields {
  repo: string;
}
