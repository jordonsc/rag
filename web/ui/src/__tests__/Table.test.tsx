import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, type Column } from '../components/Table';
import {
  componentCss,
  declarations,
  minWidthFloorPx,
  tableStylesheets,
  uiFile,
  type Declaration,
} from './cssRules';

interface TopicRow {
  id: string;
  title: string;
  events: number;
}

const columns: Column<TopicRow>[] = [
  { key: 'title', header: 'Title', value: (row) => row.title, sortable: true },
  { key: 'events', header: 'Events', value: (row) => row.events, sortable: true, align: 'right' },
];

const rows: TopicRow[] = [
  { id: 'chunking', title: 'Chunk size', events: 12 },
  { id: 'archive', title: 'Archive policy', events: 3 },
  { id: 'weights', title: 'Weighting', events: 7 },
];

function firstCellTexts(): string[] {
  const [, ...bodyRows] = screen.getAllByRole('row');
  return bodyRows.map((row) => within(row).getAllByRole('cell')[0]!.textContent ?? '');
}

describe('Table', () => {
  it('renders rows unsorted by default', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(firstCellTexts()).toEqual(['Chunk size', 'Archive policy', 'Weighting']);
  });

  it('sorts ascending on first header click, descending on the second', async () => {
    const user = userEvent.setup();
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} />);

    await user.click(screen.getByRole('button', { name: 'Title' }));
    expect(firstCellTexts()).toEqual(['Archive policy', 'Chunk size', 'Weighting']);
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: 'Title' }));
    expect(firstCellTexts()).toEqual(['Weighting', 'Chunk size', 'Archive policy']);
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts numeric columns numerically', async () => {
    const user = userEvent.setup();
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} />);
    await user.click(screen.getByRole('button', { name: 'Events' }));
    expect(firstCellTexts()).toEqual(['Archive policy', 'Weighting', 'Chunk size']);
  });

  it('honours defaultSort', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        defaultSort={{ key: 'events', dir: 'desc' }}
      />,
    );
    expect(firstCellTexts()).toEqual(['Chunk size', 'Weighting', 'Archive policy']);
  });

  it('states the default empty message from the catalogue', () => {
    render(<Table columns={columns} rows={[]} rowKey={(row) => row.id} />);
    expect(screen.getByText('No entries')).toBeInTheDocument();
  });

  it('renders a custom empty state', () => {
    render(
      <Table columns={columns} rows={[]} rowKey={(row) => row.id} empty="Nothing recorded yet" />,
    );
    expect(screen.getByText('Nothing recorded yet')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Column widths: a column's share comes from its content class
// ---------------------------------------------------------------------------

/**
 * Every declaration the stylesheet applies to `element` through its own
 * classes, flattened into one string.
 *
 * jsdom has no layout engine, so nothing below claims a pixel — the pixels need
 * an eye on real glass and that is said here rather than pretended. What is
 * asserted is the **rule applied**, which is the thing that decides the pixels,
 * and it is a real assertion: it fails the moment anybody gives a column back
 * the `width: 100%` that starves its siblings.
 */
function declarationsFor(element: Element): string {
  const own = Array.from(element.classList).map((name) => `.${name}`);
  const found: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A sheet jsdom will not let us read is not one we injected.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText.split(',').some((selector) => own.includes(selector.trim()))
      ) {
        found.push(rule.style.cssText);
      }
    }
  }
  return found.join(' ');
}

/** The shape the rule has to survive: a low-cardinality identity column, a
 *  long-sentence content column, and a cell of two long-labelled buttons. Given
 *  `width: 100%` the identity claims the table and the other two collapse to
 *  their min-content width. */
interface WidthRow {
  id: string;
  kind: string;
  detail: string;
}

const scanColumns: Column<WidthRow>[] = [
  { key: 'kind', header: 'Kind', identity: true, value: (row) => row.kind },
  { key: 'detail', header: 'Detail', value: (row) => row.detail },
  {
    key: '__row_actions',
    header: '',
    controls: true,
    render: () => (
      <span>
        <button type="button">Open this topic</button>
        <button type="button">Copy the topic id</button>
      </span>
    ),
  },
];

const scanRows: WidthRow[] = [
  {
    id: 'rag-0042',
    kind: 'Investigation',
    detail: 'The reranker went on returning stale hits for three days after the index was rebuilt',
  },
];

