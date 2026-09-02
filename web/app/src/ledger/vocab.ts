/**
 * How the ledger's vocabularies are drawn: labels, glyphs, and the one colour
 * decision this application makes.
 *
 * It lives in the application rather than in `@rag/ui` because the design
 * system does not know what a topic is, and should not learn: `StateDot` takes
 * a tone, `Badge` takes a tone, and *which* tone a `wontfix` deserves is a
 * judgement about this domain. Keeping it in one table means the judgement is
 * made once and can be argued with, rather than being re-made per view.
 */

import type { Tone } from '@rag/ui';

import {
  TOPIC_STATUSES,
  TOPIC_TYPES,
  type EventKind,
  type LinkRel,
  type TopicStatus,
  type TopicType,
} from '../api';

/**
 * Read a display table with a value the server *should* only ever send from
 * the vocabulary, but which arrives as a string.
 *
 * An unknown value is returned as itself rather than coerced onto a default: a
 * status this build has not heard of is a fact worth seeing, and silently
 * drawing it as `open` would state something nobody claimed.
 *
 * **`Object.hasOwn` is what makes that promise true.** A plain index reads
 * through the prototype chain, so `'constructor'`, `'toString'` and `'valueOf'`
 * come back as inherited *functions* — non-`undefined`, and neither a label nor
 * the value itself. Nothing reaches these tables today except values the server
 * derived from a Rust enum, so this is unreachable; a stated contract that the
 * code does not keep is worth one line to close regardless.
 */
function lookup<K extends string, V>(table: Record<K, V>, value: string): V | undefined {
  return Object.hasOwn(table, value) ? (table as Record<string, V>)[value] : undefined;
}

// ---- Topic type -------------------------------------------------------------

const TYPE_LABEL: Record<TopicType, string> = {
  decision: 'Decision',
  incident: 'Incident',
  defect: 'Defect',
  investigation: 'Investigation',
};

/** What each type *is*, for a reader who has not met the vocabulary. */
const TYPE_HINT: Record<TopicType, string> = {
  decision: 'A deliberate choice, its rationale, and what was rejected',
  incident: 'A live-system failure and its post-mortem',
  defect: 'A bug caught in development, and its fix',
  investigation: 'A spike whose value is the finding, even with no code change',
};

const TYPE_ICON: Record<TopicType, string> = {
  decision: 'git-branch',
  incident: 'octagon-alert',
  defect: 'circle-x',
  investigation: 'search',
};

export function typeLabel(type: string): string {
  return lookup(TYPE_LABEL, type) ?? type;
}

export function typeHint(type: string): string | undefined {
  return lookup(TYPE_HINT, type);
}

export function typeIcon(type: string | undefined): string {
  return type === undefined ? 'circle-dot' : (lookup(TYPE_ICON, type) ?? 'circle-dot');
}

// ---- Status -----------------------------------------------------------------

const STATUS_LABEL: Record<TopicStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  proposed: 'Proposed',
  accepted: 'Accepted',
  superseded: 'Superseded',
  reverted: 'Reverted',
  wontfix: "Won't fix",
};

/**
 * **The status → tone mapping.** The one place a lifecycle word becomes a colour.
 *
 * Five tones for seven statuses, so the grouping is the argument:
 *
 * * `warn` — **open**. Something is unfinished and nobody has said otherwise.
 *   The only status that means *this is still costing someone something*.
 * * `acc` — **proposed**. In flight: written down, not yet agreed. Distinct
 *   from `open` because the work is the deciding, not the fixing.
 * * `good` — **accepted**, **resolved**. Landed. Two words for the same shape
 *   of ending, one for a decision and one for everything else.
 * * `crit` — **reverted**. A conclusion that was taken back, which is the one
 *   history a reader most needs warning about before they act on it. Loud
 *   deliberately; it is rare, and a reader following a reverted decision is
 *   the failure this colour exists to prevent.
 * * `neutral` — **superseded**, **wontfix**. Closed and no longer live, with
 *   nothing to warn about. Superseded topics are kept precisely so the trail
 *   survives, and greying them is what says *read the successor instead*.
 *
 * `reverted` is **not** given `StateDot`'s `emphasis` pill. That treatment is
 * for a state needing a person right now, and a reverted topic is history
 * rather than an alarm.
 */
