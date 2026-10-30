m03: the dashboard
==================
**State: Done** (2026-10-27; acceptance 1–3 on the server's UI pending the release, 5's image build pending the
gate). Spec: [`master.md`](master.md), D14, D15, D17, R12. **Build from
[`api.md`](api.md)**, the HTTP contract m01 built.

*Written before rag-t0050 (2026-10-28) named a queue record a **ticket**: this milestone's plan, its as-built and
the addenda before that date keep the word *item* as they were written. The API keeps `item` ([`api.md`](api.md)).*

The owner's view of a project's queue and where the owner reorders it, in the existing web app and its design system
(`web/app`, `@rag/ui`).


Work items
----------
| WP | Work | Size | Files |
|---|---|---|---|
| TD-01 | **The client** for m01's routes: typed requests and errors as `api/client.ts` does for the ledger, `surface: 'web'` on every write, the queue view's conditional fetch (`If-None-Match`) | S | `web/app/src/tracker/api.ts` (new), `types.ts` |
| TD-02 | **Routing and navigation**: `/projects/:project` (the dashboard), `/projects/:project/item/:id` (not under `/tracker/`, which is the API's: see
[`api.md`](api.md) § *Web UI paths*); the project list is `GET /tracker/projects`; the app's header gains Ledger and Tracker; a project picker (the projects the server knows, the last one used remembered in `localStorage`, guarded as `identity/storage.ts` guards it) | S | `App.tsx`, `web/app/src/tracker/` |
| TD-03 | **The dashboard** (D14): the Done section with **Acknowledge all done**; the queue in list order with each row's status dot (green, blue, white, red per R12, the colours from the design tokens, each with a text label for colour-blind reading), type badge, id, title, assignee, approval badge and link chips; gates as full-width markers labelled with intensity and release; the Blocked section with reason, note and **Unblock** (asks for a note). The unratified-approvals filter. A 10 s refresh while the tab is visible, and an immediate one after the viewer's own write | M | `web/app/src/tracker/QueueView.tsx` (new) and parts |
| TD-04 | **Reordering**: drag a row or marker to a new place (pointer and touch; the drop becomes one `move` call, `before` or `after` its new neighbour; the row shows where it will land while dragged; on a refusal or a conflicting refresh the list snaps to the server's order and says so); each row's menu has **Move to top** and **Move to bottom**; keyboard: a focused row moves with Alt+↑ / Alt+↓ (one `move` each) | M | as above |
| TD-05 | **Adding and removing** (D14): **Add item** (type, title, body; joins the bottom) and **Add gate** (intensity, release; joins the bottom); **Remove** on a row or marker cancels it after a confirm, with a note | S | as above |
| TD-06 | **The item page** (D15): the record, its body rendered (the existing `markdown/` renderer, with `att:` images resolved), links (a ledger id links to its topic page; a spec, milestone or concept to its document, m04), the history in time order with surface and agent on each entry, and the actions: note, status, block or unblock, approve (`owner` from the web) or ratify an agent's approval, edit title, body and links, gate fields on a gate | M | `web/app/src/tracker/ItemView.tsx` (new) |
| TD-07 | **Docs**: `web/README.md` (the tracker views), `README.md` (the UI) | S | as listed |


Tests
-----
Vitest with Testing Library, as the ledger views' are, against a mocked client:

* The dashboard renders done, queued (with a gate marker between items) and blocked sections from a fixture, in
  order, with the right status labels; Acknowledge all done calls its route and empties the Done section.
* A drag from the fourth row to above the first calls `move` with `before` the first's id; a keyboard Alt+↑ calls
  `move` `before` the row above; Move to bottom calls `move` `bottom`.
* A refused move restores the server's order and shows the message.
* A blocked item is in the Blocked section and not in the queue; Unblock without a note is not sent.
* The item page shows the history with surface and agent, and ratifying an `agent` approval sends `ratified`.
* The 10 s refresh stops while the tab is hidden and a 304 changes nothing.


Acceptance
----------
1. On the server's UI, with a scratch project of eight items and two gates: drag items and gates into a new order,
   move one to the top from its menu, reload, and the order holds.
2. Mark an item done through the MCP tools (m02) or `curl`: it appears in Done within 10 s; Acknowledge all done
   hides it.
3. Block and unblock an item: it moves to Blocked and back to its place.
4. The views work at a phone's width (a 375 px viewport) with no horizontal scroll; drag works by touch.
5. `npm test` and the typecheck pass, and the image builds with the new bundle.


As built
--------
2026-10-27. `web/app/src/tracker/` (client, paths, poll hook, dashboard, item page, dialogs, row menu), routes and
nav in `web/app/src/App.tsx`, an opt-in `att:` rewrite in `web/app/src/markdown/render.ts`, 18 glyphs added to
`web/ui/src/icons/registry.ts`, `/tracker` and `/prompts` added to the dev proxy (`web/app/vite.config.ts`). Tests:
`trackerClient`, `trackerQueue`, `trackerItem`, `trackerShell` (62 cases) in `web/app/src/__tests__/`. Docs:
`web/README.md` § *The tracker*, `README.md` § *Tracker*, the routing table in `CLAUDE.md`.

Checked by hand against a scratch `rag-serve` (eight items, two gates, one blocked, one done): a mouse drag at 1400
px and a **touch** drag at 375 px (Chrome DevTools Protocol touch events) each became one `move` and the server's
order held (`/check` ok, the blocked item kept its place); no horizontal scroll at 375 px.

Choices the spec left open, made in keeping with its intent (ledger rag-0040 reorder, rag-0041 author fields, rag-0042
`att:` rendering):

* **The drop's anchor** is the row *as drawn*: `before` the first when the drop is at the top, otherwise `after` the
  row above. A blocked item between two drawn rows is never disturbed (api.md's advice).
* **One optimistic step.** A dropped row is drawn in its new place until the `move` answers, then the list is the
  server's either way. A refusal shows the server's sentence and "The list shows the server's order". A refresh
  that changes the order *during* a drag cancels the drag and says so, rather than dropping against neighbours that
  may have moved.
* **Reordering is off while the unratified filter is on** (the hidden rows are neighbours too); the menu's Move to
  top and bottom still work.
* **The poll** is `If-None-Match` with `cache: 'no-store'` (so a 304 reaches the code), no timer while the tab is
  hidden, an immediate refresh when it is shown, and only the newest request may land.
* **Unratified filter** means `approval: agent`, across all three sections, with the count in its label.
* **Done and Blocked are hidden when empty**; the queue always shows, with an empty state.
* **Add gate** titles the gate from its choices (`Full gate and release`) until the owner types a title; the API
  needs one.
* **Remove** is `status: cancelled` with a required note (the API required one for a status change; optional since
  2026-10-27, see the addendum), after a
  confirm that says it stays in history and a reopen puts it back at the top.
* **Approvals from the web**: *Approve* (`unapproved` → `owner`), *Ratify* (`agent` → `ratified`), and *Withdraw
  approval* (`owner`/`ratified` → `unapproved`), each with a note.
* **Status offered** is the transition table (with m02's `pending` → `done`/`failed`); the server stays the judge.
* **Item page links**: a ledger id opens `/topic/<id>`; an item its page; a spec or concept its document path
  under `/projects/<project>/doc/…` (m04 builds those pages, so until then they land on the not-found page); a
  milestone is looked up (`GET …/milestones/{code}`) for its path, since the path holds a name the link does not.
* **The history** names the surface on every entry: `web` entries read "on the web" (the owner; the agent recorded
  as `Unknown` is not shown), `mcp` entries name their agent. A create's default fields are not repeated.
* **The bar**: Search, Archived and **Tracker** in one nav; the brand names the section (Ledger or Tracker). Tracker
  opens the last project used (`localStorage` `rag.tracker.project`, guarded), else `/projects`, a project list
  with counts and an *open by name* box. The ledger's New topic and topic-id box are not shown on tracker pages.
* **Light/dark**: the design system has one dark theme and no light axis (`web/ui/src/tokens.css`); the tracker
  uses its tokens and adds none, so it matches the ledger UI rather than adding a theme of its own.
* **Writes carry `surface: 'web'` and no `agent`** (the tracker refuses unknown fields, so the ledger's
  `author_agent: null` is never sent), built in `tracker/api.ts` alone.

### Addendum, 2026-10-27: notes optional except Add note (rag-t0007)

The owner found the required note a chore on every action. Every write dialog's note is now optional: the field is
labelled *Note (optional)* (*Message (optional)* for a restore), the button is never held back and no validation
error shows; a blank note is not sent and the server writes the history entry from the change. **Add note** alone
still needs text: its field is labelled *Note*, and a blank one is refused in the form (*A note needs some text.*)
and in the client before any request. The client (`tracker/api.ts`) no longer refuses a status, block, approval or
state change, or an approved create, without a note; it drops a blank one, and refuses an update with nothing in
it. Tests: `trackerItem.test.tsx` (status, block and ratify sent without a note; Add note never sent blank),
`trackerQueue.test.tsx` (Remove and Unblock), `trackerDocs.test.tsx` (a state change and a restore with or without
one), `trackerClient.test.ts`.

### Addendum, 2026-10-27: the History page (rag-t0008)

The owner asked whether cancelled or deleted items could be seen anywhere. Nothing is deleted (Remove cancels), but
once an item is cancelled, or done and acknowledged, the dashboard no longer drew it. Added
`/projects/<project>/history` (`web/app/src/tracker/HistoryView.tsx`), a **History** tab beside Queue and Documents
at the head of every project page: done (acknowledged or not), cancelled and failed items in a table in the ledger
UI's Archived style, newest first, with a status filter (All, Done, Cancelled, Failed, each with its count under the
other filters), a type filter and a text filter over the id, title, body and assignee, all kept in the URL
(`?status=&type=&q=`). Each row, and its title link, opens the item page, which has Reopen. It reads
`GET /tracker/{project}/items?status=` once per status in parallel and is not polled. **No server change.** Only
`done` carries its own time (`done_at`); the Item has no cancel or fail time, so those rows are placed by
`updated_at`, marked *(last change)* on the stamp and explained in the page's note: a note written after the cancel
moves the item up. A done item's acknowledgement shows in its own column and does not move it. Tests:
`web/app/src/__tests__/trackerHistory.test.tsx` (16: the three reads and no others, the order, the time's source, each
filter and the URL, a row and a link opening the item, empty and failed reads, a refused project name, the tab).

### Addendum, 2026-10-27: approving from the row, and new work approved (rag-t0009, rag-t0010)

The owner asked to ratify without opening the item. On the dashboard an **Agent-approved** badge, in any section, is
now a button (named *Agent-approved: ratify <id>*, so it is reachable and pressable from the keyboard) that opens
*Ratify the agent’s approval?* with an optional note; Ratify sends `approval: "ratified"`, Cancel sends nothing, and
the row re-reads after with the keyboard put back on the row. Only `agent` is a button: unapproved, ratified and
owner-approved stay plain badges. The owner's follow-up note on rag-t0009 (an **Approve** where the agent did not
approve) is built the same way: an unapproved row in the queue or under Blocked has *Approve*, which opens *Approve
as the owner?* and sends `approval: "owner"`; Done rows have none, finished work needing no approval. Both dialogs
are one `ApprovalDialog` (`tracker/dialogs.tsx`), which the item page's Ratify and Approve now use too, word for word
as before. With no identity set, the badge and Approve open the identity prompt instead.

**Add item** has *Create it owner-approved* under the body, ticked by default (the owner creating it is the owner's
approval) and ticked again whenever the dialog resets; ticked sends `approval: "owner"` with `surface: "web"`,
unticked sends no `approval`. **Add gate** has the same box with the same default, under its title: a gate the owner
adds is as much the owner's decision as an item. The box is a new `Checkbox` in `@rag/ui` (a native checkbox and its
label; `Toggle` is a switch for a setting that applies at once, not a form's yes-or-no). **No server change**: create
and update already took both without a note (rag-t0007). Tests: `trackerQueue.test.tsx` (ratify by click and by
keyboard, with and without a note, cancel, the badge a button for `agent` only, Approve on queued and blocked rows and
none under Done, the identity prompt, the row refocused; add item and add gate approved by default and unapproved
when unticked, the box re-ticked after a reset), `web/ui`'s `inputs.test.tsx` (`Checkbox`).

### Addendum, 2026-10-27: the gate's title on its marker, chips before the approval (rag-t0015, rag-t0016)

A gate marker now names the gate's own title after its *Standard gate* name, before the Release badge: one line, cut
with an ellipsis (at most 48 characters wide on a desktop, whatever is left at phone width, where only the title gives
way and the name, Release and the status stay), whole in its `title` tooltip. The label no longer wraps. A title the
marker already says (its name, or the title Add gate writes by default, `Standard gate and release`, compared without
case) is not repeated, so only a title someone wrote shows (`gateOwnTitle` in `tracker/QueueList.tsx`).

A row's ledger chips now sit left of its approval (the badge, the Agent-approved ratify button or Approve), so the
approval keeps the row's right edge: in the queue and under Done, and under Blocked, whose rows did not show their
links before and now do, in the same place (after the block reason, before the approval and Unblock). The documents
pages (concepts, specs, the record panel) keep their order: they are not the queue's row. **No server change.**
Tests: `trackerQueue.test.tsx` (the title shown with its tooltip, the name and Release kept; a default title not
repeated; `gateOwnTitle`'s cases; the chip before the approval for owner-approved, agent and unapproved rows, under
Done and under Blocked, and in `QueueList` alone).

### Addendum, 2026-10-27: Deferred (rag-t0017)

The owner asked for intentionally deferred work to be kept apart from blocked work, listed under it, with a teal
icon. The dashboard has a fourth section, **Deferred**, below Blocked: its rows in list order, each with a teal
status dot beside the word *Deferred*, its block reason and note when it is also blocked, its links and approval
(ratify and Approve as under Blocked), and **Resume**, which opens *Resume this item?* (note optional) and sends
`status: "pending"`; the item goes back to its place in the queue. A queue row's menu has **Defer** (*Defer gate*
on a marker), which opens *Defer this item?* and sends `status: "deferred"`. The item page has **Defer** (or
**Resume** on a deferred item) beside Block, and its Status… list offers *Defer (keeps its place)* and *Resume
(pending, in place)*. A deferred item's dot says Deferred whether or not it is blocked (`dotState`), and its block
still shows on the item page. The project picker's summary counts deferred items. The teal is a new token,
`--rag-teal` in `@rag/ui`'s `tokens.css`, deeper than `--rag-acc2` so it stays apart from in progress's blue and
done's green; the section's left edge is teal too. Two icons joined the registry: `circle-pause` (Defer) and
`circle-play` (Resume). The History page is unchanged: deferred work is still queued. Tests:
`trackerQueue.test.tsx` (the section order and rows, a blocked-and-deferred row, no section without deferred items or
without the array, Defer from the menu, a cancelled Defer sends nothing, Resume with a note, the teal rule and token,
the picker summary), `trackerItem.test.tsx` (Defer, a deferred and blocked item shown as deferred, its transitions,
Resume).