describe('column width is apportioned by content class', () => {
  function cells() {
    render(<Table columns={scanColumns} rows={scanRows} rowKey={(row) => row.id} />);
    const [headerRow, bodyRow] = screen.getAllByRole('row');
    return {
      headers: within(headerRow!).getAllByRole('columnheader'),
      body: within(bodyRow!).getAllByRole('cell'),
    };
  }

  it('gives the identity column a floor rather than the whole table', () => {
    const { headers, body } = cells();

    // The class still marks which column gives ground.
    expect(body[0]).toHaveClass('grow');
    expect(headers[0]).toHaveClass('grow');

    // What changed is what the class *says*. `width: 100%` on the identity
    // column is the whole of the defect: in an auto-layout table it starves
    // every sibling down to its min-content width. A floor asks for a share
    // instead of taking the lot.
    expect(declarationsFor(body[0]!)).not.toContain('width: 100%');
    expect(declarationsFor(headers[0]!)).not.toContain('width: 100%');
    // The floor is 6rem — a `min-width` is the one width auto layout may not
    // shrink, so every rem of it is a rem the table can be forced to overflow
    // by. It is still a floor and still not a claim.
    expect(declarationsFor(body[0]!)).toContain('min-width: 6rem');

    // And `max-width: 0`, the companion hack that made the cell narrow enough
    // for `text-overflow` to fire, goes with it: the ellipsis now comes from
    // the column being at its floor.
    expect(declarationsFor(body[0]!)).not.toContain('max-width: 0');
  });

  it('sizes the controls column to its buttons and forbids it wrapping', () => {
    const { headers, body } = cells();
    const controls = body[2]!;

    expect(controls).toHaveClass('controls');
    expect(headers[2]).toHaveClass('controls');

    // The shrink-to-fit idiom for an auto-layout table, and the reason the
    // labels stop overflowing vertically inside their buttons.
    const declared = declarationsFor(controls);
    expect(declared).toContain('width: 1%');
    expect(declared).toContain('white-space: nowrap');
  });

  it('leaves a content column to auto layout, claiming nothing', () => {
    const { body } = cells();
    const detail = body[1]!;

    // A content column is the class with no *width* class: it is neither the
    // identity nor a control, so nothing overrides what auto layout would do
    // with it.
    expect(detail).not.toHaveClass('grow');
    expect(detail).not.toHaveClass('controls');

    const declared = declarationsFor(detail);
    expect(declared).not.toContain('width: 1%');
    expect(declared).not.toContain('white-space: nowrap');
  });

  it('lets a prose column give ground, and only a prose column', () => {
    // `overflow-wrap: anywhere` on *every* content cell is one property
    // answering two questions — *how much width does this column ask for* and
    // *may a word in it be severed*. Severing is the only way a column's
    // min-content falls below its longest word, so `anywhere` everywhere lets
    // auto layout squeeze a column of three-letter words to the width of one
    // letter (`Table.module.css` § *the whole of the fit*).
    const { body } = cells();

    // The paired positive control: the same fixture, the same assertion,
    // differing only in the flag under test. Without it the negative below is
    // cleared by a cell that has no class at all — which is the state this case
    // exists to forbid.
    render(
      <Table
        columns={[
          ...scanColumns.map((column) =>
            column.key === 'detail' ? { ...column, prose: true } : column,
          ),
          // A fourth column, and it is what makes the negative below a witness:
          // `scanColumns` is identity + prose + controls, so without it every
          // "not prose" assertion lands on a cell that already carries `.grow`
          // or `.controls` and proves nothing about an ordinary one.
          { key: 'status', header: 'Status', value: () => 'open' },
        ]}
        rows={scanRows}
        rowKey={(row) => row.id}
      />,
    );
    const proseHeaderRow = screen.getAllByRole('row')[2]!;
    const prose = within(screen.getAllByRole('row')[3]!).getAllByRole('cell')[1]!;
    expect(prose).toHaveClass('prose');
    expect(declarationsFor(prose)).toContain('overflow-wrap: anywhere');

    // **The header is marked too.** A header inset from its own column's rule
    // is a floor the column cannot see: `.th` otherwise falls back to
    // `overflow-wrap: normal`, and a long header holds its column open over a
    // column of short values — enough that a table with nothing left to give
    // still overflows its box after every cell in it has been marked. Read off
    // the *marked* render rather than the unmarked one, because a table with no
    // prose column clears either assertion without proving anything.
    expect(within(proseHeaderRow).getAllByRole('columnheader')[1]).toHaveClass('prose');
    // And the ordinary content column beside it keeps its header's words
    // whole: a header *wraps* rather than nowrapping, and is severed only where
    // its column gives ground.
    const plainHeader = within(proseHeaderRow).getAllByRole('columnheader')[3]!;
    expect(plainHeader).toHaveTextContent('Status');
    expect(plainHeader).not.toHaveClass('prose');
    expect(plainHeader).not.toHaveClass('grow');
    expect(declarationsFor(plainHeader)).not.toContain('overflow-wrap: anywhere');

    // And the negative: an ordinary content column keeps its words whole, so
    // its floor is its longest word rather than its widest character.
    expect(body[1]).not.toHaveClass('prose');
    expect(declarationsFor(body[1]!)).not.toContain('overflow-wrap: anywhere');
  });

  it('lets no cell in the table claim the whole of it', () => {
    // The guard that outlives the three cases above: whatever columns a future
    // page declares, none of them may go back to claiming the table.
    render(<Table columns={scanColumns} rows={scanRows} rowKey={(row) => row.id} />);
    for (const cell of screen.getAllByRole('cell')) {
      expect(declarationsFor(cell)).not.toContain('width: 100%');
    }
  });
});

