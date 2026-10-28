/**
 * How the tracker's vocabularies are drawn: labels, glyphs and tones.
 *
 * The same arrangement as `ledger/vocab.ts`: the design system takes a tone and
 * knows nothing of items, so the judgement of which colour a status deserves
 * is made here, once. The status colours are R12's, the manager's status
 * report's: **green done, blue in progress, white pending, red failed, amber
 * blocked**, the owner's **teal deferred** (rag-t0017) and **red review**
 * (rag-t0024: red as failed is, told apart by its word and its diamond). Every
 * one of them is drawn beside its word, never alone.
 */

import type { Tone } from '@rag/ui';

import type {
  Approval,
  BlockReason,
  ConceptState,
  DocumentKind,
  Intensity,
  ItemStatus,
  ItemType,
  LinkKind,
  MilestoneState,
  SpecState,
  Surface,
  TrackerEventKind,
} from './types';

/** An unknown value comes back as itself (see `ledger/vocab.ts`'s `lookup`). */
function lookup<V>(table: Record<string, V>, value: string): V | undefined {
  return Object.hasOwn(table, value) ? table[value] : undefined;
}

// ---- Type -------------------------------------------------------------------

const TYPE_LABEL: Record<ItemType, string> = {
  dev: 'Dev',
  design: 'Design',
  recon: 'Recon',
  analysis: 'Analysis',
  gate: 'Gate',
  request: 'Request',
};

const TYPE_HINT: Record<ItemType, string> = {
  dev: 'Implement a spec or a milestone',
  design: 'Artwork, image generation',
  recon: 'Research and preparation',
  analysis: 'Debugging',
  gate: 'Gate and release',
  request: 'The owner’s idea, broken into tickets by the manager',
};

const TYPE_ICON: Record<ItemType, string> = {
  dev: 'hammer',
  design: 'palette',
  recon: 'telescope',
  analysis: 'bug',
  gate: 'flag',
  request: 'message-square',
};

export function itemTypeLabel(type: string): string {
  return lookup(TYPE_LABEL, type) ?? type;
}

export function itemTypeHint(type: string): string | undefined {
  return lookup(TYPE_HINT, type);
}

export function itemTypeIcon(type: string): string {
  return lookup(TYPE_ICON, type) ?? 'circle-dot';
}

/**
 * Every type's word, one a line: the hidden sizer under a row's type
 * (rag-t0033). Drawn in the badge's own font with `white-space: pre`, it is as
 * wide as the widest of them however the page's font sets them, so the slot is
 * never a guess and no word can overflow it.
 */
export const ITEM_TYPE_SIZER: string = Object.values(TYPE_LABEL).join('\n');

// ---- Status -----------------------------------------------------------------

/**
 * The dot's colour, by status, plus `blocked`, which is a flag rather than a
 * status but is drawn as one (R9, R12).
 */
export type DotState = ItemStatus | 'blocked';

const STATUS_LABEL: Record<DotState, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deferred: 'Deferred',
  review: 'Review',
  blocked: 'Blocked',
};

export function itemStatusLabel(status: string): string {
  return lookup(STATUS_LABEL, status) ?? status;
}

/**
 * Every status word, one a line: the hidden sizer under a row's status
 * (rag-t0033), so a row's status column is as wide as the widest word in
 * whatever font the page has, on every row of every section alike.
 */
export const STATUS_SIZER: string = Object.values(STATUS_LABEL).join('\n');

/**
 * The state a row's dot shows: blocked wins over the status beneath it, except
 * deferred and review, which an item keeps whether blocked or not (each is
 * listed in its own section either way).
 */
export function dotState(item: { status: ItemStatus; blocked: boolean }): DotState {
  return item.blocked &&
    item.status !== 'done' &&
    item.status !== 'cancelled' &&
    item.status !== 'deferred' &&
    item.status !== 'review'
    ? 'blocked'
    : item.status;
}

/**
 * The status transitions the server allows (api.md § Status transitions;
 * `crates/core/src/tracker/items.rs`).
 *
 * Used only to decide what to *offer*: the server is the judge, and a refused
 * transition comes back in its own words.
 */
const TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  pending: ['in_progress', 'done', 'failed', 'review', 'deferred', 'cancelled'],
  in_progress: ['pending', 'done', 'failed', 'review', 'deferred', 'cancelled'],
  failed: ['pending', 'review', 'deferred', 'cancelled'],
  deferred: ['pending', 'in_progress', 'done', 'cancelled'],
  review: ['done', 'in_progress', 'pending', 'cancelled'],
  done: ['pending'],
  cancelled: ['pending'],
};

export function nextStatuses(status: ItemStatus): readonly ItemStatus[] {
  return lookup(TRANSITIONS, status) ?? [];
}

/** How a transition reads on a button or an option. */
export function transitionLabel(from: ItemStatus, to: ItemStatus): string {
  if (to === 'pending') {
    return from === 'done' || from === 'cancelled'
      ? 'Reopen (back to the top of the queue)'
      : from === 'failed'
        ? 'Retry (pending, in place)'
        : from === 'deferred'
          ? 'Resume (pending, in place)'
          : from === 'review'
            ? 'Send back to pending (in place)'
            : 'Back to pending';
  }
  if (to === 'deferred') {
    return 'Defer (keeps its place)';
  }
  if (to === 'review') {
    return 'Review (waits on the owner, keeps its place)';
  }
  if (from === 'review' && to === 'in_progress') {
    return 'Send back (in progress, in place)';
  }
  if (from === 'review' && to === 'done') {
    return 'Confirm (done, leaves the queue)';
  }
  if (to === 'cancelled') {
    return 'Cancel (leaves the queue)';
  }
  if (to === 'done') {
    return 'Done (leaves the queue)';
  }
  return itemStatusLabel(to);
}

// ---- Block reason -----------------------------------------------------------

/**
 * `approval` (once "Needs approval") is retired: the status `review` replaced
 * it (rag-t0024), so an old event or an older server's row shows the raw word.
 */
const REASON_LABEL: Record<BlockReason, string> = {
  redesign: 'Needs redesign',
  review: 'Needs review',
  dependency: 'Waits on tickets',
};

export function blockReasonLabel(reason: string): string {
  return lookup(REASON_LABEL, reason) ?? reason;
}

// ---- Gate intensity ---------------------------------------------------------

const INTENSITY_LABEL: Record<Intensity, string> = {
  quick: 'Quick',
  standard: 'Standard',
  full: 'Full',
};

export function intensityLabel(intensity: string): string {
  return lookup(INTENSITY_LABEL, intensity) ?? intensity;
}

/** The default title of a gate: `Standard gate`. */
export function gateTitle(intensity: Intensity, release: boolean): string {
  return `${intensityLabel(intensity)} gate${release ? ' and release' : ''}`;
}

// ---- Approval ---------------------------------------------------------------

const APPROVAL_LABEL: Record<Approval, string> = {
  unapproved: 'Unapproved',
  agent: 'Agent-approved',
  ratified: 'Ratified',
  owner: 'Owner-approved',
};

/**
 * `agent` is the one to look at: an agent's approval the owner has not yet
 * ratified, which is what the dashboard's filter finds.
 */
const APPROVAL_TONE: Record<Approval, Tone> = {
  unapproved: 'neutral',
  agent: 'warn',
  ratified: 'good',
  owner: 'good',
};

export function approvalLabel(approval: string): string {
  return lookup(APPROVAL_LABEL, approval) ?? approval;
}

export function approvalTone(approval: string): Tone {
  return lookup(APPROVAL_TONE, approval) ?? 'neutral';
}

// ---- Links, events, surfaces ------------------------------------------------

const LINK_LABEL: Record<LinkKind, string> = {
  spec: 'Spec',
  milestone: 'Milestone',
  concept: 'Concept',
  ledger: 'Ledger',
  item: 'Ticket',
  from: 'From request',
  became: 'Became',
};