const STATUS_TONE: Record<TopicStatus, Tone> = {
  open: 'warn',
  proposed: 'acc',
  accepted: 'good',
  resolved: 'good',
  reverted: 'crit',
  superseded: 'neutral',
  wontfix: 'neutral',
};

/**
 * The status a topic is given when its creator does not choose one.
 *
 * A **mirror** of `TopicType::default_status` in the store, and the only thing
 * in this file that duplicates a server decision rather than making a display
 * one. It earns that: without it a create form can either offer a status field
 * with a blank default — leaving the reader to submit and find out — or invent
 * a default of its own and disagree with the ledger. Showing the real answer in
 * the control is worth one table that has to be kept honest.
 *
 * A decision starts `proposed` because it has been written down and not yet
 * agreed. Everything else starts `open`, because an incident, a defect and an
 * investigation all begin as something unfinished.
 */
const DEFAULT_STATUS: Record<TopicType, TopicStatus> = {
  decision: 'proposed',
  incident: 'open',
  defect: 'open',
  investigation: 'open',
};

export function defaultStatus(type: TopicType): TopicStatus {
  return DEFAULT_STATUS[type];
}

export function statusLabel(status: string): string {
  return lookup(STATUS_LABEL, status) ?? status;
}

export function statusTone(status: string | undefined): Tone {
  if (status === undefined) {
    return 'neutral';
  }
  return lookup(STATUS_TONE, status) ?? 'neutral';
}

// ---- Event kind -------------------------------------------------------------

const KIND_LABEL: Record<EventKind, string> = {
  note: 'Note',
  state_change: 'State change',
  status_change: 'Status change',
  correction: 'Correction',
  link: 'Link',
};

const KIND_ICON: Record<EventKind, string> = {
  note: 'file-text',
  state_change: 'refresh',
  status_change: 'circle-dot',
  correction: 'pencil',
  link: 'link',
};

export function kindLabel(kind: string): string {
  return lookup(KIND_LABEL, kind) ?? kind;
}

export function kindIcon(kind: string): string {
  return lookup(KIND_ICON, kind) ?? 'file-text';
}

// ---- Links ------------------------------------------------------------------

const REL_LABEL: Record<LinkRel, string> = {
  supersedes: 'Supersedes',
  superseded_by: 'Superseded by',
  related: 'Related',
  caused_by: 'Caused by',
};

const REL_ICON: Record<LinkRel, string> = {
  supersedes: 'arrow-right',
  superseded_by: 'arrow-left',
  related: 'link',
  caused_by: 'corner-down-right',
};

/**
 * The order link groups are drawn in — the two that change what a reader
 * should believe first, then the two that merely add context.
 */
export const REL_ORDER: readonly LinkRel[] = [
  'superseded_by',
  'supersedes',
  'caused_by',
  'related',
];

export function relLabel(rel: string): string {
  return lookup(REL_LABEL, rel) ?? rel;
}

export function relIcon(rel: string): string {
  return lookup(REL_ICON, rel) ?? 'link';
}

// ---- Options for controls ---------------------------------------------------

/**
 * `SelectOption` lists for the filter controls.
 *
 * Built from the vocabulary constants rather than from `Object.keys` over the
 * label tables: the constants are what the union types are derived from, so a
 * status added to the enum and forgotten here is a missing key on the `Record`
 * — a compile error — rather than an option that silently never appears.
 */
export function typeOptions(): Array<{ value: string; label: string; detail?: string }> {
  return TOPIC_TYPES.map((value) => ({
    value,
    label: TYPE_LABEL[value],
    detail: TYPE_HINT[value],
  }));
}

export function statusOptions(): Array<{ value: string; label: string }> {
  return TOPIC_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }));
}