// One level of grouping, so a flat list can be read as the things it is made
// of. Everything asserted here is *which rows are drawn* and what the header
// says — jsdom has no layout engine, so the indentation and the rule under the
// header are for a real browser.
describe('grouped rows', () => {
  interface HitRow {
    id: string;
    title: string;
    repo: string;
    repoName: string;
  }

  const hitColumns: Column<HitRow>[] = [
    { key: 'title', header: 'Topic', value: (row) => row.title, sortable: true },
  ];

  // Two topics from one repository, one from another, and one belonging to no
  // repository at all — which is the case the empty key exists for.
  const hits: HitRow[] = [
    { id: 'size', title: 'Chunk size', repo: 'repo:rag', repoName: 'rag' },
    { id: 'overlap', title: 'Chunk overlap', repo: 'repo:rag', repoName: 'rag' },
    { id: 'trigger', title: 'Reindex trigger', repo: 'repo:wiki', repoName: 'wiki' },
    { id: 'budget', title: 'Query budget', repo: '', repoName: '' },
  ];

  const grouping = (overrides: Record<string, unknown> = {}) => ({
    keyOf: (row: HitRow) => (row.repo === '' ? undefined : row.repo),
    header: (_key: string, members: readonly HitRow[]) => ({
      title: members[0]!.repoName,
      secondary: 'indexed today',
    }),
    ...overrides,
  });

  function drawn(): string[] {
    const [, ...bodyRows] = screen.getAllByRole('row');
    return bodyRows.map((row) => row.textContent ?? '');
  }

  it('draws a header per group, in first-appearance order, and its members under it', () => {
    render(
      <Table columns={hitColumns} rows={hits} rowKey={(row) => row.id} grouping={grouping()} />,
    );
    // The header, its two members, then the ungrouped row. The lone repository
    // is flattened — a group of one is a row.
    expect(drawn()).toEqual([
      expect.stringContaining('rag'),
      'Chunk size',
      'Chunk overlap',
      'Reindex trigger',
      'Query budget',
    ]);
    // How much the group holds, which is the fact a folded one owes its reader.
    expect(screen.getByText('2 entries')).toBeInTheDocument();
    expect(screen.getByText('indexed today')).toBeInTheDocument();
  });

  it('a collapsed group draws its title and no rows, and expands to exactly its members', async () => {
    const user = userEvent.setup();
    render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={grouping({ collapsed: true })}
      />,
    );
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();
    expect(screen.queryByText('Chunk overlap')).not.toBeInTheDocument();
    // And the rows that are not in it are unaffected: folding is per group.
    expect(screen.getByText('Reindex trigger')).toBeInTheDocument();

    const disclosure = screen.getByRole('button', { name: 'Show rag' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await user.click(disclosure);
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.getByText('Chunk overlap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide rag' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('draws a group of one as a header when the declaration says not to flatten', () => {
    render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={grouping({ flattenSingletons: false })}
      />,
    );
    expect(drawn()).toEqual([
      expect.stringContaining('rag'),
      'Chunk size',
      'Chunk overlap',
      expect.stringContaining('wiki'),
      'Reindex trigger',
      'Query budget',
    ]);
  });

  /*
   * A header that says how much it hides has to say it in English. The
   * unflattened run of one is the *only* way a header ever sees a count of one
   * — `flattenSingletons` defaults to true and turns the rest into plain rows —
   * so "1 entries" is a defect that survives easily on a shared primitive.
   *
   * The count is read off the rendered header rather than out of the
   * catalogue, so what is under test is the table's own choice of key.
   */
  it('says “1 entry” for an unflattened group of one, and “entries” otherwise', () => {
    render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={grouping({ flattenSingletons: false })}
      />,
    );
    expect(screen.getByText('1 entry')).toBeInTheDocument();
    // The other group holds two, and must be unaffected: an inverted predicate
    // (`!== 1`) satisfies neither of these two lines, which is what says they
    // are not one assertion written twice. `<= 1` is *not* a mutation this can
    // see, and deliberately so — a run is emitted from its members, so a group
    // of zero cannot exist and the two predicates are the same function.
    expect(screen.getByText('2 entries')).toBeInTheDocument();
    expect(screen.queryByText('1 entries')).not.toBeInTheDocument();
  });

  it('sorts within a group and takes the group order from the sorted rows', async () => {
    const user = userEvent.setup();
    render(
      <Table columns={hitColumns} rows={hits} rowKey={(row) => row.id} grouping={grouping()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Topic' }));
    // Alphabetically *Chunk overlap* sorts first, so its group leads and the
    // rows that belong to no group fall where their own titles put them. The
    // table never re-sorts groups by anything of its own: this is first
    // appearance over the rows *as sorted*.
    expect(drawn()).toEqual([
      expect.stringContaining('rag'),
      'Chunk overlap',
      'Chunk size',
      'Query budget',
      'Reindex trigger',
    ]);
  });

  it('draws every row plainly when nothing is grouped', () => {
    render(<Table columns={hitColumns} rows={hits} rowKey={(row) => row.id} />);
    expect(drawn()).toEqual(['Chunk size', 'Chunk overlap', 'Reindex trigger', 'Query budget']);
  });
});

// ---------------------------------------------------------------------------
// The accordion group
// ---------------------------------------------------------------------------

/*
 * Grouping is ordinarily a *heading* above rows that are themselves the
 * selectable things. With `expand` it is turned inside out: **the header is the
 * row** — it wears the shared row treatment, it is what the reader selects, and
 * its members are what the selection discloses.
 *
 * It is opt-in, because a table that groups is not necessarily a table that
 * accordions: a list whose every group is worth reading at once is made worse
 * by folding it to one. `expand` says which, and the last case here is the
 * regression guard for the tables that did not ask.
 *
 * jsdom has no layout engine, so nothing here claims a pixel. What is asserted
 * is which rows are drawn, and which *rule* is applied — the thing that decides
 * the pixels, and a real assertion because it fails the moment the treatment is
 * dropped.
 */
describe('an expandable group is the row', () => {
  interface HitRow {
    id: string;
    title: string;
    repo: string;
    repoName: string;
  }

  const hitColumns: Column<HitRow>[] = [
    { key: 'title', header: 'Topic', value: (row) => row.title, sortable: true },
  ];

  // Two repositories with two topics each, and one repository holding a single
  // topic — the case `flattenSingletons` decides, and it stays flat.
  const hits: HitRow[] = [
    { id: 'size', title: 'Chunk size', repo: 'repo:rag', repoName: 'rag' },
    { id: 'overlap', title: 'Chunk overlap', repo: 'repo:rag', repoName: 'rag' },
    { id: 'sync', title: 'Wiki sync', repo: 'repo:wiki', repoName: 'wiki' },
    { id: 'backlinks', title: 'Wiki backlinks', repo: 'repo:wiki', repoName: 'wiki' },
    { id: 'cache', title: 'Prompt cache', repo: 'repo:barry', repoName: 'barry' },
  ];

  const grouping = (overrides: Record<string, unknown> = {}) => ({
    keyOf: (row: HitRow) => (row.repo === '' ? undefined : row.repo),
    header: (_key: string, members: readonly HitRow[]) => ({
      title: members[0]!.repoName,
    }),
    expand: true,
    ...overrides,
  });

  function drawExpandable(overrides: Record<string, unknown> = {}) {
    return render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={grouping(overrides)}
      />,
    );
  }

  /** The `<tr>` carrying a group header, found by its disclosure control. */
  function headerRow(name: string): HTMLElement {
    const button = screen.getByRole('button', { name: new RegExp(`${name}$`) });
    return button.closest('tr')!;
  }

  it('opens exactly one group at a time, closing the last', async () => {
    const user = userEvent.setup();
    drawExpandable();

    // `collapsed` is the *initial state* here, not a per-group toggle: the
    // caller did not ask for a closed list, so the first group is open and —
    // this is the whole of the accordion — it is the only one.
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.queryByText('Wiki backlinks')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show wiki' }));
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();
    // The one that was open is now shut. Under per-group folding both would be
    // open, which is what the accordion exists not to do.
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();

    // And pressing the open one shuts it: an accordion may hold nothing open.
    await user.click(screen.getByRole('button', { name: 'Hide wiki' }));
    expect(screen.queryByText('Wiki backlinks')).not.toBeInTheDocument();
  });

  it('opens nothing at all when the declaration says collapsed', () => {
    drawExpandable({ collapsed: true });
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();
    expect(screen.queryByText('Wiki backlinks')).not.toBeInTheDocument();
    // The headers are all still there — a collapsed accordion is a list of
    // groups, which is a legitimate way to read the table.
    expect(screen.getByText('rag')).toBeInTheDocument();
    expect(screen.getByText('wiki')).toBeInTheDocument();
  });

  it('gives the header the row treatment, and the open run its own ground', () => {
    drawExpandable();
    const open = headerRow('rag');
    const shut = headerRow('wiki');

    // The shared row treatment (`rows.module.css`), composed rather than
    // restated: a header that hand-rolled its own hover is how two lists come
    // to look different for no reason.
    expect(open).toHaveClass('pillRow');
    expect(open).toHaveClass('clickable');
    expect(shut).toHaveClass('pillRow');

    expect(open).toHaveClass('expandOpen');
    expect(shut).not.toHaveClass('expandOpen');

    // **Open is not *selected*.** A header can be chosen as well as opened, so
    // the accent rail says which of the things on this list the panel beside it
    // is about, and an open run that nobody chose keeps only the tint. The case
    // below is where the rail is asserted.
    expect(open).not.toHaveClass('pillSelected');
    expect(shut).not.toHaveClass('pillSelected');
    expect(
      declarations(componentCss('Table.module.css')).find(
        (rule) => rule.selector === '.expandOpen .expandCell' && rule.property === 'background',
      )?.value,
      'an open run gives up the rail and keeps the tint',
    ).toBe('var(--rag-surface2)');

    // And the heading chrome it stopped being: no hairline under a pill.
    expect(open.querySelector('td')).not.toHaveClass('groupCell');
  });

  it('draws the header row larger than its members, and only where the group is the row', () => {
    const sheet = declarations(componentCss('Table.module.css'));
    const rule = (selector: string, property: string) =>
      sheet
        .filter((entry) => entry.selector === selector && entry.property === property)
        .map((entry) => entry.value);

    // The group is the subject, so its row draws like one: block padding for
    // the height and the next rung of the shared type scale for the name. The
    // glyph is a prop and has the case below.
    expect(rule('.expandRow .expandCell', 'padding-block')).toEqual(['var(--rag-space-3)']);
    expect(rule('.expandRow .groupTitle', 'font-size')).toEqual(['var(--rag-text-l)']);

    // **And not with a height**, which is this sheet's standing rule. Asserted
    // here as well as in its own case so that a later attempt to make this row
    // taller fails beside the reason rather than three describes away.
    expect(sheet.filter((entry) => entry.property === 'height')).toEqual([]);

    // **The positive control, and it is the half that decays.** `.groupTitle`
    // is shared with the heading-grouped path and `.groupCell` is that path's
    // own — so a rule written one class wider would silently move a construct
    // that is a *caption above* rows rather than a row. If any of these three
    // ever answers, the two assertions above have stopped being about
    // accordion headers and nothing else would say so.
    expect(rule('.groupRow', 'padding-block')).toEqual([]);
    expect(rule('.groupCell', 'padding-block')).toEqual([]);
    expect(rule('.groupTitle', 'font-size')).toEqual(['var(--rag-text-m)']);
  });

  it('grows the header glyph with the row, and only where the group is the row', () => {
    const iconHeader = (expand: boolean) =>
      drawExpandable({
        expand,
        header: (_key: string, members: readonly HitRow[]) => ({
          title: members[0]!.repoName,
          icon: 'file-text',
        }),
      }).container;

    // 20 against `Icon`'s own default of 16, which is the rung the name takes
    // too — so the glyph grows with the name rather than the name growing away
    // from it. The chevron deliberately does not: it is the disclosure, not the
    // subject, and it is asserted nowhere here because it is a constant.
    expect(iconHeader(true).querySelector('[data-icon="file-text"] svg')).toHaveAttribute(
      'width',
      '20',
    );

    // **The paired control**: the same table, the same header, differing in
    // `expand` and in nothing else. A heading-grouped table asked for none of
    // this. This is also the assertion that fails if the ternary is ever
    // flattened back to a constant — in either direction.
    expect(iconHeader(false).querySelector('[data-icon="file-text"] svg')).toHaveAttribute(
      'width',
      '16',
    );
  });

  it('selects the header from anywhere on the row, not just the chevron', async () => {
    const user = userEvent.setup();
    drawExpandable();

    // The group *is* the selectable element. A hit area the size of a 14px
    // chevron is not that.
    await user.click(headerRow('wiki'));
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();
  });

  it('grounds the disclosed members distinctly from the rows around them', () => {
    drawExpandable();
    const members = screen
      .getAllByRole('row')
      .filter((row) => row.classList.contains('expandMember'));

    // The two members of the open group, and nothing else: a flattened
    // singleton is an ordinary row and must not be painted as a disclosure.
    expect(members.map((row) => row.textContent)).toEqual(['Chunk size', 'Chunk overlap']);
    expect(screen.getByText('Prompt cache').closest('tr')).not.toHaveClass('expandMember');

    // A `<table>` has no element between the body and a row, so "a container
    // with a different background" is one ground shared by the run — which is
    // what the eye reads as a container anyway.
    expect(
      declarations(componentCss('Table.module.css')).find(
        (rule) => rule.selector === 'tr.expandMember .td' && rule.property === 'background',
      )?.value,
    ).toBe('var(--rag-surface2)');
  });

  it('still flattens a group of one, because a header hiding one row buys nothing', () => {
    drawExpandable();
    // `barry` holds one topic, so there is no header to open and the topic is
    // simply a row.
    expect(screen.queryByRole('button', { name: /barry/ })).not.toBeInTheDocument();
    expect(screen.getByText('Prompt cache')).toBeInTheDocument();
  });

  it('changes nothing for a table that did not ask for it', async () => {
    const user = userEvent.setup();
    render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={grouping({ expand: undefined })}
      />,
    );

    // The regression guard for a table that groups without accordioning: every
    // group open, each folding on its own, and the header still a heading
    // rather than a pill.
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();
    expect(headerRow('rag')).not.toHaveClass('pillRow');
    expect(headerRow('rag')).not.toHaveClass('clickable');

    await user.click(screen.getByRole('button', { name: 'Hide rag' }));
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();
    // Folding one leaves the other alone — the property single-open replaces.
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();
  });
});

/**
 * **A group header is a subject.**
 *
 * A header can have a detail view of its own, and a detail view needs something
 * to be *chosen* rather than merely open. The cases below are about that split:
 * the accent rail means "this is what the panel beside the list is about", not
 * "this is open".
 *
 * The header carries **two verbs on one press** — it selects and it toggles —
 * and the chevron carries one. They do not compete, because the selection is
 * untouched by the fold rather than because the row declines to fold.
 */
describe('a group header that can be chosen', () => {
  interface HitRow {
    id: string;
    title: string;
    repo: string;
    repoName: string;
  }

  const hitColumns: Column<HitRow>[] = [
    { key: 'title', header: 'Topic', value: (row) => row.title, sortable: true },
  ];

  const hits: HitRow[] = [
    { id: 'size', title: 'Chunk size', repo: 'repo:rag', repoName: 'rag' },
    { id: 'overlap', title: 'Chunk overlap', repo: 'repo:rag', repoName: 'rag' },
    { id: 'sync', title: 'Wiki sync', repo: 'repo:wiki', repoName: 'wiki' },
    { id: 'backlinks', title: 'Wiki backlinks', repo: 'repo:wiki', repoName: 'wiki' },
    { id: 'search', title: 'Wiki search', repo: 'repo:wiki', repoName: 'wiki' },
  ];

  function drawChoosable(selectedGroupKey?: string) {
    const chosen = vi.fn();
    const view = render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={{
          keyOf: (row: HitRow) => (row.repo === '' ? undefined : row.repo),
          header: (_key: string, members: readonly HitRow[]) => ({
            title: members[0]!.repoName,
          }),
          expand: true,
        }}
        selectedGroupKey={selectedGroupKey}
        onGroupClick={chosen}
      />,
    );
    return { chosen, view };
  }

  function headerRow(name: string): HTMLElement {
    return screen.getByRole('button', { name: new RegExp(`${name}$`) }).closest('tr')!;
  }

  it('chooses the group from anywhere on the header, and opens it in the same press', async () => {
    const user = userEvent.setup();
    const { chosen } = drawChoosable();

    // `wiki` is shut: the accordion opened the first group and this is the
    // second.
    expect(screen.queryByText('Wiki backlinks')).not.toBeInTheDocument();

    await user.click(headerRow('wiki'));

    // The group, and its rows in order — `detail` binds against the first of
    // them, so the caller is handed the run rather than only its key.
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(chosen.mock.calls[0]![0]).toBe('repo:wiki');
    expect((chosen.mock.calls[0]![1] as HitRow[]).map((row) => row.id)).toEqual([
      'sync',
      'backlinks',
      'search',
    ]);
    // The press toggles as well as selects, and this run was shut, so it
    // opens: a chosen group whose members are hidden is a subject with its
    // contents shut.
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();
  });

  it('contracts an open header only once it is the chosen one', async () => {
    const user = userEvent.setup();
    const { chosen } = drawChoosable('repo:wiki');

    // **The positive control, and it goes first.** `wiki` is shut — the
    // accordion opened the first group and this is the second. Opening is
    // unconditional, and this press both chooses and opens.
    await user.click(headerRow('wiki'));
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();

    // And now it is open **and chosen**, so the same press shuts it. The rule
    // is deliberately asymmetric — see the case below for why contraction is
    // conditional on the header being the chosen one and expansion is not.
    await user.click(headerRow('wiki'));
    expect(chosen).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Wiki backlinks')).not.toBeInTheDocument();
  });

  it('does not contract an open header the reader has not chosen', async () => {
    const user = userEvent.setup();
    const { chosen } = drawChoosable('repo:wiki');

    // **The asymmetry, and it is deliberate.** `rag` is open — the accordion
    // opened it — and `wiki` is the chosen one. Pressing `rag` chooses it and
    // leaves it open: a reader moving down a list opens each group as they
    // reach it and must never accidentally shut one they were reading.
    expect(headerRow('rag')).toHaveClass('expandOpen');
    expect(headerRow('rag')).not.toHaveClass('expandSelected');

    await user.click(headerRow('rag'));
    expect(chosen).toHaveBeenCalledWith('repo:rag', expect.anything());
    expect(
      screen.getByText('Chunk size'),
      'an open header the reader had not chosen shut on the press that chose it',
    ).toBeInTheDocument();

    // **The paired control is the case below**, not a second press here:
    // `selectedGroupKey` is a prop this harness holds still, so the header
    // never becomes the chosen one however many times it is pressed.
    // `keeps a contracted header chosen` renders the same header **already**
    // chosen and asserts it contracts — which is what stops this case being
    // satisfiable by a header that cannot contract from the row at all.
  });

  it('keeps a contracted header chosen, because folding says nothing about the subject', async () => {
    const user = userEvent.setup();
    const { chosen } = drawChoosable('repo:rag');

    // `rag` is both the open one and the chosen one — the single state in
    // which a press certainly contracts, and therefore the one where the
    // *subject* half is worth asserting on its own.
    expect(headerRow('rag')).toHaveClass('expandOpen');

    await user.click(headerRow('rag'));

    expect(chosen).toHaveBeenCalledWith('repo:rag', expect.anything());
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();

    // The subject is untouched, which is the whole reason contracting from the
    // row is safe: the detail panel beside the list goes on answering for this
    // group and the rail goes on marking it.
    expect(headerRow('rag')).toHaveAttribute('aria-selected', 'true');
    expect(headerRow('rag')).toHaveClass('expandSelected');
  });

  it('selects without folding while a query is live, and does not spend the accordion’s position', async () => {
    // **The one branch of `choose` nothing else reaches.** `if (searching)
    // return;` sits between the selection and the fold: every other header case
    // renders with no query, and the query cases below declare no
    // `onGroupClick`, so `choose` is `undefined` there and the row handler is
    // the plain `toggle`. Between them the two populations never meet, and
    // deleting this early return passes every other case in the file.
    //
    // What it costs is not visible while the query holds — every run is open
    // regardless — so the far end has to be read after the query clears:
    // `toggle()` on a run the query has forced open calls `setOpened(null)`,
    // which means *the reader chose to have nothing open*, and the accordion
    // comes back from the search with every group shut.
    const user = userEvent.setup();
    const chosen = vi.fn();
    const draw = (searching: boolean) => (
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={{
          keyOf: (row: HitRow) => (row.repo === '' ? undefined : row.repo),
          header: (_key: string, members: readonly HitRow[]) => ({
            title: members[0]!.repoName,
          }),
          expand: true,
        }}
        selectedGroupKey="repo:rag"
        onGroupClick={chosen}
        searching={searching}
      />
    );

    // **The positive control, and it goes first**: the same header, the same
    // press, differing from the case below in `searching` and in nothing else.
    // Quiet, it folds. Without this line the assertions below would go on
    // passing against a header whose press had stopped folding for some
    // entirely different reason.
    const quiet = render(draw(false));
    await user.click(headerRow('rag'));
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();
    quiet.unmount();
    chosen.mockClear();

    const { rerender } = render(draw(true));
    // The query opens every run, which is why nothing here can be read off the
    // members while it holds.
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.getByText('Wiki backlinks')).toBeInTheDocument();

    await user.click(headerRow('wiki'));
    expect(chosen).toHaveBeenCalledWith('repo:wiki', expect.anything());

    // The far end: the query clears, and the accordion is exactly where the
    // caller left it — the first group open, the rest shut. A press that wrote
    // a fold through the query would have left nothing open at all.
    rerender(draw(false));
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.queryByText('Wiki backlinks')).not.toBeInTheDocument();
  });

  it('folds from the chevron without moving the selection', async () => {
    const user = userEvent.setup();
    const { chosen } = drawChoosable('repo:rag');

    await user.click(screen.getByRole('button', { name: 'Hide rag' }));

    // The run is shut and nothing was chosen: the chevron is the fold and only
    // the fold, which is what lets a reader look inside a second group without
    // changing what the panel beside the list is about.
    expect(screen.queryByText('Chunk size')).not.toBeInTheDocument();
    expect(chosen).not.toHaveBeenCalled();

    // And the header it belongs to is still the chosen one.
    expect(headerRow('rag')).toHaveAttribute('aria-selected', 'true');
  });

  it('marks the chosen header the way a chosen row is marked, and says so twice', () => {
    drawChoosable('repo:wiki');
    const chosenHeader = headerRow('wiki');
    const other = headerRow('rag');

    // The rail and the tint an ordinary row takes when its detail is open
    // beside it. The rail is what stays legible where `--rag-surface2` sits a
    // hair from `--rag-surface`.
    expect(chosenHeader).toHaveClass('expandSelected');
    expect(chosenHeader).toHaveClass('pillSelected');
    expect(chosenHeader).toHaveAttribute('aria-selected', 'true');

    // **The positive control, and it is the half that decays.** `rag` is the
    // *open* group and is not the chosen one — so if the mark ever went back to
    // meaning "open", this line fails by name instead of the line above quietly
    // proving nothing.
    expect(other).toHaveClass('expandOpen');
    expect(other).not.toHaveClass('pillSelected');
    // A header that is selectable answers `false` rather than nothing: a group
    // is still one of the things this list offers while a member of it is what
    // was chosen.
    expect(other).toHaveAttribute('aria-selected', 'false');
  });

  it('says nothing about selection where a header cannot be chosen', () => {
    render(
      <Table
        columns={hitColumns}
        rows={hits}
        rowKey={(row) => row.id}
        grouping={{
          keyOf: (row: HitRow) => (row.repo === '' ? undefined : row.repo),
          header: (_key: string, members: readonly HitRow[]) => ({
            title: members[0]!.repoName,
          }),
          expand: true,
        }}
      />,
    );
    // `aria-selected="false"` on a header nothing can select would announce a
    // choice the reader does not have.
    expect(headerRow('rag')).not.toHaveAttribute('aria-selected');
    // And the name is back inside the disclosure, where it is the fold's hit
    // area exactly as it was.
    expect(
      within(screen.getByRole('button', { name: 'Hide rag' })).getByText('rag'),
    ).toBeInTheDocument();
  });

  it('puts the name beside the disclosure, not inside it, once the header selects', () => {
    drawChoosable();
    const disclosure = screen.getByRole('button', { name: 'Hide rag' });

    // The whole of why the markup moved: a name inside the disclosure is part
    // of the fold's hit area, so clicking a group's name would fold it rather
    // than choose it. The chevron keeps the accessible name and stays the one
    // keyboard-reachable control on the header.
    expect(within(disclosure).queryByText('Front door')).not.toBeInTheDocument();
    expect(headerRow('rag').querySelector('.groupLabel')?.textContent).toBe('rag');
  });

  it('draws a tree from the header down its members, with an elbow at the last', () => {
    drawChoosable();
    const members = screen
      .getAllByRole('row')
      .filter((row) => row.classList.contains('expandMember'));
    expect(members.map((row) => row.textContent)).toEqual(['Chunk size', 'Chunk overlap']);
    // The elbow is a *position*, and `:last-child` cannot say it: a `<tbody>`
    // holds every group's rows, so the last member of a run is the last child
    // of anything only when its group is the last on the page.
    expect(members.map((row) => row.classList.contains('expandLast'))).toEqual([false, true]);

    const sheet = declarations(componentCss('Table.module.css'));
    const rule = (selector: string, property: string) =>
      sheet.find((entry) => entry.selector === selector && entry.property === property)?.value;

    // Drawn in the sheet rather than with box-drawing characters, which would
    // be sized by the font, could take no colour token, and would land in the
    // accessible name of every cell they sat in.
    expect(rule('tr.expandMember .td:first-child::before', 'border-inline-start')).toBe(
      '1px solid color-mix(in srgb, var(--rag-dim) 45%, transparent)',
    );
    expect(rule('tr.expandMember .td:first-child::after', 'border-block-start')).toBe(
      '1px solid color-mix(in srgb, var(--rag-dim) 45%, transparent)',
    );
    // The rule runs the height of every member and stops halfway down the last.
    expect(rule('tr.expandMember .td:first-child::before', 'inset-block')).toBe('0');
    expect(rule('tr.expandLast .td:first-child::before', 'inset-block-end')).toBe('50%');
    // It composes with the run's ground rather than replacing it: the ground
    // says this run is one thing, the tree says these belong to that.
    expect(rule('tr.expandMember .td', 'background')).toBe('var(--rag-surface2)');
  });
});

