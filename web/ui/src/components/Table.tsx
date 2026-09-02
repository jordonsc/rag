import { Fragment, useMemo, useState, type ReactNode } from 'react';
import styles from './Table.module.css';
import { Icon } from './Icon';
import { EmptyState } from './status';
import { useT } from '../i18n';
import { cx } from '../util';

export type SortDirection = 'asc' | 'desc';

export interface TableSort {
  key: string;
  dir: SortDirection;
}

/**
 * One column.
 *
 * **There is no `width`, and its absence is deliberate.** A `width` written
 * onto the `<th>` as an inline style is an unshrinkable width that bypasses the
 * stylesheet — the one thing `Table.module.css` says may not exist. A column's
 * width is apportioned by **what it is**: mark it `identity` or `controls`, or
 * leave it unmarked and let auto layout size it (`Table.module.css` § *how a
 * column gets its width*).
 *
 * `prose` is a fourth flag and answers a different question — not *how much
 * width does this column ask for* but *may a word in it be severed to give
 * width back* — so it is set **as well as** one of the above rather than
 * instead of one.
 */
export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer; defaults to the sort/display value. */
  render?: (row: T) => ReactNode;
  /** Comparable value — required for sorting, used as the default cell text. */
  value?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  align?: 'left' | 'right';
  /**
   * The column carrying the row's **identity** — its glyph, its name and the
   * quieter line beneath it (`RowIdentity`).
   *
   * At most one per table. It takes the table's spare width and wraps; every
   * other column sits at its content width, so the eye lands on what a row
   * *is* rather than on whichever column happens to be widest. Marked at the
   * column rather than inferred from position: the identity is not always the
   * first column, and a selection checkbox is frequently in front of it.
   */
  identity?: boolean;
  /**
   * The column holds **controls** rather than data — a selection checkbox, a
   * row's action buttons.
   *
   * It is sized to its content and never wraps: a column of buttons is the one
   * column whose width is not negotiable, because a label that has wrapped
   * inside its button has not saved any space, it has broken the control. See
   * `Table.module.css` § *how a column gets its width* for the rule this is one
   * third of.
   */
  controls?: boolean;
  /**
   * The column carries **prose** — values with a space in them, so a line has
   * somewhere to break that is not the middle of a word.
   *
   * It is the column that **gives ground**: a table under pressure takes it out
   * of here, because prose is the one class of content that degrades by
   * wrapping rather than by being severed. Every other column keeps its words
   * whole and its floor is its longest one. `Table.module.css` § *how a column
   * gets its width* carries the rule and the arithmetic behind it.
   *
   * **A content class, not a type.** The caller answers it by looking at the
   * values it is about to draw: a boolean's *Yes*, an enum's *Condition* and an
   * id are one word each and are not prose whatever column they sit in; a
   * sentence is prose wherever it sits.
   */
  prose?: boolean;
}

/**
 * A group header, as the caller wants it drawn.
 *
 * The *content* is the caller's — a title, a glyph, a quieter line, and any
 * controls the group offers — while the disclosure, the count and the row
 * mechanics are the table's. That split is the same one the rest of this
 * component runs on: the caller says what a thing is, the table says how a
 * table draws it.
 */
export interface TableGroupHeader {
  /** The group's glyph, named in the icon registry like any other. */
  icon?: string;
  title: ReactNode;
  /** The quieter line that tells two similarly named groups apart. */
  secondary?: ReactNode;
  /** Controls offered on the header itself. Never inside the disclosure
   *  button — a control nested in a control is one the keyboard cannot reach
   *  separately. */
  actions?: ReactNode;
  /** The accessible name of the disclosure control, where the title is not a
   *  plain string. */
  label?: string;
}

/**
 * Folding a table's rows into **one level** of groups.
 *
 * Deliberately not a tree: an arbitrary depth would need a parent per row and a
 * renderer that draws *n* levels, and nothing here has asked for a second
 * level.
 *
 * **Group order is first appearance**, over the rows as sorted. The table never
 * reorders groups by anything of its own: a caller that has capped or ordered
 * its list means that order, and a consumer that re-sorted would silently void
 * it. Sorting a column therefore reorders rows *within* their groups and,
 * through first appearance, the groups with them.
 */