### Addendum, 2026-10-27: Parallel, waits on, and the gate marker at a phone's width (rag-t0013, rag-t0018, rag-t0019)

**Parallel** (rag-t0013): a queue row of a parallel item carries a neutral **Parallel** badge (its tooltip says what
it means), as does the item page's header; Add item has a box, *Parallel: may start before the gates above it, lands
after them*, unticked by default and on every reset (ticked sends `parallel: true`, unticked sends nothing); the item
page's Edit has the same box on any item but a gate (`editBody` sends `parallel` only when it changed, never for a
gate). **Dependency** (rag-t0018): the block reason reads *Waits on items*. Under Blocked (and under Deferred, for a
deferred item that is also blocked), a row blocked with it says **waits on** and each item as a chip linking to its
page (`WaitsOn` in `parts.tsx`); so does the item page's blocked line. The item page's **Block…** dialog offers the
reason and, for *Waits on items*, a **Waits on** picker (`Picker`, several values) over the project's other queued
items (`GET /tracker/{project}/items`, read when that reason is chosen; `dependencyCandidates` leaves out the item
itself, done and cancelled ones); an empty choice is refused before any request (*Choose at least one item it waits
on.*). The history shows `Parallel`, `Waits on` and the `Done` item that unblocked it. **The gate marker at a
phone's width** (rag-t0019, found by the gate rag-t0011's browser pass): below 40rem the marker's id was hidden by a
`display: none` and its title shrank to 0 px. Now the dashed rules shrink to a stub, the label takes the row and
wraps: the name, Release, the state and the **id** on the first line, the title on a line of its own (`flex: 1 1
100%`, `order: 1`) cut with an ellipsis. Measured in headless Chromium at 375 px: the label 260 px, the title 234
px, the id shown, no horizontal scroll; at 1400 px unchanged, one line. Tests: `trackerQueue.test.tsx` (the badge
on a parallel row only; Add item's box; the waits-on links under Blocked; the phone rules: the id never hidden, the
label wrapping, the title's line and ellipsis, the rules' stub), `trackerItem.test.tsx` (blocking on a dependency
through the picker, with the refusal of an empty choice and the candidates offered; the waits-on links and Parallel
badge on the page; Edit's box; `editBody` and `dependencyCandidates`).

### Addendum, 2026-10-27: done gates drawn as markers, in green (rag-t0021)

Owner: "can we make the gate lines in the 'done' section appear the same way they do in the queue, but green instead
of purple". A gate under **Done** is now the queue's full-width marker line (dashed rule, label, dashed rule): the
intensity, the gate's own title (rag-t0015's rules), Release, its state (a compact *Done*) and the id, wrapping at a
phone's width exactly as rag-t0019 made the queue's. One component draws both: `GateMarker` in `QueueList.tsx`,
extracted from the queue's row, with `variant: 'queue' | 'done'`. The `done` variant adds `markerDone`, which sets
`--marker-colour: var(--rag-good)` (the done status's own token) on the rules and the label; `.rule` and
`.markerLabel` read `var(--marker-colour, var(--rag-extra))`, so the queue's marker is the purple it was. Under Done
the marker has no grip and no menu (nothing there moves), keeps Done's own row separators (`.flat > .marker` drops
the marker's bottom border) and links to the item page as a done row does. A done gate shows no done time, ledger
chips or approval, as the queue's marker shows none; the other done rows are unchanged. **History** draws gates as
plain table rows and does not use the marker, so it was left alone. Tests: `trackerQueue.test.tsx` (a done gate is
a marker with the queue's label, two rules and its item link, all in the done tone, and no type column, while a done
item stays a row; the queue's marker never takes the done tone; the stylesheet's `markerDone` uses the same token as
`.status_done`, and the rule and label fall back to `--rag-extra`).

### Addendum, 2026-10-27: Review, the in-progress tint, real buttons, two-line rows (rag-t0023 to rag-t0026)

**Review** (rag-t0024): a section between Done and the queue, its left edge red (`--rag-crit`, failed's token, the
owner's choice), its rows in list order with the status **Review** beside a red **diamond** (`.status_review
.statusDot` rotated 45°; failed keeps its disc), the block and note when also blocked, the approval (ratify and
Approve as elsewhere), **Confirm** (tinted `accent`; *Confirm this item?*, note optional, sends `status: "done"`) and
**Send back** (*Send this item back?*, sends `status: "in_progress"`). The item page has Confirm and Send back on a
review item, and its Status… list offers *Review (waits on the owner, keeps its place)*, *Confirm (done, leaves the
queue)*, *Send back (in progress, in place)*. `dotState` keeps review over blocked; the picker's summary counts
`N in review`; the unratified filter counts review rows. The Block dialog no longer offers *Needs approval*
(`BLOCK_REASONS` lost `approval`). History is unchanged. **The in-progress tint** (rag-t0023): a queue row whose
status is in progress has `rowInProgress`: `color-mix(--rag-acc 11%)` over the panel, across both lines, its hover
the same blue at 17% rather than the plain row's grey; a lifted row keeps the lifted look. **Buttons that look like
buttons** (rag-t0025): the row's **Approve** was a `ghost` button (no fill at rest, its hover `--rag-surface2`, the
row's own hover colour); it is now the design system's tinted `accent` button (blue fill and border at rest, deeper
on hover). The **Agent-approved** ratify badge had the same fault; it now carries an amber fill at rest
(`--rag-warn` 16%) and 30% on hover and focus, neither a row's grey nor the in-progress blue. **Two-line rows**
(rag-t0026, owner's layout): line one is the status, the id, the title (the free width, cut with an ellipsis), then
the approval and the section's actions (Confirm and Send back, Unblock, Resume: kept on line one beside the
approval, where the eye already goes to act; Done's time sits there too), and the menu in the queue; line two
(`SecondLine` in `parts.tsx`, `cellLine2`) is the type badge, the assignee, the Parallel badge or a block's reason
and what it waits on, then the link chips at the right end (`line2End`). This moves rag-t0016's chips from left of
the approval to the second line; the approval keeps the first line's right edge. The type column is gone from the
grids; line two is indented under the status word. Done, Review, Blocked and Deferred rows share one `FlatRow`
(`li.flatRow`, a grid of three rows: the lines and a block note). Gate markers stay one line. At a phone's width a
row is the status and id, the title wrapping, the approval and actions, then line two, all wrapping; no horizontal
scroll. Drag geometry is measured per row, so taller rows move by their own height (a test drags over 64 px rows).
Tests: `trackerQueue.test.tsx` (the Review section's order and rows, a blocked review row, no section without
items, Confirm, Send back with a note, a cancelled Confirm, the picker, the red and the diamond in the stylesheet;
the tint's class on in-progress rows only and its rule; Approve's `accent` class; the ratify fill and hover; the two
lines of a queue row and of every section's rows, actions on line one; the phone rules; a drag over taller rows; the
chip tests now assert the approval on line one and the chips at line two's end), `trackerItem.test.tsx` (Confirm and
Send back on a review item, its transitions; Review offered on a pending item; no *Needs approval* in the Block
dialog).

### Addendum, 2026-10-27: labels (rag-t0027)

The owner: labels such as *Physics*, *Biomes*, *Creatures* on items, "to the right of assignment on the second
row". **Chips**: `LabelChips` (`parts.tsx`) draws an item's labels as rounded tags in the body face (not the mono
link chips), each a link to the dashboard filtered to it (`/projects/<project>?label=Physics`), placed by
`SecondLine` straight after the assignee and before the section's detail (Parallel, a block), so the link chips
keep the line's right end. The item page shows them in its header (*Labels*, `—` without) and each change in its
history (*Labels: Biomes, Physics* or *none*). **The dashboard's filter**: a select (*All labels*, then the labels
the view's items carry, a label in the URL kept as an option even when nothing in view has it) beside *Unratified
only*, drawn only when there is a label to offer; the choice is `?label=` in the URL (`replace`, so it does not
stack history), matched case-insensitively (`hasLabel`). It narrows every section; in the queue it **keeps the
gates** (the batch each labelled item is in still shows) and a queue left with gates only shows *No item labelled X
in the queue*. Either filter turns reordering off with the same hint (rag-0065). **The editor** (`LabelEditor.tsx`, on Add item
and the item page's Edit; not Add gate, though the store and Edit take a gate's labels): the design system's
`ChipList`, which gained `suggestions` (a native `datalist` of values not already chosen) and `maxLength`, fed the
project's vocabulary (`GET /tracker/{project}/labels`, read when the dialog opens; a failed read only loses the
suggestions); then up to eight of the project's most used labels as one-click *+ Label* buttons. What is typed is
split on commas, put in the project's casing, merged case-insensitively and checked as the server checks it
(`labels.ts`: 32 characters, no control character, ten at most), a fault shown as the field's error without adding
it. On submit, text still in the entry box is committed through the `ChipList` handle and sent too. Edit sends
`labels` only when the set changed (`editBody`), and wholesale. The client (`api.ts`) refuses a bad label or more
than ten before any request. **History**: the same `?label=` filter (a select beside Type), and each row's labels
under its title, a chip there filtering the History page itself (`labelQuery`) without opening the row's item.
Tests: `trackerLabels.test.tsx` (the rules, the casing and merging, the comma split, the client's refusals and the
vocabulary read, `editBody`; the chips' place on line two after the assignee and before the link chips and their
links; the filter from the URL, keeping gates, reordering off, the select setting and clearing the URL, the empty
state, no select without labels; Add item from a quick-add button and typed text in another casing, a refused label
and a label left in the box, none sent without labels; the item page's labels, its history row and an Edit sending
the set; History's filter from the URL and the select, and a chip filtering it), and `inputs.test.tsx` in
`@rag/ui` (the datalist and `maxLength`, and none without suggestions).

### Addendum, 2026-10-27: Done in queue order, the in-progress blue (rag-t0029)

**Done in queue order.** The owner: Done read newest first, the reverse of the queue. It now reads oldest first and
the newest last (by `done_at`, then id), so the latest finished sits nearest the queue. The order is defined once, on
the server: `TrackerStore::queue_view` sorts `done` (`crates/core/src/tracker/items.rs`); the dashboard and the MCP
`tracker_queue` Done section draw it as given, neither re-sorting. `api.md` § *The queue view* and the tool's
description say so. **The in-progress blue.** rag-t0023's tint (`--rag-acc` at 11 %, 17 % on hover) was too light;
the row is now filled with the owner's `#0b61ac`, a new `@rag/ui` token `--rag-inprogress`, its hover
`--rag-inprogress-hover` (`#094e8a`, a step deeper: 1.3:1 against the fill, more than a plain row's hover step). On
that blue the palette's foregrounds fail (`--rag-text` 4.0:1, `--rag-acc` 3.0, `--rag-warn` 3.4, `--rag-dim` 2.1),
so `.rowInProgress` re-points `--rag-bright`, `text`, `dim`, `acc`, `good`, `warn` and `crit` at a new
`--rag-on-inprogress-*` family that keeps each hue and reads at 4.5:1 or better on the fill (4.7 to 6.3:1; more on
the hover). Every word, badge, chip, the assignee, the status word and dot, and the focus ring (`--rag-acc`) follow
without a rule of their own; chips and labels keep their dark grounds, now with lighter text. A tinted control (the
`accent` Approve, Unblock, the ratify pill) is a share of its colour over what lies under it, which on the blue is a
lighter blue its text fails on (4.0:1), so on these rows the row's buttons and the ratify pill mix into
`--rag-surface` instead (16 % at rest, 30 % on hover: 8.7 and 5.6:1), outlined in the pale colour. The row menu and
popups are portals and keep the page's tokens. Tests: `crates/core` (`the_queue_views_done_is_oldest_first_by_done_at`:
`done_at` decides over the id, the id breaks a same-second tie; the acknowledge test's order), `crates/mcp`
(`queue_done_keeps_the_views_oldest_first_order`), `trackerQueue.test.tsx` (Done in the fixture's server order; a
three-row Done not re-sorted; the fill and hover rules and the `#0b61ac` token, the hover step measured; every
re-pointed token measured at 4.5:1 on the fill and the hover, and the palette's own shown to fail; the control fills
over `--rag-surface` measured at rest and hover; Approve, the ratify pill and Unblock on in-progress rows inside the
rules' reach).

### Addendum, 2026-10-27: no link chips on the rows, the labels in their slot (rag-t0031)

The owner: the link chips on the dashboard's rows did not look right; links are for the item's page. `SecondLine`
(`parts.tsx`), which draws every row's second line in all five sections (`FlatRow` in `QueueView.tsx`, and
`QueueList.tsx`), no longer draws `LinkChips`; the item page keeps its links, and `LinkChips` stays for the
Documents page and the record panel. The **labels** (rag-t0027) moved from right of the assignee into the slot the
chips left, the line's right end (`line2End`), drawn only when the item has labels; there they wrap from the right
(`.line2End > .labels`), and a label is at most `min(14rem, 100%)` wide, its name cut with an ellipsis, so at a
phone's width the labels wrap or truncate within the row and never widen the page. A dependency-blocked row's
**waits on** (rag-t0018) stays on the left, with its item links: it is the block's reason, not a link chip. The MCP
`tracker_queue` text is unchanged. This supersedes rag-t0016's and rag-t0026's chip placements and rag-t0027's
label placement. Tests: `trackerQueue.test.tsx` (no link chip, nor a `+N`, on a row in Done, Review, the queue,
Blocked or Deferred, each with links of every kind; the labels at line two's end, after the approval, not beside
the assignee; *waits on* still linking its item; no `line2End` on a row without labels; the list on its own; the
phone rules for the labels' wrap and width), `trackerLabels.test.tsx` (the labels at the right end, apart from the
assignee, and no ledger chip on the row).

### Addendum, 2026-10-27: the in-progress tint, assignees in one column (rag-t0033)

The owner: rag-t0029's solid `#0b61ac` came out too light and bright; he meant a dark blue close to the normal row.
**The tint.** An in-progress row is now `--rag-inprogress-row`, `color-mix(in srgb, var(--rag-inprogress) 20%,
var(--rag-surface))`, the owner's blue as a low share over the panel the row sits on (opaque, so a lifted or
overlapping row composes the same): `#162839`, 1.16:1 against a plain row (a plain row's hover is 1.13:1), a dark
navy. Its hover, `--rag-inprogress-row-hover`, is the same blue at 28 % over the panel (`#152e44`). Not the 20 %
tint over a plain row's hover grey (`--rag-surface2`): `--rag-dim` reads 4.35:1 there. On the tint the palette's own
foregrounds all pass, so the row is back to them: `--rag-dim` 4.90:1 at rest and 4.55 on hover (the tightest),
`--rag-crit` 5.27 and 4.89, `--rag-text` 9.4 and 8.7. rag-t0029's `--rag-inprogress-hover`, the seven
`--rag-on-inprogress-*` tokens, the `.rowInProgress` re-pointing and the dark control fills are gone; Approve, Unblock
and the ratify pill are the design system's tinted controls again (at rest over the tint: Approve 5.4:1, the pill
5.8:1). Their hover shares (the `accent` button's 24 %, the pill's 30 %) read 4.0:1 on the tint, as they read 4.45
and 4.1:1 on a plain row's hover today: a design-system property, not changed here. The focus ring is `--rag-acc`
on the navy. **The column.** A row's type and status are **slotted** (`TypeBadge slotted` from `SecondLine`, `StatusDot slotted`
from `FlatRow` and `QueueList`, so every section): each word is stacked over a hidden, zero-height stack of every
word of its kind, one a line (`ITEM_TYPE_SIZER`, `STATUS_SIZER` in `vocab.ts`, drawn by the `::after` of
`.typeSlotted > .typeLabel` and `.statusSlotted > .statusLabel` from `data-sizer`, `white-space: pre`), so each slot
is the widest word's own rendered width in whatever font and scale the page has; never a fitted `px` or a guess in
`ch`, and no word can overflow it. The status sizer is drawn at the status word's heaviest weight (600; pending's is
500), so every row's slot is one width. The type and the assignee are one unit (`.line2Who`, never wider than the
line), the name cut with an ellipsis (its full text the tooltip) rather than wrapped under the type. **Across
sections** (the manager's call on the owner's "all"): a flat row (Done, Review, Blocked, Deferred) leads with the room
the queue's grip column takes, empty, so its status word and its second line start at the queue's x. The queue's
status sits 35 px into its section at desktop width (a 1 px border, the 28 px grip column, half the row's 12 px gap,
the subgrid's inset) and 45 px on a phone (1 + 4 px padding + 28 + 12, no subgrid); a flat section's border is 3 px,
so a flat row's left padding is 32 px (was 12) and 42 px on a phone. Its status column is `max-content` of the slot
(was `7.5rem`), the queue's width, so the ids line up across sections too. A first cut narrowed it to a fitted
`calc(7.5rem - 20px)`, which left *In progress* 2 px of room in DejaVu Sans and would clip in another font or at
another scale; replaced by the sizer. Measured in headless Chromium against a scratch `rag-serve` (every section,
every status shown but cancelled; each word checked against its own free width, and its right edge against the id):
nothing clips, no horizontal scroll, the status slot exactly the widest word's width, the ids within 1 px across
sections, and every assignee at one x in all five sections: default font (DejaVu Sans) 252.1 at 1400 px and 148.1 at
375 px; text at 125 % 175.6 and 163.6; DejaVu Sans Mono 245.6 and 141.6; DejaVu Serif at 110 % 201.4 and 158.2.
Gate markers are unchanged. Tests: `trackerQueue.test.tsx` (the
tint and hover rules and tokens, the share and the composite measured, near a plain row but apart from it, the hover
a visible step; every palette foreground at 4.5:1 on both, the 20 % over the grey shown to fail; no re-pointing, no
`--rag-on-inprogress` left; the tinted Approve and pill measured at rest), `trackerTypeSlot.test.tsx` (every row's
status and badge slotted in all five sections, the assignee straight after the badge, their own text unchanged; each
sizer every word of its kind; the sizers' CSS, the status sizer at the heaviest weight; the pair's CSS; a flat row's
32 px and 42 px lead and its `max-content` status column; status and badge unslotted off the rows).

### Addendum, 2026-10-27: scroll memory, the review row, copying the id (rag-t0040, rag-t0041, rag-t0042)

**Scroll memory** (rag-t0040, the owner: queue → item → back should land where he was). `tracker/scrollMemory.ts`,
`useScrollMemory(key, ready)`, on the dashboard (`queue:<project>`), History (`history:<project>`) and Documents
(`docs:<project>:<tab>`; Attachments loads on its own and is not remembered). The window's scroll is saved to
`sessionStorage` (`rag.tracker.scroll.<key>`, guarded: a refusing browser restores nothing) on every scroll event
once the visit has settled, and put back **once**, in a layout effect, when `ready` (the page's rows have rendered:
the queue's `state.kind === 'ready'`, History's and Documents' lists loaded). Restoring once is what keeps the 10 s
refresh from moving the reader; nothing is saved before the restore, so the short loading page never overwrites the
position it returns to; the listener goes in the layout cleanup, before the next page's shorter layout clamps the
scroll. **A return** restores: a router `POP` after a `popstate` (the browser's back and forward; a module-level
listener added before the router's tells it from the first location, which React Router also calls `POP`), a link
carrying `RETURN_STATE` as router state (the item page's crumb and Project link, a document's link to the documents
page, the Queue / Documents / History tabs), and the page load itself when its navigation type is `reload` or
`back_forward`. Anything else (a pasted link, the Tracker button, the picker, a label link) is a fresh visit: the
stored position is dropped and the page goes to the top at once. A visit starts when the page mounts or its key
changes, so a filter written into the URL is not a new visit; a Documents tab switch is. Router state rather than
the browser's own restoration because the page draws a spinner first, so the browser restores into a page too short
to scroll; `history.scrollRestoration` is left `auto` for the ledger's pages. Measured in headless Chromium (scratch
`rag-serve` on :17895, 70 items, 30 cancelled; since stopped), at 1400 and 375 px: the crumb, browser back and the
Queue tab restore the queue exactly (1109 → 1109, 2069 → 2069); History restores by its tab and by back; a pasted
link opens at the top and a reload keeps the place; a refresh that adds a row at the bottom leaves `scrollY` as it
was, and one that adds a row above leaves the rows in view where they were (Chromium's scroll anchoring); no
horizontal scroll. Tests: `trackerScroll.test.tsx` (the rules; the storage, per key, junk and refusal; the hook's
timing: no restore before the rows, once only across refreshes, nothing saved while short, a plain visit to the top
and the position dropped, the first page fresh, a reload restoring; the real dashboard and item page by the crumb and
by back, the scroll made only once the queue's rows are in the page, and across a changed 10 s refresh; History and
the Documents tabs; the tabs carrying the return).

**The review row** (rag-t0041). On the item page of an item in Review, **Confirm** and **Send back** are on a second
row of their own (`role="group"`, *Review*) under the other writes: Confirm in the done green, the design system's
new `good` button (`--rag-good` over `--rag-tint-good` 14 %, hover `--rag-tint-good-hover` 24 % with the text lifted
by `--rag-tint-lift`, as rag-t0034's pair), Send back the `caution` button (the blocked amber). Focus changes only
the ring, so the resting text is the focus text. `ui/src/__tests__/tintContrast.test.ts` holds `good` to 4.5:1 at
rest and on hover on every ground (the "fails without the lift" case stays for `accent` and `caution` only: the green
is light enough to pass unlifted); `trackerItem.test.tsx` the row, its order, its place under the rest, and none for
other statuses.

**Copying the id** (rag-t0042). A copy icon (the registry's `copy`, a `check` while it has copied) right after the id
in the item page's top row, named *Copy <id>*, with "Copied" (or "Could not copy") in a live status for 1.5 s.
`tracker/CopyButton.tsx`'s `copyText` uses `navigator.clipboard` in a secure context and otherwise, as on the LAN's
plain http where it does not exist, or when it refuses, a hidden read-only textarea, selected, and
`execCommand('copy')`, synchronously in the click, focus handed back to the button. Attachments' `att:` copy now
uses it too (it failed on http the same way). Measured in headless Chromium against the scratch server on a
non-localhost name (not a secure context, no `navigator.clipboard`): Enter on the focused button copied the id, read
back from the clipboard on a secure page; the secure path too. Tests: `trackerCopy.test.tsx` (its place after the
id; both paths; the fall-back on a refusal; refused both ways; no `execCommand`; Enter and Space; "Copied" clearing).

### Addendum, 2026-10-27: requests (rag-t0044)

**Add request**, an accent button at the right of the page's header (it is the owner's, not the queue's, so it is
not beside Add item and Add gate), opens *Add a request*: a title (required) and the **Request** (markdown, a
16-row box against an item body's 8), and the *Create it owner-approved* box, ticked, as every owner creation is.
It sends `type: request` and nothing else of an item's (no type choice, labels, parallel or place). **Requests**, a
section between Done and Review with the accent's left edge, lists the view's `requests` as two-line rows like
Review's, with the approval control; it is drawn only when there are some, and the unratified and label filters
apply to it. The row's type is the **Request** badge: its own word and glyph (`message-square`) in the accent
(`.type[data-type='request']`), so a request never reads as work.

**The item page.** A ticket with a `from` link shows **From request** in its header, each a link to the request.
A request has a **Became · N tickets** panel above Links: each ticket its status, id (a link), type and title, read
one by one (`history=false`); a ticket that cannot be read stays its id, still a link; with none, *Not broken down
yet.* `from` and `became` are not repeated under Links. **Edit** never offers `became` (`addableLinkKinds`), never
offers `from` on a request, draws no remove button on a `became` link (it goes with its ticket's `from`), and has
no Parallel box on a request. A concept's Links dialog offers neither kind.

Tests: `trackerRequest.test.tsx` (the section's place and rows, none without requests, the badge, never in the
queue; Add request's body, its required title and its larger box; Became with a read and an unread ticket, the empty
request, From request and Links without them; Edit's link kinds, no remove on `became`, no Parallel; the
vocabulary's `addableLinkKinds`, `linkHref` and labels).

### Addendum, 2026-10-27: dialogs that move, Send back's note, link titles (rag-t0045, rag-t0046)

**Dialogs move** (rag-t0045). The shared `Dialog` in `@rag/ui` is dragged by its title bar, so every tracker dialog
(confirm, send back, ratify, approve, block, defer, remove, rename, edit, add…) and the ledger's can be moved aside
to read the page under it. Pointer events with the pointer captured (mouse, pen and touch; the header is
`touch-action: none`, so a finger drags rather than scrolls); a press on the close button is not a drag. The dialog
is a `translate` from its centred place, clamped so the whole box stays 8 px inside the viewport as it moves and
again on a window or dialog resize (`clampDialogOffset`; a box larger than the viewport on an axis is pinned to its
leading edge), and reset each time the dialog opens. A dialog's scrim is now `--rag-scrim-light` (black at 28 %, was
`--rag-shadow`'s 55 %), permanently rather than only while dragging, so the page stays legible while a decision is
being made over it; the drawer keeps the darker scrim. The keyboard is unchanged (focus on open, the Tab trap,
Escape, focus back on close); there is no keyboard move. **Send back's note box is twice as tall** (6 rows against
the note dialog's 3, `SEND_BACK_NOTE_ROWS`), on the item page and the dashboard's review rows: the reason an item
goes back is usually the longest note.

**Link titles** (rag-t0046). The item page's **Links** names each target beside its id, read from the target's own
record: an item by `GET /tracker/items/{id}?history=false`, a ledger topic by `GET /ledger/{id}` (a moved id is
followed to the topic it moved to, up to 3 hops, and says "moved to <id>"), a spec, concept or milestone by its
record in the item's project (the milestone's read also gives the document path its link opens, so it is still read
once). All are read at once and each lands on its own; the read is keyed on the links, not the record, so a re-read
after a write that leaves them alone keeps the titles without re-reading. The id is shown at once and stays the
link's name; the title fills a slot laid out from the first paint, one line cut with an ellipsis (the whole title its
tooltip), whose size never depends on the title, so nothing moves when it lands (beside the id when the row has
12rem to spare, on the next line otherwise, as at 375 px). A target that cannot be read says so, muted and in italic:
*Not found* (404), *Moved to <id>, not found*, *Title unavailable* (any other failure). **From request** does the
same, each request on its own line with its title in a fixed-width slot (`min(18rem, 55vw)`) so the meta row never
reflows; **Became** already named its tickets (rag-t0044) and is unchanged.

Measured in headless Chromium against a scratch `rag-serve` (:17896, scratch data; since stopped) at 1400 and 375 px:
the Send back dialog dragged by mouse followed the pointer and clamped at 8 px from each edge (1400: x 872, y 510 for
a 520 × 382 box in 1400 × 900; top-left 8, 8), dragged by touch at 375 px, kept focus on the dialog, closed on Escape
and reopened centred; its note box 6 rows; the scrim `rgba(0, 0, 0, 0.28)`; no horizontal scroll. The Links panel
named an item, a ledger topic, a milestone and a spec, and *Not found* for an unknown ledger id; From request named
its request. Tests: `ui/src/__tests__/dialogDrag.test.tsx` (the clamp's arithmetic; a drag following the pointer,
only while pressed and only for the pointer that started it, clamped to the viewport; the close button and a secondary
button not dragging; reopening centred; focus, the Tab trap and Escape after a drag; the lighter scrim),
`trackerItem.test.tsx` (Send back's rows twice the Confirm dialog's), `trackerLinkTitles.test.tsx`.

### Addendum, 2026-10-28: "ticket" for a queue record (rag-t0050)

The owner's request rag-t0049: the web UI calls a queue record a **ticket**: **Add ticket** and its dialog (*Add a
ticket*), the dialogs' titles (*Remove this ticket?*, *Block this ticket*, …), the queue's count, the empty states,
the label filter's tooltip, History's column and heading (*Finished tickets*), the Waits on picker and reason
(*Waits on tickets*), the link kind's label (*Ticket*), a row's accessible name (*Ticket ubu-t0042: …*), the search
page's *Document or ticket*, and the client's refusals (*A ticket needs a title.*). **The ticket page moved to
`/projects/:project/ticket/:id`**, which every link now builds (`itemPath`); `/projects/:project/item/:id` still
routes to it, so a bookmark or a pasted link keeps working. Code names (`ItemView`, `itemPath`, `Item`) and the API's
routes and fields are unchanged. Tests: the strings throughout, and `trackerShell.test.tsx` opening a ticket at
both addresses.

### Addendum, 2026-10-28: attachments on the ticket page, and the image viewer (rag-t0053, rag-t0055)

The owner's question (rag-t0053): attaching files to a ticket in review. **Every note field and every body on the
ticket page takes a file**: Add note, Send back, Confirm, block, unblock, defer, resume, the status change, ratify,
approve, withdraw (all `NoteDialog`), Edit's body and note, and Add ticket's and Add request's bodies. A paste, a
drop, or the **Attach** button under the box uploads the file (`POST /tracker/{project}/attachments`) and writes
`![name](att:…)` for an image or `[name](att:…)` for anything else at the cursor, through a placeholder
(`![Uploading name…](#uploading-N)`) while it uploads; the box says *Uploading 1 file…* and the write's button
waits. A failure removes only the placeholder: **the typed text is kept**, and the box says which file and why
(*shot.png was not attached: the disk is full*); a file over 50 MB is refused before it is sent. The code is the
documents editor's, moved into one shared module, `tracker/attach.tsx` (`useAttachments`, `AttachTextarea`,
`AttachButton`), which the editor now uses too (m04 addendum below); `NoteDialog` and `ApprovalDialog` take a
`project`.

**Notes in the history render as Markdown**, `att:` resolved, through the body's renderer and its two barriers
(`html: false`, then DOMPurify): they already did, and a test now holds it (an image inline, a `<script>` and an
`onerror` left as text). An attached image there is a **thumbnail**, at most 24rem × 12rem and on its own line;
`render.ts` wraps an attached image that is not already in a link in a link to its own file (same hex-only route,
sanitised like the rest, a new tab). **The feed and MCP are unchanged**: a note's text carries the reference, and an
agent fetches the file with `tracker_attachment_get` (`user-claude.md` says so, and that a frame may cut a long note
before its reference).

**The image viewer** (rag-t0055, from the owner's request rag-t0054): a plain click on an attached image, in a
ticket's body or history, a document, the editor's preview or the Attachments list, opens it over the whole window
(`tracker/ImageViewer.tsx`, the arithmetic in `viewerMath.ts`). It opens at 100 %, or narrower to fit the window's
width; the **wheel zooms about the cursor**, from a quarter of the opening scale (never under 5 %) to 800 %, and
`+`, `-` and `0` zoom about the middle and reset; a **left-button drag pans**, one finger pans and two pinch on a
touch screen, and the picture never leaves the window (a smaller one stays wholly inside, a larger one opens no gap
at its edge); a tall image opens at its top. **Esc**, the **X** top right or a **backdrop click** (a press that
moved less than 4 px, not on the picture) closes it; Tab stays on the close button, focus comes back to the link
clicked, the page does not scroll under it. The caption top left says the name and the zoom (*lamp · 88%*). A
modifier-click or a middle click on the image is left to its link, which opens the file in a new tab. One new
token, `--rag-scrim-viewer` (black at 90 %).

Measured in headless Chromium against a scratch `rag-serve` (:17895, scratch data; since stopped): a ticket in
review, **Send back** with a pasted 1600 × 1000 PNG wrote *The lamp is still cold. Screenshot:
![lamp](att:8563fb58a9f3)*, sent it, and the history showed it inline at 306 × 192 (1400 px) and 281 × 176 (375 px),
no horizontal scroll at either width; the Add note dialog at 375 px sat within 16–359 px with its Attach button.
The viewer opened at 88 % (1600 px into 1400), three wheel notches at (300, 300) took it to 150 % with that pixel
fixed, a 300 px drag moved it 300 px, a drag far past the edge stopped at it, Esc closed it and gave focus back to
the link; at 375 px it opened at 23 % centred, the X at 331–363 px, and a backdrop click closed it; the Attachments
list's preview opened it, and the X closed it. Tests: `trackerAttach.test.tsx` (9), `imageViewer.test.tsx` (17),
`trackerDocUnits.test.ts` (3 more: the wrapping link, a writer's link kept, nothing without attachments),
`trackerDocs.test.tsx` (Attach in the editor), `trackerClient.test.ts` (its link found by name, now the image has
one too).

### Addendum, 2026-10-29: the ticket page live

The owner's report: the ticket page did not show a change made elsewhere (an agent's status move over MCP) until it
was reloaded, while the dashboard did (its 10 s conditional poll, D14). The ticket page read the ticket once and
again only after its own writes.

**It now follows the event feed** (`api.md` § *The event feed*) rather than polling: `tracker/useFeed.ts` opens
`/tracker/{project}/events/ws?surface=any&kinds=all&format=json` on the same origin, and the page re-reads the
ticket (`GET /tracker/items/{id}`) 250 ms after any **item** event in its project, so a burst costs one read. Any
item, not only this one: a neighbour's move or create changes *In the queue*. Spec, milestone, concept and document
events are ignored. A read identical to what is on screen does not re-render, and a failed live read keeps the page
(only a first read, or a re-read after the owner's own write, shows the error). A request's *Became* rows re-read
when an event names one of them, keeping what they showed meanwhile.

The socket carries no `since`: **every open re-reads the ticket**, which covers whatever committed before the first
read or while it was closed. **Hidden, it closes**; shown, it reopens. **Down** (closed by the server, refused, a
proxy without WebSockets), it reconnects with backoff from 1 s to 30 s and **polls every 10 s meanwhile**, so it
degrades to the dashboard's behaviour, never to a page that stops updating. The dashboard keeps its poll.

**Edit now diffs against the ticket as it was when the dialog opened.** It diffed against the page's ticket, which
could not change while the dialog was up; live, an agent's body edit during the owner's title edit would otherwise
have been sent back as the owner's (the draft's old body differing from the new one).

The Vite dev proxy forwards `/tracker` with `ws: true`. Tests: `trackerItemLive.test.tsx` (9), against a fake
WebSocket every test now gets (`__tests__/fakeSocket.ts`, assigned in `vitest.setup.ts` so no test reaches a
server). Checked against the deployed `rag-serve`: the page's query upgrades (101).

### Addendum, 2026-10-30: drafts and Ctrl+S

The owner: a **draft** state for new tickets and documents, whose creation and changes are not sent on the event
feed by default, so he can write and rework records without a monitoring agent being woken by them; and **Ctrl+S**
to save a ticket or a document. The store, the feed's `drafts=true` and the routes are `api.md`'s and m01's
addenda; this is the web's half.

**The dashboard** draws a **Drafts** section (a dashed edge, the neutral grey) between Done and Requests: the
queue view's `drafts`, tickets of any type, requests included, that are in no other section. Each row carries a
**Draft** badge (dashed too: not final) and **Publish**. A queue row's menu gains **Make draft**. Both open the
note dialog (the note optional, as on every write) and send `draft: false` or `draft: true` on
`POST /tracker/items/{id}`. A draft keeps its list place, so publishing puts it back where it was. The project
picker's summary counts drafts (`2 drafts`).

**Add ticket, Add gate and Add request** each gain a second button, **Save as draft**, beside the main one; it is
the same create with `draft: true`. A button rather than a box to tick, because a draft does not land where the
main button says (*Add to the bottom*, *File the request*): the button pressed says what happens. It is drawn only
once an identity is set, since its twin already says *Set your email*.

**The ticket page** shows the Draft badge beside the approval, and while a draft a row of its own, first, with
**Publish** (the accent: the thing to do next); a published queued ticket offers **Make draft** (ghost) beside
Edit. A history entry written while the ticket was a draft (`event.draft`) carries a dashed *draft* mark, and a
create or toggle says *Draft: yes* or *Draft: no (published)*. The page's own feed asks for drafts
(`…&drafts=true`), so it still follows a draft live.

**"Draft" now means only the server state.** The editor's browser-kept text (`drafts.ts`, m04) is called
*unsaved* on screen: *New concept (unsaved)*, *Edit · unsaved*, *You have unsaved changes to this document*,
*Close (keeps your unsaved changes)*. Identifiers and the storage key are unchanged, so nothing kept is lost.

**Ctrl+S (Cmd+S)** is `tracker/saveShortcut.ts`'s `useSaveShortcut(active, save, root)`: one window listener for
every form that registers. The ticket's Edit and the three add dialogs register while open (Ctrl+S is their main
button, never *Save as draft*). The newest registration wins, so a dialog over a page saves the dialog; a modal
(`aria-modal`) that does not hold the top form blocks it, so a note or rename dialog over the editor saves nothing.
`save` is `null` whenever the button could not be pressed (nothing changed, a save in flight, an upload, no
identity): the key then does nothing, but `preventDefault` still keeps the browser's *Save Page* shut while any
form is registered. With none registered the key is the browser's. Auto-repeat is ignored.

Tests: `trackerDrafts.test.tsx` (17), `trackerItemLive.test.tsx` (the feed URL's `drafts=true`), and the
relabelled strings in `trackerDocs.test.tsx`. Web: app 667 and ui 227 tests pass; typecheck and the format check
are clean.
