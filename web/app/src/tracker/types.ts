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
  // A phase's (spec:roadmap D18): each the one frame its write sends.
  'release',
  'recall',
] as const;
export type TrackerEventKind = (typeof EVENT_KINDS)[number];

export const SPEC_STATES = ['draft', 'ready', 'in_development', 'done', 'superseded'] as const;
export type SpecState = (typeof SPEC_STATES)[number];

export const MILESTONE_STATES = ['not_started', 'in_progress', 'done'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export const CONCEPT_STATES = ['open', 'refining', 'refined', 'archived'] as const;
export type ConceptState = (typeof CONCEPT_STATES)[number];

/**
 * A phase's state (spec:roadmap D1): `planned` (on the roadmap, its tickets
 * frozen), `released` (its tickets have joined the queue, keeping the link),
 * `archived` (off the roadmap). `complete` is derived, never a state (D15).
 */
export const PHASE_STATES = ['planned', 'released', 'archived'] as const;
export type PhaseState = (typeof PHASE_STATES)[number];

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
  /**
   * A roadmap event (spec:roadmap D17): a phase's, or a frozen ticket's, or one
   * that changed a ticket's phase. The feed leaves it out unless asked
   * (`roadmap=true`), so planning wakes no monitor. Absent from a server before
   * the roadmap.
   */
  roadmap?: boolean;
}

/** The kind of record an event belongs to. */
export type TargetKind = 'item' | 'spec' | 'milestone' | 'concept' | 'document' | 'phase';

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
  /**
   * The phase it belongs to (spec:roadmap R4), kept for life: a released ticket
   * still names it. Absent from a server before the roadmap; read as none. The
   * phase's title is not here: `phaseTitles.tsx` holds them, one read a page.
   */
  phase?: string | null;
  /**
   * Held out of the queue in a planned phase (spec:roadmap R6). `queued` is
   * then false, and `prev_id` / `next_id` are its neighbours in the phase's
   * list. Absent from a server before the roadmap: read as false.
   */
  frozen?: boolean;
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
  /**
   * Tickets frozen in a phase (spec:roadmap D20), drafts included; counted
   * under none of the others. Absent from a server before the roadmap.
   */
  frozen?: number;
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
  /**
   * How many tickets are frozen in a phase (spec:roadmap D20), drafts included.
   * Every list above leaves them out. Absent from a server before the roadmap.
   */
  frozen?: number;
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

// ---- Velocity (spec:velocity D26) -------------------------------------------

/** The windows velocity is measured over (D10): rolling, ending now. */
export const VELOCITY_WINDOWS = ['7d', '24h'] as const;
export type VelocityWindow = (typeof VELOCITY_WINDOWS)[number];

/** One window's figures (D26). */
export interface VelocityFigures {
  /** Tickets that reached done in the window, each once (D3). */
  done: number;
  /** Active time in the window (D6), in seconds. */
  active_seconds: number;
  /** Done per 24 h of active time (D8). */
  velocity_per_day: number;
  /** Remaining ÷ velocity in days, unrounded (D9, rag-t0062): 0 when nothing remains, `null` when unknown. */
  eta_days: number | null;
  /** Tickets added in the window: their first entry into a counted state (D33). */
  added: number;
  /** (Done − added) per 24 h of active time (D33, rag-t0071); negative when the queue grows. */
  adj_velocity_per_day: number;
  /**
   * Remaining ÷ adjusted velocity in days (D34): 0 when nothing remains, `null`
   * when nothing was done or added, `'infinite'` when the queue is not shrinking.
   */
  adj_eta_days: number | 'infinite' | null;
}

/**
 * `GET /tracker/{project}/velocity` (D26). The counts are now, whatever the
 * window (D4, D5); a project with no ticket answers zeros, not a 404.
 */
export interface Velocity {
  project: string;
  now: string;
  /** `in_progress` or `review`, not blocked (R5). */
  in_progress: number;
  /** Of `in_progress`, those in review. */
  in_review: number;
  /** `pending` or `failed`, plus every blocked ticket but a deferred one (R6). */
  pending: number;
  /** Of `pending`, those blocked. */
  blocked: number;
  /** Deferred: in neither count. */
  deferred: number;
  /** `in_progress + pending` (D5). */
  remaining: number;
  windows: Record<VelocityWindow, VelocityFigures>;
}

// ---- The report (spec:velocity D27) -----------------------------------------

/**
 * One hour of the burn-down (D16), in UTC, over the last 7 days whatever the
 * window; the first and last may be partial.
 */
export interface ReportBucket {
  /** RFC 3339 UTC: 7 days before `end` for the first, a whole hour after. */
  start: string;
  /** Remaining (D5) at the bucket's end. */
  remaining: number;
  /** Created, or first published from a draft, in it. */
  added: number;
  /** Reached done in it, each ticket once (D3). */
  done: number;
}