export interface TableGrouping<T> {
  /** The group a row belongs to. `undefined` draws the row at the top level. */
  keyOf: (row: T) => string | undefined;
  /** The header for one group, given its key and its rows in order. */
  header: (key: string, rows: readonly T[]) => TableGroupHeader;
  /** Whether groups start folded. Default false — a list that hides its
   *  contents on arrival is one the reader has to work to read. */
  collapsed?: boolean;
  /** A group of one draws as an ordinary row. Default true. */
  flattenSingletons?: boolean;
  /**
   * **The header is the row, and opening one closes the last.**
   *
   * Off by default, and opt-in rather than universal: a table that groups is
   * not necessarily a table that accordions, and a list whose every group is
   * worth reading at once is made worse by folding it to one. Where it is on,
   * three things change together —
   *
   * * the header wears the shared row treatment (`rows.module.css`) and is the
   *   selectable element, rather than a heading above rows that are;
   * * its members draw on a distinct ground, so the run reads as one thing;
   * * **at most one group is open**, and `collapsed` stops being a per-group
   *   starting position and becomes the accordion's initial state: `true` opens
   *   nothing, `false` opens the first.
   *
   * `flattenSingletons` is unaffected and still flattens: a header you must
   * open to see one row is a click that buys nothing.
   */
  expand?: boolean;
}

/** What the body draws, in order: a plain row, or a group and its members. */
type Run<T> = { kind: 'row'; row: T } | { kind: 'group'; key: string; rows: T[] };

/**
 * Gather the rows into runs — the whole of the grouping arithmetic.
 *
 * A group is emitted where its **first** row appears and takes all of its rows
 * with it, so the caller's ordering decides the group order and a group is
 * never split in two by a row of something else landing in the middle of it.
 */