/**
 * **The table fits its container, at every width.**
 *
 * A table never scrolls sideways: it is sized to fit the box it is drawn in,
 * and nothing that reaches a table may contribute a width it cannot shrink.
 *
 * **What holds that is not a jsdom width assertion, deliberately.** jsdom has
 * no layout engine: every box in it is zero wide, so `scrollWidth <=
 * clientWidth` reads `0 <= 0` and passes against *any* stylesheet, including
 * one that overflows in every browser. Real widths need an eye on real glass.
 *
 * So what is asserted here is the **rule**, read out of the stylesheet the
 * browser will apply (`cssRules.ts`, which has its own refusal tests because
 * every assertion below is an assertion about an *absence*). The rule is one
 * sentence: nothing that reaches a table may contribute a width it cannot
 * shrink, and every exception says why it is one.
 *
 * **It is a property of the rendered table, not of one file.**
 * `Table.module.css` composes from `rows.module.css`, so a width introduced in
 * either lands on the same element — and a guard that read only the first would
 * be blind to half of what it audits.
 */
describe('the table cannot overflow its box', () => {
  const tableSheet = declarations(componentCss('Table.module.css'));
  const rowsSheet = declarations(componentCss('rows.module.css'));

  /** Every sheet whose classes reach a rendered table. */
  const sheetNames = tableStylesheets();

  /** Every declaration in all of them, each remembering which sheet it is in. */
  const everySheet: (Declaration & { sheet: string })[] = sheetNames.flatMap((name) =>
    declarations(componentCss(name)).map((rule) => ({ ...rule, sheet: name })),
  );

  /** How a failure names a rule, so the reader can go straight to it. */
  const where = (rule: Declaration & { sheet: string }) =>
    `${rule.sheet} { ${rule.selector} { ${rule.property}: ${rule.value} } }`;

  /** The identity column's floor, and the ceiling on every floor anywhere. */
  const FLOOR_PX = 6 * 16;

  const named = (sheet: Declaration[], property: string) =>
    sheet.filter((rule) => rule.property === property);

  const valuesFor = (sheet: Declaration[], selector: string, property: string) =>
    sheet
      .filter((rule) => rule.selector === selector && rule.property === property)
      .map((rule) => rule.value);

  it('gives neither stylesheet a way to scroll sideways', () => {
    // `overflow-wrap` is not `overflow`: the property that buys the fit and the
    // property that would undo it differ by a hyphen, so the filter is exact.
    const boxes = [...tableSheet, ...rowsSheet].filter((rule) =>
      ['overflow', 'overflow-x', 'overflow-inline'].includes(rule.property),
    );
    expect(
      boxes.length,
      'nothing states what the table box does with its overflow',
    ).toBeGreaterThan(0);
    for (const rule of boxes) {
      // `hidden` would still be a scroll container — a keyboard or a script can
      // scroll one — so `clip` is the only answer that removes the sideways
      // rather than hiding the bar.
      expect(['hidden', 'clip'], `${rule.selector} { ${rule.property}: ${rule.value} }`).toContain(
        rule.value,
      );
    }
    expect(valuesFor(tableSheet, '.wrap', 'overflow-x')).toEqual(['clip']);
  });

  it('audits both sheets a rendered table wears, not just its own', () => {
    // The blind spot this exists for: `Table.module.css` composes classes from
    // `rows.module.css`, so a `min-width` or a `nowrap` introduced in either
    // lands on the same cell. A guard that read only the component's own sheet
    // would pass while the table overflowed.
    expect(sheetNames).toContain('Table.module.css');
    expect(sheetNames).toContain('rows.module.css');
    // And it is the sheets a table *draws*, not every sheet in the package: a
    // table draws no dialog and no nav, so a nowrap in one of those is none of
    // this guard's business and must not be able to fail it.
    for (const absent of ['nav.module.css', 'overlays.module.css', 'form.module.css']) {
      expect(sheetNames, `${absent} is not drawn inside a table`).not.toContain(absent);
    }
    // Every declaration in both is actually read — a derivation that resolved
    // to nothing would satisfy every "no rule does X" assertion below.
    expect(everySheet.length).toBeGreaterThan(0);
    for (const name of sheetNames) {
      expect(
        everySheet.some((rule) => rule.sheet === name),
        `${name} contributed no declarations`,
      ).toBe(true);
    }
  });

  it('holds no column open by more than the identity floor, in any of them', () => {
    // A `min-width` is the one width auto layout may not shrink, so it is the
    // only thing left that can force an overflow outright. A 14rem floor is
    // 224px, which is most of a reading column at a modest window width.
    //
    // `minWidthFloorPx`, not `lengthPx`: the question is how much of the floor
    // is *unshrinkable*, and `min(320px, 100%)` — the callout panel's — never
    // exceeds its container, so it forces nothing. That is an account of the
    // value rather than a skip of it, which is the rule `cssRules.ts` runs on.
    for (const rule of everySheet.filter((entry) => entry.property === 'min-width')) {
      expect(minWidthFloorPx(rule.value), where(rule)).toBeLessThanOrEqual(FLOOR_PX);
    }
    expect(valuesFor(tableSheet, '.grow', 'min-width')).toEqual([`${FLOOR_PX / 16}rem`]);
  });

  it('lets the cells that can give ground break their content, and no others', () => {
    // `anywhere`, not `break-word`: only `anywhere` reduces min-content, and
    // min-content is the number auto table layout adds up to decide the fit. A
    // sheet using `break-word` looks wrapped and still overflows.
    //
    // **Four selectors, and which four is the whole of it.** Written
    // `.th, .td, .groupCell, .expandCell` — every cell — the property is true
    // of a line box and false of a column: `anywhere` puts every column's
    // min-content at one character, so auto layout may squeeze a column of
    // three-letter words to the width of one letter.
    //
    // It belongs on the cells for which severing is the least bad answer —
    // prose (which wraps at its spaces long before it severs), the identity
    // column (whose job is already to give ground) and the two spanning group
    // cells, where a long unbroken id in a group title has nowhere else to go.
    // Everything else keeps its words whole. `Table.module.css` carries the
    // arithmetic.
    expect(
      valuesFor(tableSheet, '.prose, .grow, .groupCell, .expandCell', 'overflow-wrap'),
    ).toEqual(['anywhere']);
    // The negative, and it is the assertion that would catch a revert —
    // audited the way the `nowrap` case below is, across **every** sheet that
    // reaches a table rather than off this one selector. `anywhere` is now the
    // exceptional property rather than the default, so a new one has to argue
    // that severing a word in its box is better than the alternative.
    expect(
      everySheet
        .filter((rule) => rule.property === 'overflow-wrap' && rule.value === 'anywhere')
        .map((rule) => `${rule.sheet} ${rule.selector}`),
    ).toEqual([
      // The four cells that can give ground. See the reasoning above.
      'Table.module.css .prose, .grow, .groupCell, .expandCell',
      // The identity cell's own two spans, which is `.grow`'s content stated at
      // the other end: `rows.module.css` gives both `white-space: nowrap` for
      // the *block* pill, and this is the rule that takes it back inside a
      // table cell (the case at the foot of this describe pins it). It is the
      // identity column, so it is one of the four.
      'rows.module.css .pillCell .identityName, .pillCell .identitySecondary',
    ]);
    expect(valuesFor(tableSheet, '.th', 'white-space')).toEqual([]);
  });

  it('leaves nowrap only where the box holds controls rather than data', () => {
    // **The audit, across every sheet that reaches a table** — a spot check
    // would only ever confirm what its author already suspected.
    //
    // Every entry below is a `white-space: nowrap` that can land on or inside a
    // table, and each has to argue that its width is bounded by something other
    // than the caller's data. A *new* one fails this case, which is the point:
    // the failure is the argument being demanded, not a rule being forbidden.
    expect(
      everySheet
        .filter((rule) => rule.property === 'white-space' && rule.value === 'nowrap')
        .map((rule) => `${rule.sheet} ${rule.selector}`),
    ).toEqual([
      // The two the sheet argues for in place: a controls column, whose floor
      // is one button, and the run of verbs on a group header, whose floor is
      // one button spread across every column it spans. A label broken mid-word
      // is not a smaller control, it is a broken one.
      'Table.module.css .controls',
      'Table.module.css .groupActions',
      // The block pill's identity, which is a flex row of known width. Inside a
      // table cell it is overridden back to `normal` — the case below pins
      // that.
      'rows.module.css .identityName',
      'rows.module.css .identitySecondary',
    ]);
  });

  it('writes no inline width, because nothing can audit one', () => {
    // A `style={{ width }}` on a `<th>` is an unshrinkable width that bypasses
    // every stylesheet at once, and is therefore invisible to every assertion
    // in this describe. `Column` declares no `width` for that reason.
    //
    // Asserted on the source rather than on a rendered cell, deliberately: a
    // DOM assertion would only catch the hatch once a *caller* used it, and a
    // hatch nobody has used yet is exactly the one to keep shut.
    expect(uiFile('src/components/Table.tsx')).not.toMatch(/style=\{/);
  });

  it('wraps the identity inside a table cell, where nowrap sets the column floor', () => {
    // The actual source of an overflow: `white-space: nowrap` makes a cell's
    // min-content width the width of the whole string, so the longest name in
    // the data becomes a width no column can shrink below. The block pill keeps
    // its ellipsis — it is a flex row of a known width.
    expect(
      named(rowsSheet, 'white-space')
        .filter((rule) => rule.value === 'nowrap')
        .map((rule) => rule.selector),
    ).toEqual(['.identityName', '.identitySecondary']);

    const override = '.pillCell .identityName, .pillCell .identitySecondary';
    expect(valuesFor(rowsSheet, override, 'white-space')).toEqual(['normal']);
    expect(valuesFor(rowsSheet, override, 'overflow-wrap')).toEqual(['anywhere']);
  });

  it('pins nothing: no frozen column, and no affordance for one', () => {
    expect(named(tableSheet, 'position').map((rule) => rule.value)).not.toContain('sticky');
    for (const gone of ['.frozen', '.frozenEdge', '.clipped', '.reach', '.reachButton', '.frame']) {
      expect(
        tableSheet.filter((rule) => rule.selector.includes(gone)),
        `${gone} is still in the stylesheet`,
      ).toEqual([]);
    }
  });

  it('draws a tighter cell than the block pill, and still no fixed height', () => {
    // A cell's padding is paid at every column boundary, so 12px between two
    // columns was 24px of gutter; 8px returns 4px per boundary to the columns
    // and 8px of height to every row. The pill keeps 12px — one element, one
    // payment — and `--rag-row-h` stays dead in both.
    expect(valuesFor(rowsSheet, '.pillCell', 'padding')).toEqual(['var(--rag-space-2)']);
    expect(valuesFor(rowsSheet, '.pill', 'padding')).toEqual(['var(--rag-space-3)']);
    expect(valuesFor(tableSheet, '.th', 'padding')).toEqual(['var(--rag-space-2)']);
    expect(named([...tableSheet, ...rowsSheet], 'height')).toEqual([]);
  });
});

describe('the table offers no sideways scrolling', () => {
  it('offers nothing, even to a box that reports an overflow', () => {
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const box = screen.getByRole('table').parentElement!;
    for (const [name, value] of [
      ['clientWidth', 578],
      ['scrollWidth', 943],
      ['scrollLeft', 0],
    ] as const) {
      Object.defineProperty(box, name, { value, configurable: true, writable: true });
    }
    box.dispatchEvent(new Event('scroll'));

    // A box reporting an overflow, and nothing listens to it: no chevron, no
    // fade, no frozen cell. The table is sized to fit instead.
    expect(screen.queryByRole('button', { name: /columns to the right/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /columns to the left/i })).toBeNull();
    expect(box.querySelector('[class*="frozen"]')).toBeNull();
    expect(box.parentElement!.querySelector('[class*="clipped"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// **A row held past the read that stopped returning it** (`TableProps.staleKeys`).
//
// Deciding *which* rows those are is the caller's. What is asserted here is
// only what a table does when it is told: the row is dimmed, it is still an
// ordinary row in every other respect, and the marking is per row rather than
// per table.
//
// Nothing here claims a pixel — jsdom applies no CSS. The class and the
// attribute are the assertable facts, and the stylesheet's own declaration is
// read off disk below.

describe('a row the caller is holding past the list', () => {
  const stale = (keys: string[]) => new Set(keys);

  it('marks only the rows named, and leaves every other row alone', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        staleKeys={stale(['archive'])}
      />,
    );
    const drawn = screen.getAllByRole('row').slice(1);
    expect(drawn.map((row) => row.getAttribute('data-stale'))).toEqual([null, 'true', null]);
    // Marked per row: a mutation that put the class on every row, or on none,
    // fails on the shape of this list rather than on one element.
    expect(drawn.filter((row) => row.className.includes('stale'))).toHaveLength(1);
  });

  it('draws no marking at all when the caller names nothing', () => {
    // The compatibility half: every table declared before this existed passes
    // no set, and `has` must never be reached on `undefined`.
    render(<Table columns={columns} rows={rows} rowKey={(row) => row.id} />);
    for (const row of screen.getAllByRole('row').slice(1)) {
      expect(row).not.toHaveAttribute('data-stale');
      expect(row.className).not.toContain('stale');
    }
  });

  it('keeps a held row selectable and clickable, because it is still a row', async () => {
    // The consequence it turns on: the detail panel beside the table is *about*
    // this row, so it must stay the selected one and stay openable. A held row
    // drawn as an inert placeholder would answer the styling half and break the
    // half that matters.
    const user = userEvent.setup();
    const opened: string[] = [];
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        selectedKey="archive"
        staleKeys={stale(['archive'])}
        onRowClick={(row) => opened.push(row.id)}
      />,
    );
    const row = screen.getByText('Archive policy').closest('tr')!;
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveAttribute('data-stale', 'true');
    await user.click(row);
    expect(opened).toEqual(['archive']);
  });

  it('states the drop in the stylesheet, and states it as opacity alone', () => {
    // The one visual claim, read off disk because jsdom cannot see it. A slight
    // opacity drop, and nothing else: a rule that reached for a colour, a
    // strike-through or `display` would say something the row does not mean.
    const sheet = declarations(componentCss('Table.module.css'));
    const stale = sheet.filter((rule) => rule.selector === '.stale');
    expect(stale.map((rule) => rule.property)).toEqual(['opacity']);
    const drop = Number(stale[0]!.value);
    expect(drop).toBeGreaterThan(0.4);
    expect(drop).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// **A live query opens every group** (`TableProps.searching`).
//
// Getting a keystroke in a search box as far as this flag is the caller's. What
// is asserted here is the table's own rule: while the flag holds, a folded
// group shows its members anyway, and the fold itself is set aside rather than
// rewritten.

describe('groups while a query is live', () => {
  interface Row {
    id: string;
    title: string;
    repo: string;
  }

  const cols: Column<Row>[] = [{ key: 'title', header: 'Topic', value: (row) => row.title }];
  const members: Row[] = [
    { id: 'a1', title: 'Chunk size', repo: 'repo:rag' },
    { id: 'a2', title: 'Chunk overlap', repo: 'repo:rag' },
    { id: 'b1', title: 'Wiki sync', repo: 'repo:wiki' },
    { id: 'b2', title: 'Wiki backlinks', repo: 'repo:wiki' },
  ];
  const groupBy = (overrides: Record<string, unknown> = {}) => ({
    keyOf: (row: Row) => row.repo,
    header: (key: string) => ({ title: key === 'repo:rag' ? 'rag' : 'wiki' }),
    ...overrides,
  });

  it('shows a declared-collapsed group’s members while it holds, and hides them after', () => {
    const { rerender } = render(
      <Table
        columns={cols}
        rows={members}
        rowKey={(row) => row.id}
        grouping={groupBy({ collapsed: true })}
      />,
    );
    expect(screen.queryByText('Wiki sync')).toBeNull();

    rerender(
      <Table
        columns={cols}
        rows={members}
        rowKey={(row) => row.id}
        grouping={groupBy({ collapsed: true })}
        searching
      />,
    );
    // Every group, not the first: a match can be in any of them, and opening
    // one is the same failure as opening none.
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.getByText('Wiki sync')).toBeInTheDocument();

    rerender(
      <Table
        columns={cols}
        rows={members}
        rowKey={(row) => row.id}
        grouping={groupBy({ collapsed: true })}
      />,
    );
    expect(screen.queryByText('Wiki sync')).toBeNull();
  });

  it('returns a group the reader folded to being folded, having never rewritten it', async () => {
    // The fold is *set aside*, not overwritten — so a reader who folded a group
    // before searching finds it folded again afterwards. An implementation that
    // wrote `folded[key] = false` would pass the case above and fail this one.
    const user = userEvent.setup();
    const { rerender } = render(
      <Table columns={cols} rows={members} rowKey={(row) => row.id} grouping={groupBy()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Hide wiki' }));
    expect(screen.queryByText('Wiki sync')).toBeNull();

    rerender(
      <Table
        columns={cols}
        rows={members}
        rowKey={(row) => row.id}
        grouping={groupBy()}
        searching
      />,
    );
    expect(screen.getByText('Wiki sync')).toBeInTheDocument();

    rerender(<Table columns={cols} rows={members} rowKey={(row) => row.id} grouping={groupBy()} />);
    expect(screen.queryByText('Wiki sync')).toBeNull();
  });

  it('disables the disclosure rather than letting a press do nothing visible', async () => {
    // A control that records something the reader cannot see take effect is
    // worse than one that says plainly it is not in force.
    const user = userEvent.setup();
    render(
      <Table
        columns={cols}
        rows={members}
        rowKey={(row) => row.id}
        grouping={groupBy()}
        searching
      />,
    );
    const fold = screen.getByRole('button', { name: 'Hide wiki' });
    expect(fold).toBeDisabled();
    await user.click(fold);
    expect(screen.getByText('Wiki sync')).toBeInTheDocument();
  });

  it('opens every group of an accordion, whose one-open rule a query suspends', async () => {
    const user = userEvent.setup();
    const accordion = groupBy({ expand: true });
    const { rerender } = render(
      <Table columns={cols} rows={members} rowKey={(row) => row.id} grouping={accordion} />,
    );
    // `collapsed` unset opens the first and only the first.
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.queryByText('Wiki sync')).toBeNull();

    rerender(
      <Table
        columns={cols}
        rows={members}
        rowKey={(row) => row.id}
        grouping={accordion}
        searching
      />,
    );
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.getByText('Wiki sync')).toBeInTheDocument();
    // The header row is not a toggle while it holds, or a stray click on a row
    // the query opened would close it again.
    await user.click(screen.getByText('wiki').closest('tr')!);
    expect(screen.getByText('Wiki sync')).toBeInTheDocument();

    rerender(<Table columns={cols} rows={members} rowKey={(row) => row.id} grouping={accordion} />);
    // And the accordion is exactly where it was: the first open, the rest shut.
    expect(screen.getByText('Chunk size')).toBeInTheDocument();
    expect(screen.queryByText('Wiki sync')).toBeNull();
  });
});
