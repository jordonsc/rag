/**
 * The small pieces every tracker row is drawn from: the status dot, the type,
 * the approval, the link chips, the label chips, the parallel badge, what a
 * blocked item waits on, and a row's second line.
 */

import type { ReactNode } from 'react';
import { Badge, Button, Icon } from '@rag/ui';
import { Link } from 'react-router';

import { cx } from '../util';
import { itemPath, linkHref, projectPath } from './paths';
import styles from './tracker.module.css';
import type { Approval, Item, Link as ItemLink } from './types';
import {
  approvalLabel,
  approvalTone,
  itemStatusLabel,
  itemTypeHint,
  itemTypeIcon,
  itemTypeLabel,
  linkKindIcon,
  linkKindLabel,
  ITEM_TYPE_SIZER,
  STATUS_SIZER,
  type DotState,
} from './vocab';

/**
 * R12's colours, **always beside the word**: green done, blue in progress,
 * white pending, red failed, amber blocked, teal deferred, and red review
 * (rag-t0024), whose dot is a diamond so it is not failed's red disc. The
 * word is what a colour-blind reader, a screen reader and a test all read.
 */
export function StatusDot({
  state,
  compact = false,
  slotted = false,
}: {
  state: DotState;
  compact?: boolean;
  /**
   * On a row (rag-t0033): the word is stacked over a hidden copy of every
   * status word, so the status column is the widest word's width on every
   * row and in every section, in any font, and nothing after it moves.
   */
  slotted?: boolean;
}) {
  const label = itemStatusLabel(state);
  return (
    <span
      className={cx(styles.status, styles[`status_${state}`], slotted && styles.statusSlotted)}
      data-state={state}
    >
      <span className={styles.statusDot} aria-hidden />
      <span
        className={cx(styles.statusLabel, compact && styles.statusLabelCompact)}
        data-sizer={slotted ? STATUS_SIZER : undefined}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * An item's type: its glyph and its word. `slotted` draws it in a slot as wide
 * as the widest type (rag-t0033), so what follows it on a row's second line,
 * the assignee, starts at the same x on every row whatever the type. The slot
 * is a hidden stack of every type's word under the badge's (`data-sizer`,
 * drawn by the stylesheet's `::after`), so it is the widest word's own
 * rendered width in whatever font the page has, not a guess in `ch`.
 */
export function TypeBadge({ type, slotted = false }: { type: string; slotted?: boolean }) {
  return (
    <span
      className={cx(styles.type, slotted && styles.typeSlotted)}
      title={itemTypeHint(type)}
      data-type={type}
    >
      <Icon name={itemTypeIcon(type)} size={13} />
      <span className={styles.typeLabel} data-sizer={slotted ? ITEM_TYPE_SIZER : undefined}>
        {itemTypeLabel(type)}
      </span>
    </span>
  );
}

/**
 * The approval, when there is one to show. `unapproved` draws nothing in a row
 * (it is the default and would be on every line); the item page always shows it.
 */
export function ApprovalBadge({
  approval,
  always = false,
}: {
  approval: Approval;
  always?: boolean;
}) {
  if (approval === 'unapproved' && !always) {
    return null;
  }
  return (
    <span className={styles.approval} data-approval={approval}>
      <Badge tone={approvalTone(approval)}>{approvalLabel(approval)}</Badge>
    </span>
  );
}

export interface ApprovalControlProps {
  /** The row's item: its id names the control for a screen reader. */
  id: string;
  approval: Approval;
  /** Ratify an agent's approval. Given, an `agent` badge is a button that calls it. */
  onRatify?: () => void;
  /** Approve as the owner. Given, an `unapproved` row shows an Approve button. */
  onApprove?: () => void;
}

/**
 * A dashboard row's approval, with the owner's quick write where there is one
 * (rag-t0009): the **Agent-approved** badge is itself a button that opens the
 * ratify confirmation, and an unapproved row carries a small **Approve**. Both
 * open a dialog first; nothing is written on the click. Every other approval
 * draws as {@link ApprovalBadge}.
 *
 * Both look like buttons at rest (rag-t0025): Approve is the design system's
 * tinted `accent` button, and the ratify badge carries an amber fill under its
 * border. Neither hover is a row's colour (a plain row's hover, or the
 * in-progress row's blue), so neither vanishes under the pointer.
 */
export function ApprovalControl({ id, approval, onRatify, onApprove }: ApprovalControlProps) {
  if (approval === 'agent' && onRatify !== undefined) {
    return (
      <span className={styles.approval} data-approval={approval}>
        <button
          type="button"
          className={styles.approvalButton}
          aria-label={`${approvalLabel('agent')}: ratify ${id}`}
          title="Ratify the agent’s approval"
          onClick={onRatify}
        >
          <Badge tone={approvalTone(approval)}>{approvalLabel(approval)}</Badge>
        </button>
      </span>
    );
  }
  if (approval === 'unapproved' && onApprove !== undefined) {
    return (
      <span className={styles.approval} data-approval={approval}>
        <Button
          size="sm"
          variant="accent"
          aria-label={`Approve ${id}`}
          title="Approve as the owner"
          onClick={onApprove}
        >
          <Icon name="shield-check" size={13} />
          Approve
        </Button>
      </span>
    );
  }
  return <ApprovalBadge approval={approval} />;
}

export interface LinkChipsProps {
  project: string;
  links: readonly ItemLink[];
  /** How many to draw before `+N`. */
  max?: number;
  /** Milestone document paths already looked up, keyed `spec/code`. */
  resolved?: Readonly<Record<string, string>>;
}

/** A row's links as chips: a ledger id opens its topic, an item its page. */
export function LinkChips({ project, links, max = 3, resolved = {} }: LinkChipsProps) {
  if (links.length === 0) {
    return null;
  }
  const shown = links.slice(0, max);
  const rest = links.length - shown.length;
  return (
    <span className={styles.chips}>
      {shown.map((link) => {
        const href = linkHref(project, link, resolved[link.target]);
        const content = (
          <>
            <Icon name={linkKindIcon(link.kind)} size={12} />
            <span>{link.target}</span>
          </>
        );
        const title = `${linkKindLabel(link.kind)}: ${link.target}`;
        return href === null ? (
          <span key={`${link.kind}:${link.target}`} className={styles.chip} title={title}>
            {content}
          </span>
        ) : (
          <Link
            key={`${link.kind}:${link.target}`}
            to={href}
            className={cx(styles.chip, styles.chipLink)}
            title={title}
          >
            {content}
          </Link>
        );
      })}
      {rest > 0 && <span className={styles.chipMore}>+{rest}</span>}
    </span>
  );
}

export interface LabelChipsProps {
  project: string;
  labels: readonly string[];
  /** Where a chip leads; the dashboard filtered to it by default. */
  to?: (label: string) => string;
}

/** The dashboard filtered to one label: `?label=` (rag-t0027). */
export function labelFilterPath(project: string, label: string): string {
  return `${projectPath(project)}?${new URLSearchParams({ label }).toString()}`;
}

/** This page filtered to one label: `?label=` (the History page's own filter). */
export function labelQuery(label: string): string {
  return `?${new URLSearchParams({ label }).toString()}`;
}

/**
 * An item's labels as chips (rag-t0027), each a link to the dashboard
 * filtered to it (or wherever `to` says). Nothing when it has none. All are
 * drawn: an item carries at most ten, and the row's second line wraps. A
 * click stays on the chip, so a clickable row under it does not open the
 * item as well.
 */
export function LabelChips({ project, labels, to }: LabelChipsProps) {
  if (labels.length === 0) {
    return null;
  }
  return (
    <span className={styles.labels} aria-label="Labels">
      {labels.map((label) => (
        <Link
          key={label}
          to={to === undefined ? labelFilterPath(project, label) : to(label)}
          className={styles.label}
          title={`Show the tickets labelled ${label}`}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="tag" size={11} />
          <span>{label}</span>
        </Link>
      ))}
    </span>
  );
}

/**
 * The **Parallel** badge (rag-t0013): the item may start before the gates
 * above it clear, and still lands after them.
 */
export function ParallelBadge() {
  return (
    <span className={styles.parallel} title="May start before the gates above it; lands after them">
      <Badge tone="neutral">Parallel</Badge>
    </span>
  );
}

/** What a Draft badge's tooltip says (2026-10-30). */
export const DRAFT_HINT =
  'A draft: not yet published. The feed leaves its changes out, so agents watching it are not woken, and nothing dispatches it.';

/**
 * The **Draft** badge (2026-10-30): the record is the owner's, not yet
 * published. Dashed, as the Drafts section's edge is: not final yet.
 */
export function DraftBadge() {
  return (
    <span className={styles.draftBadge} title={DRAFT_HINT}>
      <Badge tone="neutral">Draft</Badge>
    </span>
  );
}

/**
 * What an item blocked with reason `dependency` waits on (rag-t0018), each a
 * link to its item page. Nothing when it waits on nothing.
 */
export function WaitsOn({ project, ids }: { project: string; ids: readonly string[] }) {
  if (ids.length === 0) {
    return null;
  }
  return (
    <span className={styles.waitsOn}>
      <span>waits on</span>
      {ids.map((id) => (
        <Link key={id} to={itemPath(project, id)} className={cx(styles.chip, styles.chipLink)}>
          <Icon name={linkKindIcon('item')} size={12} />
          <span>{id}</span>
        </Link>
      ))}
    </span>
  );
}

export interface SecondLineProps {
  project: string;
  item: Item;
  /** What follows the type and the assignee on the left: a badge, what it waits on. */
  children?: ReactNode;
}

/**
 * A row's second line (rag-t0026): the type, the assignee and whatever the
 * section adds on the left (a badge, what a blocked item waits on), the
 * labels (rag-t0027) on the right. The first line is the status, the id, the
 * title (taking the free width), the approval and the section's own actions.
 *
 * No link chips (rag-t0031): an item's ledger, spec, milestone, concept and
 * item links are drawn on its page only. The labels took their slot, the
 * line's right end, where they wrap, and on a phone take a line of their own.
 */
export function SecondLine({ project, item, children }: SecondLineProps) {
  const labels = item.labels ?? [];
  return (
    <span className={styles.cellLine2}>
      <span className={styles.line2Start}>
        {/* The type and the assignee stay on one line (rag-t0033): a long
            name is cut short rather than wrapped under the type, so it keeps
            the column on a phone too. Its full text is its tooltip. */}
        <span className={styles.line2Who}>
          <TypeBadge type={item.type} slotted />
          {item.assignee !== null && item.assignee !== '' && (
            <span className={styles.assignee} title="Assignee">
              <Icon name="user" size={12} />
              <span className={styles.assigneeName} title={item.assignee}>
                {item.assignee}
              </span>
            </span>
          )}
        </span>
        {children}
      </span>
      {labels.length > 0 && (
        <span className={styles.line2End}>
          <LabelChips project={project} labels={labels} />
        </span>
      )}
    </span>
  );
}