export function groupRuns<T>(rows: readonly T[], grouping: TableGrouping<T>): Run<T>[] {
  const members = new Map<string, T[]>();
  for (const row of rows) {
    const key = grouping.keyOf(row);
    if (key === undefined || key === '') {
      continue;
    }
    const existing = members.get(key);
    if (existing === undefined) {
      members.set(key, [row]);
    } else {
      existing.push(row);
    }
  }

  const flatten = grouping.flattenSingletons !== false;
  const runs: Run<T>[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const key = grouping.keyOf(row);
    if (key === undefined || key === '') {
      runs.push({ kind: 'row', row });
      continue;
    }
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    const group = members.get(key) ?? [row];
    if (flatten && group.length === 1) {
      runs.push({ kind: 'row', row: group[0]! });
    } else {
      runs.push({ kind: 'group', key, rows: group });
    }
  }
  return runs;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Empty-state content; defaults to the catalogue's table.empty message. */
  empty?: ReactNode;
  defaultSort?: TableSort;
  /**
   * The row that is currently the subject of something else on screen — a
   * detail panel beside the table. Marked with a rail and `aria-selected`, so
   * "which of these am I reading" is answered by the list as well as by the
   * panel.
   */
  selectedKey?: string;
  /**
   * Rows the caller is **holding on screen past the read that stopped
   * returning them** — drawn dimmed, and otherwise ordinary rows.
   *
   * A typed set of `rowKey` values rather than a class name or a flag on the
   * row, for two reasons. A class name would put a stylesheet decision in the
   * caller's hands and there would be nothing to stop a second caller inventing
   * a different one; a flag inside the row would have the table writing into
   * data that is not its own.
   *
   * The rule it draws: a reader whose edit drops a row out of the current
   * filter must not watch the row they are reading disappear. What "stale"
   * *means* is entirely the caller's; all the table knows is that these rows
   * are on their way out and should look it. They stay selectable, sortable,
   * groupable and clickable, because a row that has gone quiet is still the row
   * the panel beside it belongs to.
   */
  staleKeys?: ReadonlySet<string>;
  /**
   * Rows that are **here and are not what the reader came for** — drawn
   * de-emphasised, and otherwise ordinary rows.
   *
   * It is what a list shows instead of filtering: where most of the rows are
   * background, "not the thing you came for" has to be a property you can see
   * while scanning rather than one you have to open something to find.
   *
   * **A typed set of `rowKey` values**, for the two reasons {@link
   * TableProps.staleKeys} gives above.
   *
   * **Distinct from `staleKeys` and drawn differently**, which is the point of
   * a second prop rather than a second caller of the first. Stale is a
   * *transient* state — a row held past the read that stopped returning it —
   * and quiet is a *standing* one that most of the list is in. Merging them
   * would make "on its way out" and "ordinary background" the same picture, on
   * a list where both appear at once.
   *
   * Quiet rows stay selectable, sortable, groupable and clickable. A consumer
   * that skipped them would have reimplemented the filter this replaced, in a
   * place the reader cannot see or change.
   */
  quietKeys?: ReadonlySet<string>;
  onRowClick?: (row: T) => void;
  /** Fold the rows into one level of collapsible groups. */
  grouping?: TableGrouping<T>;
  /**
   * The **group** that is the subject of something else on screen — the header
   * counterpart of {@link selectedKey}, and mutually exclusive with it because
   * one panel has one subject. Enforcing that is the caller's: a table draws
   * what it is told is selected.
   */
  selectedGroupKey?: string;
  /**
   * Selecting a group header, which is what makes it a **selectable element**
   * rather than a disclosure with a name on it.
   *
   * Its presence changes the header's interaction. Clicking anywhere on the
   * header **selects the group and toggles the fold** — closed becomes chosen
   * and open, open becomes chosen and shut — and the chevron folds the run
   * **without touching the selection**. The selection survives the fold in
   * either direction, so contracting says something about the disclosure and
   * nothing about the subject.
   *
   * Collapsing from the row is conditional on the group already being the
   * chosen one — see the handler.
   *
   * Absent, the header is simpler: the whole row toggles the fold where the
   * grouping accordions, and the chevron toggles it everywhere.
   */
  onGroupClick?: (key: string, rows: readonly T[]) => void;
  /**
   * A **query is live over this list**, so every group is open while it holds.
   *
   * The caller states its situation and the table decides what a table does
   * about it — the same split the rest of this component runs on. What it does
   * is open everything: a row matching the query, sitting inside a group the
   * reader folded ten minutes ago, is a match that reads as *no match*, and an
   * empty-looking search is the one failure a search may not have.
   *
   * It **sets the folding aside rather than rewriting it**. Neither `folded`
   * nor the accordion's `opened` is touched, so clearing the query returns the
   * list to exactly the shape the reader left it in. That extends to the
   * accordion: `expand`'s one-open-at-a-time is a browsing affordance, and a
   * live query suspends it rather than silently resetting it.
   */
  searching?: boolean;
}

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls sort last
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en-GB', { numeric: true, sensitivity: 'base' });
}