const LINK_ICON: Record<LinkKind, string> = {
  spec: 'file-text',
  milestone: 'milestone',
  concept: 'sparkles',
  ledger: 'book-open',
  item: 'link',
  from: 'message-square',
  became: 'git-branch',
};

export function linkKindLabel(kind: string): string {
  return lookup(LINK_LABEL, kind) ?? kind;
}

export function linkKindIcon(kind: string): string {
  return lookup(LINK_ICON, kind) ?? 'link';
}

const EVENT_LABEL: Record<TrackerEventKind, string> = {
  note: 'Note',
  create: 'Created',
  status: 'Status',
  block: 'Blocked',
  unblock: 'Unblocked',
  approve: 'Approval',
  move: 'Moved',
  edit: 'Edited',
  link: 'Links',
  assign: 'Assigned',
  acknowledge: 'Acknowledged',
  rename: 'Renamed',
};

const EVENT_ICON: Record<TrackerEventKind, string> = {
  note: 'message-square',
  create: 'plus',
  status: 'circle-dot',
  block: 'lock',
  unblock: 'lock-open',
  approve: 'shield-check',
  move: 'grip-vertical',
  edit: 'pencil',
  link: 'link',
  assign: 'user',
  acknowledge: 'check-check',
  rename: 'pencil',
};

export function eventKindLabel(kind: string): string {
  return lookup(EVENT_LABEL, kind) ?? kind;
}

export function eventKindIcon(kind: string): string {
  return lookup(EVENT_ICON, kind) ?? 'circle-dot';
}

const SURFACE_LABEL: Record<Surface, string> = {
  web: 'web',
  mcp: 'MCP',
};

export function surfaceLabel(surface: string): string {
  return lookup(SURFACE_LABEL, surface) ?? surface;
}

// ---- Documents and their records (m04) ---------------------------------------

const SPEC_STATE_LABEL: Record<SpecState, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_development: 'In development',
  done: 'Done',
  superseded: 'Superseded',
};

const SPEC_STATE_TONE: Record<SpecState, Tone> = {
  draft: 'neutral',
  ready: 'acc',
  in_development: 'acc',
  done: 'good',
  superseded: 'neutral',
};

const MILESTONE_STATE_LABEL: Record<MilestoneState, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
};

const MILESTONE_STATE_TONE: Record<MilestoneState, Tone> = {
  not_started: 'neutral',
  in_progress: 'acc',
  done: 'good',
};

const CONCEPT_STATE_LABEL: Record<ConceptState, string> = {
  open: 'Open',
  refining: 'Refining',
  refined: 'Refined',
  archived: 'Archived',
};

const CONCEPT_STATE_TONE: Record<ConceptState, Tone> = {
  open: 'acc',
  refining: 'warn',
  refined: 'good',
  archived: 'neutral',
};

/** A record's state, whichever of the three vocabularies it is from. */
export function recordStateLabel(state: string): string {
  return (
    lookup(SPEC_STATE_LABEL, state) ??
    lookup(MILESTONE_STATE_LABEL, state) ??
    lookup(CONCEPT_STATE_LABEL, state) ??
    state
  );
}

export function recordStateTone(state: string): Tone {
  return (
    lookup(SPEC_STATE_TONE, state) ??
    lookup(MILESTONE_STATE_TONE, state) ??
    lookup(CONCEPT_STATE_TONE, state) ??
    'neutral'
  );
}

const DOC_KIND_LABEL: Record<DocumentKind, string> = {
  spec: 'Spec',
  milestone: 'Milestone',
  concept: 'Concept',
  doc: 'Document',
};

const DOC_KIND_ICON: Record<DocumentKind, string> = {
  spec: 'file-text',
  milestone: 'milestone',
  concept: 'sparkles',
  doc: 'file-text',
};

export function docKindLabel(kind: string): string {
  return lookup(DOC_KIND_LABEL, kind) ?? kind;
}

export function docKindIcon(kind: string): string {
  return lookup(DOC_KIND_ICON, kind) ?? 'file-text';
}

/** A size in bytes as a person reads it: `512 B`, `47.1 KB`, `3.2 MB`. */
export function byteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
