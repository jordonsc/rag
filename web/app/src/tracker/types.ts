/**
 * The tracker's wire shapes, as `specs/tracker/api.md` states them.
 *
 * The contract is that document (built in m01: `crates/core/src/tracker/`,
 * `crates/serve/src/tracker.rs`), and this file describes its JSON, not the
 * Rust behind it. The same two conventions as `api/types.ts`:
 *
 * * The vocabularies are `const` arrays and the unions derive from them, so a
 *   control that offers the choices and the type that constrains them cannot
 *   drift apart.
 * * A field the server always sends but may send as `null` is `T | null`.
 *
 * **Unknown fields are refused by the server** (400), which is why every
 * request body here is a closed interface: a stray key from a spread is a
 * failed write, not a silent no-op.
 */

// ---- Enumerations -----------------------------------------------------------

/**
 * An item's type (R6). `gate` is drawn as a marker, not a row. `request` is
 * the owner's idea, broken into tickets by the manager (rag-t0044): listed in
 * its own section, never in the queue.
 */
export const ITEM_TYPES = ['dev', 'design', 'recon', 'analysis', 'gate', 'request'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** The four types that are work rather than a gate. */
export const WORK_TYPES = ['dev', 'design', 'recon', 'analysis'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const ITEM_STATUSES = [
  'pending',
  'in_progress',
  'done',
  'failed',
  'cancelled',
  'deferred',
  'review',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * Why an item is blocked. `approval` was retired (rag-t0024): work waiting on
 * the owner is the status `review`, and the server refuses the old reason.
 */
export const BLOCK_REASONS = ['redesign', 'review', 'dependency'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const INTENSITIES = ['quick', 'standard', 'full'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const APPROVALS = ['unapproved', 'agent', 'ratified', 'owner'] as const;
export type Approval = (typeof APPROVALS)[number];

export const SURFACES = ['web', 'mcp'] as const;
export type Surface = (typeof SURFACES)[number];

export const EVENT_KINDS = [
  'note',
  'create',
  'status',
  'block',
  'unblock',
  'approve',
  'move',
  'edit',
  'link',
  'assign',
  'acknowledge',
  'rename',
] as const;
export type TrackerEventKind = (typeof EVENT_KINDS)[number];

export const SPEC_STATES = ['draft', 'ready', 'in_development', 'done', 'superseded'] as const;
export type SpecState = (typeof SPEC_STATES)[number];

export const MILESTONE_STATES = ['not_started', 'in_progress', 'done'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export const CONCEPT_STATES = ['open', 'refining', 'refined', 'archived'] as const;
export type ConceptState = (typeof CONCEPT_STATES)[number];

export const DOCUMENT_KINDS = ['spec', 'milestone', 'concept', 'doc'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * `from` names the request an item was broken out of; `became` is its reverse
 * on the request, written by the server only (rag-t0044).
 */
export const LINK_KINDS = [
  'spec',
  'milestone',
  'concept',
  'ledger',
  'item',
  'from',
  'became',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

// ---- Shared pieces ----------------------------------------------------------

/**
 * The author fields every write carries.
 *
 * **`agent` is deliberately absent from this type.** The web app is the owner
 * at the keyboard, and `surface: 'web'` is what says so (D10); the server
 * records an absent agent as `Unknown`. Built in one place,
 * `tracker/api.ts`'s `trackerAuthor`, never spelled out at a call site.
 */
export interface TrackerAuthor {
  author_email: string;
  surface: 'web';
}

export interface Link {
  kind: LinkKind;
  target: string;
}

/** Where a create or a move puts an item. Exactly one key. */
export type Place = { before: string } | { after: string } | { top: true } | { bottom: true };

export interface TrackerEvent {
  event_id: number;
  ts: string;
  author_email: string;
  agent: string;
  surface: Surface;
  kind: TrackerEventKind;
  body: string;
  /** Every field the write set, with its new value. Open: see api.md § Event. */
  fields: Record<string, unknown>;
  /**
   * Written while its record was a draft (2026-10-30): the feed leaves it
   * out unless asked (`drafts=true`). Absent from a server before drafts.
   */
  draft?: boolean;
}

/** The kind of record an event belongs to. */
export type TargetKind = 'item' | 'spec' | 'milestone' | 'concept' | 'document';

/**
 * One event as the feed sends it with `format=json` (api.md § The event
 * feed): the event, plus where it belongs.
 */
export interface FeedEvent extends TrackerEvent {
  project: string;
  target_kind: TargetKind;
  target_id: string;
  /** The record's current title; `null` when the record is gone. */
  title: string | null;
  /** What the event's fields held before the write; `null` on a create. */
  before: Record<string, unknown> | null;
}

// ---- Records ----------------------------------------------------------------

export interface Item {
  id: string;
  project: string;
  type: ItemType;
  title: string;
  body: string;
  status: ItemStatus;
  blocked: boolean;
  block_reason: BlockReason | null;
  block_note: string | null;
  approval: Approval;
  assignee: string | null;
  intensity: Intensity | null;
  release: boolean;
  /**
   * May start before the gates above it clear, and still lands after them
   * (rag-t0013). Never on a gate. Absent from a server before it: read as false.
   */
  parallel?: boolean;
  /**
   * The items it waits on while blocked with reason `dependency` (rag-t0018),
   * items of its own project; empty otherwise. Absent from a server before it.
   */
  depends_on?: string[];
  queued: boolean;
  prev_id: string | null;
  next_id: string | null;
  links: Link[];
  /**
   * Free-text labels (rag-t0027), sorted case-insensitively, in the project's
   * casing. Absent from a server before them: read as none.
   */
  labels?: string[];
  created_at: string;
  updated_at: string;
  done_at: string | null;
  acknowledged_at: string | null;
  /**
   * A draft (2026-10-30): the owner's, not yet published. Its writes are left
   * out of the feed by default and it is in no queue section but `drafts`, so
   * nothing dispatches it. Absent from a server before drafts: read as false.
   */
  draft?: boolean;
  /** Present on a record read; absent or empty on list reads. */
  events?: TrackerEvent[];
}

export interface ProjectSummary {
  name: string;
  created_at: string;
  /** Counts requests, review, blocked and deferred items too. */
  queued: number;
  /** Queued requests (rag-t0044). Absent from a server before them. */
  requests?: number;
  /** Blocked and neither deferred nor in review. */
  blocked: number;
  /** Deferred, blocked or not (rag-t0017). Absent from a server before it. */
  deferred?: number;
  /** In review, blocked or not (rag-t0024). Absent from a server before it. */
  review?: number;
  /**
   * Queued drafts (2026-10-30), whatever their type or status; counted under
   * none of the other buckets. Absent from a server before drafts.
   */
  drafts?: number;
  done_unacknowledged: number;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
}

/** `GET /tracker/{project}`: the dashboard's whole read (D14). */
export interface QueueView {
  project: string;
  exists: boolean;
  /**
   * The owner's drafts (2026-10-30): queued items not yet published, any type
   * (requests too), in list order. Never in any other section. Absent from a
   * server before drafts; read as empty.
   */
  drafts?: Item[];
  /**
   * The owner's requests waiting to be broken down (rag-t0044), whatever
   * their status, in list order. Never in `queue`. Absent from a server
   * before them; read as empty.
   */
  requests?: Item[];
  /** Done, unacknowledged, oldest first and newest last (rag-t0029). */
  done: Item[];
  /**
   * Items in review (waiting on the owner), blocked or not, in list order
   * (rag-t0024). Absent from a server older than the status; read as empty.
   */
  review?: Item[];
  /** The linked list head first, gates included, review, blocked and deferred items excluded. */
  queue: Item[];
  /** Blocked queued items that are not deferred, in list order. */
  blocked: Item[];
  /**
   * Deferred items, blocked or not, in list order (rag-t0017). Absent from a
   * server older than the status; read as empty.
   */
  deferred?: Item[];
}

export interface CheckResponse {
  project: string;
  ok: boolean;
  queued: number;
  order: string[];
  problems: string[];
}

export interface AckDoneResponse {
  project: string;
  acknowledged: string[];
}

export interface ItemsResponse {
  project: string;
  items: Item[];
}

/** One label of a project's vocabulary (rag-t0027). */
export interface LabelCount {
  label: string;
  /** Items of the project carrying it, whatever their status. */
  count: number;
  /** Of those, the items still queued. */
  queued: number;
}

/** `GET /tracker/{project}/labels`. */
export interface LabelsResponse {
  project: string;
  labels: LabelCount[];
}

export interface TrackerDocument {
  id: string;
  project: string;
  path: string;
  kind: DocumentKind;
  title: string;
  /** Always the current revision: what an edit names as `base_revision`. */
  revision: number;
  spec: string | null;
  milestone: string | null;
  concept: string | null;
  /**
   * A draft (2026-10-30): its writes, and its spec's, milestone's or
   * concept's, are left out of the feed by default. Absent from a server
   * before drafts: read as false.
   */
  draft?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DocumentView extends TrackerDocument {
  body: string;
  /** The revision `body` is from. */
  body_revision: number;
  redirected_from: string | null;
  events: TrackerEvent[];
}

export interface DocumentsResponse {
  project: string;
  documents: TrackerDocument[];
}

export interface Revision {
  revision: number;
  author_email: string;
  agent: string;
  surface: Surface;
  ts: string;
  message: string;
  size: number;
}

export interface RevisionsResponse {
  doc_id: string;
  revisions: Revision[];
}

export interface DiffResponse {
  doc_id: string;
  from: number;
  to: number;
  diff: string;
}

export interface Milestone {
  project: string;
  spec: string;
  code: string;
  title: string;
  order: number;
  state: MilestoneState;
  approval: Approval;
  doc_id: string;
  path: string;
  created_at: string;
  updated_at: string;
  events?: TrackerEvent[];
}

export interface Spec {
  project: string;
  slug: string;
  title: string;
  state: SpecState;
  approval: Approval;
  doc_id: string;
  path: string;
  milestones: Milestone[];
  created_at: string;
  updated_at: string;
  events?: TrackerEvent[];
}

export interface SpecsResponse {
  project: string;
  specs: Spec[];
}

export interface Concept {
  project: string;
  slug: string;
  title: string;
  state: ConceptState;
  approval: Approval;
  links: Link[];
  doc_id: string;
  path: string;
  /** Its document's `draft` (2026-10-30). Absent from a server before drafts. */
  draft?: boolean;
  created_at: string;
  updated_at: string;
  events?: TrackerEvent[];
}

export interface ConceptsResponse {
  project: string;
  concepts: Concept[];
}

export interface Attachment {
  id: number;
  project: string;
  sha256: string;
  /** `att:<12 hex>`, what a document embeds. */
  ref: string;
  name: string;
  media_type: string;
  size: number;
  author_email: string;
  agent: string;
  surface: Surface;
  uploaded_at: string;
}

export interface AttachmentsResponse {
  project: string;
  attachments: Attachment[];
}

// ---- Request bodies (without the author fields) -----------------------------

export interface ItemCreate {
  type: ItemType;
  title: string;
  body?: string;
  assignee?: string;
  approval?: Exclude<Approval, 'ratified'>;
  links?: Link[];
  intensity?: Intensity;
  release?: boolean;
  /** Any type but a gate (rag-t0013). */
  parallel?: boolean;
  /** Free-text labels (rag-t0027). */
  labels?: string[];
  note?: string;
  place?: Place;
  /** Create it as a draft (2026-10-30), published later with `draft: false`. */
  draft?: boolean;
}

export interface ItemUpdate {
  status?: ItemStatus;
  blocked?: boolean;
  block_reason?: BlockReason;
  /**
   * With reason `dependency` (given now or held): what it waits on, replacing
   * the list. At least one; items of the same project (rag-t0018).
   */
  depends_on?: string[];
  approval?: Approval;
  assignee?: string;
  title?: string;
  body?: string;
  add_links?: Link[];
  remove_links?: Link[];
  intensity?: Intensity;
  release?: boolean;
  /** Not on a gate (rag-t0013). */
  parallel?: boolean;
  /** The labels, replacing the set wholesale; `[]` clears them (rag-t0027). */
  labels?: string[];
  /** `false` publishes a draft; `true` makes a ticket a draft again (2026-10-30). */
  draft?: boolean;
  note?: string;
}

export interface DocCreate {
  path: string;
  title: string;
  body?: string;
  message?: string;
  draft?: boolean;
}

/** `POST /tracker/docs/{id}/draft` (2026-10-30): publish, or make a draft again. */
export interface DocDraft {
  draft: boolean;
  note?: string;
}

export interface Replacement {
  old: string;
  new: string;
}

export interface DocEdit {
  base_revision: number;
  replacements: Replacement[];
  message?: string;
}

export interface DocWrite {
  base_revision: number;
  body: string;
  message?: string;
}

export interface DocRename {
  path?: string;
  title?: string;
  note?: string;
}

export interface DocRestore {
  revision: number;
  base_revision: number;
  message?: string;
}

export interface MilestoneCreate {
  code: string;
  title: string;
  name?: string;
  state?: MilestoneState;
  approval?: Exclude<Approval, 'ratified'>;
  body?: string;
  note?: string;
}

export interface SpecCreate {
  slug: string;
  title: string;
  state?: SpecState;
  approval?: Exclude<Approval, 'ratified'>;
  body?: string;
  milestones?: MilestoneCreate[];
  note?: string;
}

export interface SpecUpdate {
  title?: string;
  state?: SpecState;
  approval?: Approval;
  note?: string;
}

export interface MilestoneUpdate {
  title?: string;
  state?: MilestoneState;
  approval?: Approval;
  order?: number;
  note?: string;
}

export interface ConceptCreate {
  slug: string;
  title: string;
  state?: ConceptState;
  approval?: Exclude<Approval, 'ratified'>;
  body?: string;
  links?: Link[];
  note?: string;
  /** Create its document as a draft (2026-10-30). */
  draft?: boolean;
}

export interface ConceptUpdate {
  title?: string;
  state?: ConceptState;
  approval?: Approval;
  add_links?: Link[];
  remove_links?: Link[];
  note?: string;
}

// ---- Search (D13; `POST /search` with `corpus: "tracker"`) -------------------

/**
 * One tracker hit from `POST /search` filtered to `corpus = tracker` (m05's
 * reconcile; `crates/core/src/model.rs` `RankedHit`). `repo` is the project;
 * `rel_path` a document's path, or an item's id.
 */
export interface TrackerHit {
  corpus: string;
  repo: string;
  rel_path: string;
  start_line: number;
  end_line: number;
  text: string;
  ann_score: number;
  rerank_score?: number;
  title?: string;
  /** An item's status (item hits only). */
  status?: string;
  /** An item's type (item hits only). */
  type?: string;
  /** `<project>:<path>@r<revision>` for a document chunk, the item id for an item. */
  citation?: string;
  /** The document or item id. */
  tracker_id?: string;
  /** A document's kind (`spec`, `milestone`, `concept`, `doc`), or `item`. */
  kind?: string;
  /** The revision a document chunk is from. */
  revision?: number;
}

export interface TrackerSearchResponse {
  query: string;
  top_k: number;
  reranked: boolean;
  candidates: number;
  timings: { embed_ms: number; search_ms: number; rerank_ms: number; total_ms: number };
  results: TrackerHit[];
}