/**
 * The data table: client-sortable, groupable, with a stated empty state.
 *
 * **Rows are pills, and their height comes from what is in them.** The
 * treatment is `rows.module.css`, shared rather than restated here, so a second
 * list cannot come to look different from this one. There is no density flag: a
 * fixed row height is only ever compensation for another fixed height, and a
 * content-sized row needs neither.
 *
 * **A column's width comes from its content class** — identity, content or
 * controls — and never from equal division or from one column claiming the
 * table. The classes and the reasoning are in `Table.module.css`; which class a
 * column is in is `Column.identity` / `Column.controls` above.
 *
 * **The table sizes to its container at every width, and nothing here scrolls
 * or measures a box.** The fit is bought entirely in the stylesheet and there
 * is nothing to configure: the cells that can give ground break their content,
 * the identity column wraps rather than holding a column open at the width of
 * the longest name, and the one nowrap left is the controls column, which holds
 * a checkbox rather than data.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  defaultSort,
  selectedKey,
  staleKeys,
  quietKeys,
  onRowClick,
  grouping,
  selectedGroupKey,
  onGroupClick,
  searching = false,
}: TableProps<T>) {
  const [sort, setSort] = useState<TableSort | null>(defaultSort ?? null);
  // Which groups the *reader* has folded or unfolded, over whatever the
  // grouping said they start as. Keyed by the group key, which is stable across
  // a refetch, so new data does not close what somebody opened.
  const [folded, setFolded] = useState<Readonly<Record<string, boolean>>>({});
  // The accordion's one open group (`expand`). `undefined` means the reader has
  // not chosen yet and the grouping's initial state still stands; `null` means
  // they chose to have nothing open, which is a legitimate answer and the reason
  // this is not simply a string.
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  const t = useT();

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (column?.value === undefined) return rows;
    const valueOf = column.value;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => compareValues(valueOf(a), valueOf(b)) * factor);
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  };

  // Grouping is applied *after* sorting, over the sorted rows, so a column sort
  // reorders rows within their groups and — through first appearance — the
  // groups with them. See {@link groupRuns}.
  const runs: Run<T>[] =
    grouping === undefined
      ? sorted.map((row) => ({ kind: 'row', row }))
      : groupRuns(sorted, grouping);

  // Whether this table's groups are accordions rather than headings, and — if
  // they are — which one is open. The open group is *derived* while the reader
  // has not touched it, so a refetch or a column sort that changes which group
  // leads changes what is open with it; once they have chosen, their choice
  // stands.
  const accordion = grouping?.expand === true;
  const openGroup = !accordion
    ? undefined
    : opened !== undefined
      ? opened
      : grouping?.collapsed === true
        ? null
        : (runs.find((run) => run.kind === 'group')?.key ?? null);

  /**
   * One data row, drawn identically whether or not it sits under a header.
   *
   * `last` is the member's **position in its run**, and it exists for the tree
   * affordance alone: the rule down a run stops at its last member's branch, so
   * the elbow is drawn by the sheet and the one fact the sheet cannot work out
   * for itself is which member that is. Not `:last-child` — a `<tbody>` holds
   * every group's rows, so the last member of a run is only the last child of
   * anything when its group is the last on the page.
   */
  const drawRow = (row: T, member = false, last = false) => {
    const key = rowKey(row);
    const selected = selectedKey !== undefined && key === selectedKey;
    // See {@link TableProps.staleKeys}. `data-stale` as well as the class: the
    // class is how it is drawn and may be renamed by a stylesheet, the
    // attribute is what states the fact — and it is the one a test may assert
    // on.
    const stale = staleKeys?.has(key) === true;
    const quiet = quietKeys?.has(key) === true;
    return (
      <tr
        key={key}
        data-stale={stale ? 'true' : undefined}
        data-quiet={quiet ? 'true' : undefined}
        className={cx(
          styles.row,
          member && styles.member,
          stale && styles.stale,
          quiet && styles.quiet,
          // The disclosed run's own ground. A `<table>` has no element between
          // the body and a row, so "a container with a different background"
          // is one ground shared by the run — which is what the eye reads as a
          // container anyway.
          member && accordion && styles.expandMember,
          member && accordion && last && styles.expandLast,
          onRowClick !== undefined && styles.clickable,
          selected && styles.selected,
        )}
        aria-selected={selectedKey !== undefined ? selected : undefined}
        onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
      >
        {columns.map((column) => (
          <td
            key={column.key}
            className={cx(
              styles.td,
              column.align === 'right' && styles.right,
              column.identity === true && styles.grow,
              column.controls === true && styles.controls,
              column.prose === true && styles.prose,
            )}
          >
            {column.render !== undefined ? column.render(row) : (column.value?.(row) ?? null)}
          </td>
        ))}
      </tr>
    );
  };

  return (
    // One box, and it neither scrolls nor is measured. It is here for the
    // surface treatment — the inset the rows are drawn against — and for the
    // clip that states the table may not exceed it.
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortable = column.sortable === true && column.value !== undefined;
              const active = sort?.key === column.key;
              return (
                <th
                  key={column.key}
                  className={cx(
                    styles.th,
                    column.align === 'right' && styles.right,
                    column.identity === true && styles.grow,
                    column.controls === true && styles.controls,
                    // **On the header as well as the cell.** A header left out
                    // of its own column's rule is a floor the column cannot
                    // see: `.th` falls back to `overflow-wrap: normal`, so a
                    // two-word heading holds ~72px open over a column of
                    // five-character values, and a table with nothing left to
                    // give still overflows its box even though every cell in it
                    // has been marked.
                    column.prose === true && styles.prose,
                  )}
                  aria-sort={
                    sortable
                      ? active
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() => toggleSort(column.key)}
                    >
                      <span>{column.header}</span>
                      {active && (
                        <Icon name={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td className={styles.emptyCell} colSpan={columns.length}>
                <EmptyState title={empty ?? t('table.empty')} />
              </td>
            </tr>
          ) : (
            runs.map((run) =>
              run.kind === 'row'
                ? drawRow(run.row)
                : (() => {
                    const header = grouping!.header(run.key, run.rows);
                    // An accordion holds one open group; a heading-grouped
                    // table folds each on its own. `collapsed` means the
                    // starting position in both, but of one thing rather than
                    // of every thing.
                    //
                    // **A live query opens all of them.** The rows below are
                    // the answer to the query, so a folded group is hiding
                    // matches rather than clutter — see
                    // {@link TableProps.searching} for why the fold is set
                    // aside rather than rewritten.
                    const open =
                      searching ||
                      (accordion
                        ? openGroup === run.key
                        : (folded[run.key] ?? grouping!.collapsed !== true));
                    const toggle = () => {
                      if (accordion) {
                        setOpened(open ? null : run.key);
                        return;
                      }
                      setFolded((current) => ({ ...current, [run.key]: !open }));
                    };
                    const name =
                      header.label ?? (typeof header.title === 'string' ? header.title : run.key);
                    // **A press on the header both selects and folds.**
                    // Closed becomes chosen and open; open, if it was already
                    // the chosen one, becomes shut.
                    //
                    // **Selection survives the fold**, which is what keeps this
                    // from being a way to lose your subject: `choose` calls
                    // `onGroupClick` unconditionally, and `expandSelected` and
                    // `aria-selected` read `selectedGroup` rather than `open` —
                    // so a shut header goes on being the chosen one and the
                    // panel beside it goes on answering for it. Folding is a
                    // statement about the disclosure, not about the subject.
                    //
                    // **A live query suspends the fold and only the fold.**
                    // Every run is open while one holds, so folding here would
                    // either do nothing visible or fight the query for the
                    // state; the press selects and stops.
                    //
                    // Where no selection is offered the header is simpler: the
                    // whole row toggles where the grouping accordions (a hit
                    // area the size of a 14px chevron is not a selectable
                    // element), and nothing but the chevron toggles elsewhere.
                    //
                    // **What else on this row reaches this handler**, stated
                    // rather than assumed, because it now has two effects and
                    // anything that bubbles inherits both:
                    //   * the chevron — folds, never selects; it stops the
                    //     click below and is the one keyboard-reachable control;
                    //   * the glyph and the name — a **sibling** of the chevron
                    //     where a selection is offered, so they bubble to the
                    //     row and do both. Intended: the name is the subject;
                    //   * the count and any secondary text — plain spans, bubble
                    //     to the row, do both;
                    //   * `header.actions` — each stops the click at the button,
                    //     so a button on the header neither folds nor selects;
                    //   * a selection checkbox — **there is none on this row.**
                    //     The header draws one `<td colSpan={columns.length}>`,
                    //     so every column including a checkbox one is spanned
                    //     and nothing is rendered. A checkbox added here later
                    //     owes its own `stopPropagation` — the per-row ones
                    //     already carry it.
                    const selectedGroup =
                      selectedGroupKey !== undefined && run.key === selectedGroupKey;
                    // **Expanding is unconditional; collapsing is not** — a
                    // shut header opens on any press, an open one shuts only
                    // when it is already the chosen group.
                    //
                    // **The asymmetry is the feature and it reads as a bug**,
                    // which is why it is written out: a reader moving down a
                    // list opens each group as they reach it and never
                    // accidentally shuts the one they were reading. Shutting is
                    // a second, deliberate press on a header they have already
                    // chosen.
                    //
                    // Selection is still unconditional — `onGroupClick` runs on
                    // every press, before any of this.
                    const choose =
                      onGroupClick === undefined
                        ? undefined
                        : () => {
                            onGroupClick(run.key, run.rows);
                            if (searching) {
                              return;
                            }
                            if (!open || selectedGroup) {
                              toggle();
                            }
                          };
                    // The group's glyph and its name, which sit either inside
                    // the disclosure or beside it — see the button below.
                    //
                    // **The glyph grows where the group IS the row.** An
                    // accordion header is the subject and its members are its
                    // contents, so it draws a rung larger than they do. The
                    // stylesheet does the type and the padding; this is the one
                    // lever that has to be here, because `size` is a prop. `16`
                    // is `Icon`'s own default restated, so the ternary adds a
                    // value rather than replacing two — a heading-grouped table
                    // (`.groupRow`) is chrome above rows that are the subject
                    // and is deliberately left where it was.
                    //
                    // **The chevron is NOT grown with it, and that is a
                    // decision.** It stays at 14 below: it is the disclosure,
                    // not the subject, and a chevron scaled to match the name
                    // would put the loudest thing on the row on the control.
                    // It is also shared markup with the heading path, so
                    // growing it would need a second `accordion` ternary.
                    const groupLabel = (
                      <span className={styles.groupLabel}>
                        {header.icon !== undefined && (
                          <Icon name={header.icon} size={accordion ? 20 : 16} />
                        )}
                        <span className={styles.groupTitle}>{header.title}</span>
                      </span>
                    );
                    return (
                      <Fragment key={`group:${run.key}`}>
                        <tr
                          className={
                            accordion
                              ? cx(
                                  styles.expandRow,
                                  open && styles.expandOpen,
                                  selectedGroup && styles.expandSelected,
                                )
                              : styles.groupRow
                          }
                          // A selectable header answers *false* as well as
                          // true, unlike a row: a group is still one of the
                          // things this list offers while a member of it is the
                          // one chosen, and a reader who cannot see the rail
                          // needs the list to say which of the two it is.
                          aria-selected={onGroupClick !== undefined ? selectedGroup : undefined}
                          onClick={choose ?? (accordion && !searching ? toggle : undefined)}
                        >
                          <td
                            className={accordion ? styles.expandCell : styles.groupCell}
                            colSpan={columns.length}
                          >
                            <div className={styles.groupHeader}>
                              {/* The disclosure, and nothing else, is the
                                  button: a control nested inside a control is
                                  one the keyboard cannot reach on its own. It
                                  stays a button when the whole row is
                                  clickable, because a `<tr>` is not something
                                  the keyboard can reach at all — so the chevron
                                  is the header's one keyboard-reachable control
                                  whether or not the row selects.

                                  **The name is inside it only where the header
                                  does not select.** Where it does, a click on
                                  the name must choose the group rather than
                                  fold it, and a name inside the disclosure
                                  cannot do that. Where it does not, the name is
                                  the disclosure's hit area exactly as it was,
                                  which is what keeps a grouped table that asked
                                  for none of this unchanged. */}
                              <button
                                type="button"
                                className={styles.disclosure}
                                // **Disabled while a query is live, never
                                // silently ignored.** A control whose press
                                // does nothing reads as a broken page, and one
                                // that records a fold nobody can see take
                                // effect is worse. The fold itself is untouched
                                // and comes back when the query clears.
                                disabled={searching}
                                aria-expanded={open}
                                aria-label={t(
                                  open ? 'table.group.collapse' : 'table.group.expand',
                                  {
                                    group: name,
                                  },
                                )}
                                onClick={(event) => {
                                  // Or the row handler above would take the
                                  // click as well — folding it straight back
                                  // where the row toggles, and selecting the
                                  // group where it chooses. The chevron is the
                                  // fold and only the fold.
                                  event.stopPropagation();
                                  toggle();
                                }}
                              >
                                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                                {choose === undefined && groupLabel}
                              </button>
                              {choose !== undefined && groupLabel}
                              {header.secondary !== undefined && (
                                <span className={styles.groupSecondary}>{header.secondary}</span>
                              )}
                              {/* The count is on the header because a folded
                                  group has to say how much it is hiding. A run
                                  of one normally flattens to a row, but
                                  `flattenSingletons: false` keeps its header —
                                  so the singular has to exist or that header
                                  reads "1 entries". The catalogue has no plural
                                  machinery, so the words stay in it and only the
                                  choice between them is here. */}
                              <span className={styles.groupCount}>
                                {t(
                                  run.rows.length === 1
                                    ? 'table.group.member'
                                    : 'table.group.members',
                                  { count: String(run.rows.length) },
                                )}
                              </span>
                              {header.actions !== undefined && (
                                <span className={styles.groupActions}>{header.actions}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        {open &&
                          run.rows.map((row, index) =>
                            drawRow(row, true, index === run.rows.length - 1),
                          )}
                      </Fragment>
                    );
                  })(),
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