/** The states the report times (D17), in its order: four statuses and the block. */
export const REPORT_STATES = ['pending', 'in_progress', 'review', 'deferred', 'blocked'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/**
 * One state's time (D17): over the spans that ended in the window (`null`s
 * when none did), and the spans still open now.
 */
export interface StateTime {
  count: number;
  mean_seconds: number | null;
  median_seconds: number | null;
  /** Nearest rank: one of the lengths. */
  p90_seconds: number | null;
  open: number;
  oldest_open_seconds: number | null;
}

/** Mean time to completion (D18): in progress since the last reopen, per ticket done. */
export interface ReportMttc {
  count: number;
  mean_seconds: number | null;
  median_seconds: number | null;
  /** Done without being in progress since the last reopen: not in the mean. */
  never_in_progress: number;
}

/** Mean time to resolution (D18): per review that ended in the window. */
export interface ReportMttr {
  count: number;
  mean_seconds: number | null;
  median_seconds: number | null;
  confirmed: number;
  sent_back: number;
}

/**
 * `GET /tracker/{project}/report?window=` (D27). Every block follows the
 * window (R10); an unknown project answers buckets of zeros, not a 404.
 */
export interface Report {
  project: string;
  window: VelocityWindow;
  start: string;
  end: string;
  /** The window's figures, as the widget reads them (D26). */
  velocity: VelocityFigures;
  buckets: ReportBucket[];
  states: Record<ReportState, StateTime>;
  mttc: ReportMttc;
  mttr: ReportMttr;
}

// ---- The roadmap (spec:roadmap D1, D24, D25; api.md § Phases and the roadmap) --

/** A phase's size and progress (D25), from its linked tickets now. */
export interface PhaseSize {
  /** Frozen, drafts left out. */
  frozen: number;
  /** Unfrozen and not done or cancelled, drafts left out. */
  open: number;
  /** Done, drafts left out. */
  done: number;
  /** Cancelled, drafts left out. */
  cancelled: number;
  /** Every linked draft, whatever its status. */
  drafts: number;
  /** Blocked, of `frozen` and `open`. */
  blocked: number;
  /** Every linked ticket. */
  total: number;
  /** Released, with at least one linked ticket and all of them done or cancelled (D15). */
  complete: boolean;
}

/** A phase (D1). */
export interface Phase {
  id: string;
  project: string;
  title: string;
  /** Markdown. */
  body: string;
  state: PhaseState;
  /** Its neighbours on the roadmap; planned phases only. */
  prev_id: string | null;
  next_id: string | null;
  /** The ends of its list of frozen tickets; planned phases only. */
  head_id: string | null;
  tail_id: string | null;
  /** `null` while not released. An archived phase keeps it: unarchiving reads it. */
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A ticket left waiting across the boundary (D13). */
export interface Waiting {
  ticket: string;
  on: string;
}

/** `GET …/phases/{id}`, and every phase write's reply. */
export interface PhaseRecord extends Phase {
  size: PhaseSize;
  /** Oldest first; empty with `history=false`. */
  events: TrackerEvent[];
  /**
   * With `tickets=true`: its linked tickets in full, frozen in the phase's
   * order, then unfrozen queued in the queue's order, then the rest by age.
   */
  tickets?: Item[];
  /** With `tickets=true`: what its next release or recall would leave waiting (D13). */
  would_wait?: Waiting[];
}

/** The reply to a release or a recall (D13). */
export interface PhaseOutcome extends PhaseRecord {
  /** How many tickets the write moved. */
  moved: number;
  /** A release's place in words (`bottom`, `top`, `before <id>`); `null` on a recall. */
  placed: string | null;
  /** What the write left waiting, after it. */
  waiting: Waiting[];
}

/** One phase in the forward look: no body, as the roadmap reads many phases. */
export interface PhaseFigures {
  id: string;
  project: string;
  title: string;
  state: PhaseState;
  released_at: string | null;
  created_at: string;
  updated_at: string;
  size: PhaseSize;
  /** The counted tickets its ETA covers. */
  ahead: number;
  /** `ahead` ÷ velocity, in fractional days of active work; `null` when unknown (D24). */
  eta_days: number | null;
}

/**
 * `GET /tracker/{project}/roadmap?window=` (D24). Durations of active work,
 * never dates, computed on request; an unknown project answers it empty.
 */
export interface Roadmap {
  project: string;
  window: VelocityWindow;
  now: string;
  velocity_per_day: number;
  queue: { remaining: number; eta_days: number | null };
  /** The project's frozen tickets, drafts included. */
  frozen: number;
  /** The last planned phase's ETA, or the queue's with none planned. */
  planned_out_days: number | null;
  /** Released and incomplete, soonest first. */
  released: PhaseFigures[];
  /** In the roadmap's order. */
  planned: PhaseFigures[];
  /** Released and complete, newest release first. */
  complete: PhaseFigures[];
  /** Newest change first. */
  archived: PhaseFigures[];
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
  /**
   * Create it in a phase (spec:roadmap D7): frozen at a planned phase's tail, or
   * straight into the queue from a released one. Never blank: the server refuses it.
   */
  phase?: string;
}

/**
 * A ticket's phase, on its own (spec:roadmap D8, D9): `phase` or `frozen`, and
 * at most a note. The server refuses anything beside them, which is why this
 * is not part of {@link ItemUpdate}: a stamped event must never hide a status
 * change from the feed.
 */
export type ItemPhaseChange =
  | {
      /** A phase id to move it there, or `''` to remove the link. */
      phase: string;
      note?: string;
    }
  | {
      /** `false` pulls it to the queue, `true` freezes it again in its own phase. */
      frozen: boolean;
      note?: string;
    };

/** `POST /tracker/{project}/phases`. */
export interface PhaseCreate {
  title: string;
  body?: string;
  note?: string;
  /** Where it joins the roadmap; the bottom by default. */
  place?: Place;
}

/** `POST /tracker/{project}/phases/{id}`: title and body, in any state. */
export interface PhaseUpdate {
  title?: string;
  body?: string;
  note?: string;
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
  /** The document, item or phase id. */
  tracker_id?: string;
  /** A document's kind (`spec`, `milestone`, `concept`, `doc`), or `item`, or `phase`. */
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
