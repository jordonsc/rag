# `web/` — the ledger viewer and the tracker's pages

A React SPA that reads and writes the ledger, and the tracker's queue and documents, over
`rag-serve`'s existing HTTP API. It is served same-origin by `rag-serve` in production, so there is no CORS
configuration and none should be added.

Two packages, one npm workspace:

| Package             | What it is                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ui/` (`@rag/ui`)   | The design system: tokens, components, i18n scaffold. Knows nothing about the ledger — no fetching, no endpoints, no vocabulary |
| `app/` (`@rag/app`) | The viewer itself: routing, data access, and everything that knows what a topic is                                              |

The split is worth keeping honest. `@rag/ui` takes values and callbacks from
whatever renders it; the moment a component in there knows what a `topic_id` is,
the boundary has stopped paying for itself.

## Requirements

Node 22+ and npm 10+. Everything else is in `package-lock.json`.

## Run

```bash
cd web
npm install
npm run dev            # vite dev server on :5173
```

`npm run dev` proxies the API paths — `/search`, `/ledger`, `/health`, `/info`,
`/reindex`, `/prompts`, `/tracker` — to a live `rag-serve`, so a dev session needs neither a local
Qdrant nor a Voyage key — nor an Anthropic one, since `POST /ledger/{id}/summarise`
goes over the same proxy and 503s honestly when the backend has no key. The default target is `rag-serve` on this machine;
name another host per-run:

```bash
RAG_SERVE=http://your-server:17793 npm run dev
```

## Build, test, typecheck

```bash
npm run build          # app/dist — what rag-serve serves
npm test               # vitest, jsdom — both packages
npm run typecheck      # tsc --noEmit across both packages
npm run format         # prettier over the web tree
```

`app/dist/` is the bundle `rag-serve` serves at `/`; the API keeps its existing
paths, which are excluded from the SPA fallback.

## Tests

Both packages run Vitest against jsdom with Testing Library, configured the same
way (`vitest.config.ts` + `vitest.setup.ts` in each). `npm test` at the root runs
both; either can be run on its own:

```bash
npm test --workspace ui        # the design system
npm test --workspace app       # the viewer
npm run test:watch --workspace app
npx vitest run --root app src/__tests__/markdown.test.ts   # one file
```

Nothing here talks to a server: every test that touches the network stubs
`fetch` (`app/src/__tests__/fixtures.ts` holds the double and the ledger
records), so the suite needs neither a running `rag-serve` nor a Voyage key.
Fixtures use neutral values (`example.com`, `alice@example.com`) — this is a
public repository, and a fixture is the easiest place for a real host or address
to be committed by accident.

### Test timing on a shared host

The suites run on a shared box that other work often loads well past its core
count, and the limits a test meets are wall-clock: Vitest's per-test timeout
and Testing Library's `findBy*`/`waitFor` deadline. A worker starved of CPU blows
those with no fault in the code, and each file's first test also pays about 1 s
of cold start (JIT, jsdom's first CSSOM build, the first accessible-name
computation). So both packages set the budgets at suite level, never per test:

- `maxWorkers` is half the cores, at most 4 (`vitest.config.ts`), so one run
  does not oversubscribe the box and starve itself;
- `testTimeout` is 15 s (`vitest.config.ts`);
- `asyncUtilTimeout` is 3 s (`vitest.setup.ts`), so a real hang still fails
  quickly.

A test that times out on a quiet box is a real defect, not a budget to raise.
Ledger rag-0033 (rag-t0043) has the diagnosis.

What the application suite covers, in the order it matters:

| File                            | What it defends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown.test.ts`              | The sanitiser as a security boundary: script tags, event handlers, `javascript:`/`data:text/html` URLs, SVG-borne script, entity and mixed-case evasions, malformed-tag tricks — asserted against the **parsed DOM**, not the HTML string. Plus the other failure: that code fences, tables, lists and links still render. Also the structural rule that `dangerouslySetInnerHTML` appears exactly once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `markdownSecondBarrier.test.ts` | The same module with `markdown-it` mocked to a pass-through, so DOMPurify is tested **alone**. With `html: false` in force the parser hides the sanitiser, and a sanitiser quietly reduced to a no-op would pass every test in the file above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `client.test.ts`                | Both `POST /ledger/search` response shapes; a moved id answered with a **200** pointer; the `{"error": …}` body and the 422 that has none; and the `author_agent: null` guarantee, behaviourally (what reaches the wire) and structurally (nothing but `authorFields`/`creatorFields` names those fields)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `identity.test.tsx`             | Email validation, `localStorage` that **throws** on read, write and clear, and the write gate — `useAuthor()` returning null blocks the write and opens the prompt instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `writes.test.tsx`               | All four writes: a note required whatever else is amended, `set_tags` pre-populated so an edit cannot wipe the set, `set_title`/`set_tags` omitted when unchanged, no summary editor anywhere, `repo` validated before it becomes an id, archive and restore through one endpoint, the move consequence stated before it is confirmed — and that a write is followed by a re-read or a navigation, never a re-search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `views.test.tsx`                | Each view renders, asks for the right thing and tells the truth in its empty state: no zero-query browse for live topics, a plain list for archived ones that states its own page size and warns when it filled it, and a pasted `/topic/{id}` opening the topic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `openTopic.test.tsx`            | Opening a quoted id: the bar's box on every route, Enter with no mouse, a moved id followed, a well-formed absent one answered by name — and the two things that must _not_ happen, a round trip for a malformed id and the search box taking Enter away from a search; a phase id, full or short, opening its phase page, and a missing one named there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ids.test.ts`                   | What may be minted into a topic id, how one is recognised (the final-hyphen split, so `demo-v2-0001` is the project `demo-v2`) and how one becomes a URL — plus the three structural rules that keep each of those in one module, since the defect they replace was a rule written down at one call site and not applied at the other four                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `summarise.test.tsx`            | The Summarise drawer: the model list and the default prompt read from `/info` rather than copied, what the reader edited being what is sent, the entry itself never leaving the browser, no cache (two presses, two calls), a 503 drawn as _not configured_ rather than as a fault, and a topic change clearing the summary while keeping the prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `promptLibrary.test.tsx`        | The saved prompt library: the built-in listed first and never as a saved file, a chosen prompt loading into the box and being what runs, an unsaved edit announced and never lost to a change of selection without being asked, Save on the built-in asking for a name instead of overwriting anything, a path-shaped name refused before it leaves the browser, Delete absent (not disabled) for the built-in, and a server with no prompts directory saying so while staying entirely usable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `vocab.test.ts`                 | The display tables' one promise: an unheard-of value comes back as itself, including for the names inherited from `Object.prototype`; the roadmap's words (`Phase released`, `Phase recalled`, a phase's states, a frozen ticket's statuses)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `trackerClient.test.ts`         | The tracker client: `surface: 'web'` and never an `agent` on every write (built in one module), the place of a create flattened into the body, the queue read conditional (`If-None-Match`, a 304 as `unchanged`), a 409 handed back with the current document, the velocity read (`/tracker/{project}/velocity`, a 500 as the usual error), notes optional on every change (a blank one dropped), refusals before a request leaves (a blank bare note; a blank title; a gate with no intensity; no author; over 50 MB), project names, page paths (the documents page's tab, the report's window, the tab a document goes back to), link targets, and the `att:` rewrite in rendered Markdown (opt-in, hex only); the roadmap's calls (`surface: 'web'`, no `agent`, every one `GET` or `POST`, `setItemPhase` sending nothing else, a blank `phase` never sent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `trackerQueue.test.tsx`         | The dashboard: done, the queue with its gate marker, blocked, in order and with their words; Acknowledge all done; a drag to the top as one `move` `before` the first row and elsewhere `after` the row above; nothing sent for a drag that lands where it started or is cancelled; Alt+↑ / Alt+↓; Move to top and bottom; a refused move restoring the server's order with its sentence; a drag cancelled by a changed server order; add and add gate sending `approval: "owner"` while their box is ticked (the default) and no approval when it is not; ratifying from an Agent-approved badge (click or keyboard, with or without a note, nothing sent on cancel, the badge a button for `agent` only, focus back on the row) and Approve on an unapproved queued or blocked row; a gate marker's own title (tooltip, a default title not repeated) and a row's approval on line one and no link chips on any row, the labels at line two's end, in every section (rag-t0031); Review between Done and the queue (red, a diamond, Confirm in green, Send back in amber with a note, a cancelled Confirm, the picker's count); the in-progress fill (the owner's blue, every foreground token re-pointed and measured at 4.5:1 on it and its hover, the row's buttons over the panel's dark), Done in the server's oldest-first order, Approve's `accent` class, the ratify badge's fill; hovered Approve, Unblock and ratify-pill text at 4.5:1 or better on plain, highlighted and in-progress rows and their hovers (rag-t0034); two-line rows in every section, the phone rules and a drag over taller rows; remove (note optional); Unblock sent without a note; Deferred below Blocked in teal (a blocked-and-deferred row, no section without deferred tickets), Defer from the row menu, Resume with a note, the teal token; the Parallel badge and Add ticket's box, a dependency's waits-on links under Blocked, the gate marker's phone rules (id kept, title on its own line); a done gate drawn under Done as the marker in the done green (the queue's stays purple); the 10 s poll conditional, a 304 changing nothing, and no poll while the tab is hidden; a phase chip by title, and by id when the title is unknown, on one read a page and none with no phase; `?phase=` in the URL with reordering off, and a frozen ticket in no section (spec:roadmap RM-47) |
| `trackerItem.test.tsx`          | The ticket page: the record, the body with an `att:` image resolved, links (a ledger id to its topic, a milestone looked up to its document), the history with surface and agent on each entry, ratify sending `ratified`, approve sending `owner`, status, block, defer and resume, each with or without a note; a deferred and blocked ticket drawn as deferred; Confirm (green) and Send back (amber) on a review ticket (Send back's note box twice the others' rows), and Defer on it too, Review offered on a pending one, no _Needs approval_ in the Block dialog; Add note never sent blank; an edit sending only what changed; blocking on a dependency through the Waits on picker (empty refused, itself and done tickets not offered), its waits-on links and the Parallel badge, Edit's parallel box; a frozen ticket (spec:roadmap RM-48): Block and Make draft present, only Done and Cancelled offered, no Defer, `In phase`, the Frozen badge, Pull to queue, Remove from phase and Move to phase and what each sends, planned targets refused for a ticket neither pending nor deferred, and a deferred one told the move resumes it, none on a request, the chip kept on a closed ticket, phase-mates as dependencies, the crumb going back to the phase while frozen and the project otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `trackerItemLive.test.tsx`      | The ticket page, live: the feed it opens (`surface=any`, `kinds=all`, `format=json`, `drafts=true`, `roadmap=true`); an agent's write to the ticket and a move of another shown without a reload; a burst read once, a spec event ignored; a re-read when the socket opens; a failed live read keeping the page; Edit diffing against the ticket as it opened, so a change made meanwhile is not sent back; closed while hidden and reopened; reconnect after a drop and the 10 s poll while down; `roadmap=true` on the URL, and a stamped event refreshing a frozen ticket's page. The socket is `fakeSocket.ts`, installed for every test by `vitest.setup.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `trackerKeptText.test.tsx`      | Text in a dialogue closed without a decision (2026-11-01): Esc and the X keep a note for the same action on the same record, not another action; it is what a later send sends, and a send or Cancel removes it; read back from the browser after a remount; an upload finishing after the close lands in its text; storage refused still holds the text while open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `trackerDrafts.test.tsx`        | Drafts and Ctrl+S (2026-10-30): Drafts above Requests and out of the queue, with a Draft badge; Publish and Make draft from the dashboard, the ticket page and a document (each sending exactly its `draft`); Save as draft on Add ticket, Add request, Add gate and New concept, the main button sending none; drafts in a project's summary; Ctrl+S and Cmd+S saving the editor from outside its text box, the ticket's Edit and Add ticket (never as a draft), doing nothing with nothing changed, without an identity or behind a modal, and leaving the browser alone with no form open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `trackerScroll.test.tsx`        | Scroll memory (rag-t0040): what is a return (a back, a link carrying the return, a reload) and what is fresh; the storage per key, guarded; the restore only once the rows are drawn and only once, so the 10 s refresh never moves the page; the dashboard by the ticket's crumb and by back, History, the Documents tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `trackerLinkTitles.test.tsx`    | Link titles (rag-t0046): each kind's target named beside its id (ticket, ledger, spec, milestone, concept) with the id still the link's name, read in parallel (one held back holds up no other) into a slot already laid out, a moved ledger id followed, a muted line for not found, moved away and unreadable, From request named, and the titles kept, not re-read, across a re-read after a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `trackerCopy.test.tsx`          | Copying the ticket's id (rag-t0042): the clipboard in a secure context, the hidden-textarea `execCommand('copy')` over plain http and when the clipboard refuses, "Copied", the keyboard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `trackerShell.test.tsx`         | The tracker in the shell: **Tracker** going to the last project or the project list, the brand naming the section, the picker, and opening a project by name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `trackerDocs.test.tsx`          | The documents pages (m04): concepts by state (archived folded) and specs with their milestones; a document rendered with its `att:` image and its record; a relative link and a root path opening the other document in place; a rename's redirect followed and said; a pasted image uploaded and its reference written **at the cursor**; no upload for a text paste or without an identity; a save sending the whole body with its base revision; a **stale save** keeping the user's text, showing the newer revision's diff and who saved it, and Overwrite resending against the new revision; Discard mine; unsaved text restored after a remount, kept when a save fails and flagged when it is older than the document; the history's revisions, author, agent and diff; Restore with or without a message; New concept; the way back to the documents page (rag-t0059): a spec's and a milestone's link back opens Specs, a concept's Concepts, a free document's Other, an unreadable spec's Specs, and the browser's Back from a spec opened under Specs returns there; the search view's tracker corpus, a phase hit routed to the phase's page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `trackerVelocity.test.tsx`      | The velocity widget (spec:velocity m02): the concept's example read exactly, each figure a `Stat` named and reading `Velocity: 8/day`, `In progress: 3`, `Pending: 48`, `ETA: 7 days`, its value an element apart from its label and unit (rag-t0062), directly under the header and above the first section; Report opening the report page in the window shown (m03); the pill moving Velocity and ETA between 7 d and 24 h, the counts staying put; the window kept across a remount, rubbish kept read as 7 d, storage that throws read as 7 d and still switching; `2.4/day` under 10, `12/day` from 10, `0/day` for exactly 0; `ETA: done`, `—` read as `ETA: unknown`, and a fractional ETA worded from hours up (`1.6 days`, `32 hours`, `1 hour`); the tooltips (active hours, in review, blocked, deferred); a failed refresh keeping the last figures, a failed first read drawing no row and no error; no row for a project with no counted ticket, a row for one with only deferred ones; the 60 s refresh (fake timers), paused while hidden, and a re-read when the queue's view changes but not on a 304                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `trackerFormat.test.ts`         | The figures' wording of lengths (rag-t0062): one decimal below 5, whole from 5, half away from zero; the unit moving up past 1.5 of the next (90 minutes, 36 hours, 10.5 days, 1.5 months), the boundaries staying put; the owner's examples (`32 hours`, `1.6 days`, `1.6 weeks`, `6 weeks`, `4.6 months`; 16 days as `2.3 weeks`); singular for one; `<0.1` for a sliver; the ETA from hours, `done` and `—`; the report's lengths from minutes. The same cases as the MCP's `format_eta` and `duration` tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `trackerReport.test.tsx`        | The velocity report page (spec:velocity m03), the time zone pinned to Melbourne: `report?window=7d` by default and `24h` from `?window=`, which wins over the kept choice (rubbish reads as 7 d); the pill re-reading, writing `?window=` and keeping the choice; the widget's figures across the top as tiles, each named and reading as label and value (`Done: 20 tickets`, its active time its tooltip; `ETA: 4.6 months` from 140 days); the burn-down in seven local days in its hidden table on either window; time in each state's hidden table and the still-open chips, each named in full; MTTC, done without being in progress, MTTR and confirmed against sent back as tiles, each read as one sentence (rag-t0062); `No tickets were done in the last 7 days.` under the chart of an empty week, read from the week's bars and not the window's Done; a failed read with Retry; the back link to the queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `trackerReportCharts.test.tsx`  | The report's arithmetic and charts (m03): hourly UTC buckets summed into Melbourne days across a UTC midnight; day labels; whole-number ticks for 0, 7, 48 and 1 000, fractional ones for the hours axis; `BurnDown` and `RangeBars` each carrying their numbers in a hidden table and on each mark's `<title>`, no bar for a zero, and an all-zero series drawn as an empty chart with its axis, never NaN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `trackerRoadmap.test.tsx`       | The Roadmap tab (spec:roadmap m04): the project tabs wrapping within their column and compact on a phone, so 360 px never scrolls sideways; each figure in words and tiles (`Queue ETA: 6 days`, `Frozen: 45 tickets`, `Planned out`, `Velocity`), a null ETA drawn `—` and spoken `unknown`, each ETA's tooltip; the pill the widget's own (`rag.tracker.velocityWindow`) and passing `window`; released progress in the answer's order; planned rows with frozen, drafts and cumulative ETA; a drag and Alt+↑ / Alt+↓ as one `move` `before` or `after`, a dropped row shown until the server answers, nothing sent for a cancelled drag; a server order changing mid-drag cancelling it and a figures-only read not; Complete and Archived folded, Unarchive; an empty roadmap; New phase; a first read's `ErrorState` and a later failure keeping the figures; the feed's `roadmap=true`, one read a burst, the 60 s refresh, none hidden; the tab on every project page; no "item", and no "queued" of a frozen ticket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `trackerPhase.test.tsx`         | A phase's page (spec:roadmap m04): the drafts counted as `1 draft` and `2 drafts`; the title and body, Ctrl+S saving on the spot and sending only what changed; a phase of another project named in an `ErrorState`; frozen rows sortable with no Defer, Publish on a draft and Make draft on the rest; a frozen gate's marker saying Draft or Blocked; Add ticket and Add gate sending `phase`, kept text per phase; released rows grouped with counts, Done and Cancelled folded, a failed ticket given a group; Release's words, count, drafts apart, `would_wait` and placement sent; Recall's counts from `tickets`; `waiting` from the answer shown; Archive's refusal in the server's words; the author gate; the history folded with `eventKindLabel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trackerDocUnits.test.ts`       | The pure parts of the documents pages: link resolution (relative, `..`, `specs/` and `concepts/` from the root, and everything that is not a document link left alone), slugs, the line diff (including the walk back through interleaved edits and the folded context), the server's unified diff parsed, the guarded draft store, and the renderer's document links (same tab, opt-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `trackerDocRename.test.tsx`     | rag-t0003, against a stateful fake server: **Rename…** on a document (path, title and note sent with `surface: 'web'`, the concept retitled too when ticked, the page moved to the new path, and a reload at the **old path** redirecting with both writes in the History tab); the title alone when the record box is unticked; a bad path, a blank title and an unchanged rename never sent; a taken path's refusal kept in the dialog; the record's refusal after the rename said on the page; the identity prompt instead of the dialog. The Specs tab: a spec's title with its document's, a milestone's alone, no document rename when it already has the title; **Move up** as two order writes with their notes and the focus kept; a refused move said with the server's order shown; the identity prompt instead of a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `trackerLabels.test.tsx`        | Labels (rag-t0027): the client's rules (trim, 32 characters, no comma or control character, ten at most, the project's casing, case-insensitive merging) and its refusals before a request; the chips at line two's right end, apart from the assignee, and no link chip on the row (rag-t0031), each a filter link; the dashboard's `?label=` filter (case-insensitive, gates kept, reordering off, the select setting and clearing the URL, the empty state, no select without labels); Add ticket's editor (a quick-add button, typed text in another casing split on a comma, a refused label, a label left in the box sent, none sent without labels); the ticket page's labels, history row and Edit sending the set wholesale; History's filter and chips                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `trackerMilestoneOrder.test.ts` | A milestone move's writes: a swap with each one's note, the server's sort whatever the arrival order, no move past an end, a renumber when tied orders would make a swap land elsewhere (the two that change places always written), and 300 random lists with ties each landing exactly one place over; `isDocPath` accepting and refusing what the server's `validate_path` does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `markdownStable.test.tsx`       | Rendered prose keeps its DOM when its parent re-renders: React 19 compares `dangerouslySetInnerHTML` by identity, and a fresh object per render replaced a link between press and release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `trackerAttach.test.tsx`        | Files on the ticket page (rag-t0053): a paste in Send back, a drop in Add note, Attach in Confirm and a paste in Edit's body each upload and write the `att:` reference at the cursor; a failed upload and a file over 50 MB keep the typed text and say which file and why; the write waits for an upload; a history note renders its image inline, linked to the file, with raw HTML left as text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `imageViewer.test.tsx`          | The image viewer (rag-t0055): the opening fit, zoom about a point and its limits, pan clamping, the wheel's factor; which clicks open it (not a modifier or middle click); opening from Markdown and the Attachments list, Esc, the X and a backdrop click closing it (not a click on the image or a drag), focus kept and returned, the wheel zooming and a drag panning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`app/src/__tests__/sources.ts` is the helper the structural assertions use — the
handful of guarantees that are properties of the codebase rather than of any one
function, and that fail by a _new_ line appearing somewhere else.

The design system's own suite (`ui/src/__tests__/`) covers components in
isolation and knows nothing about the ledger, which is the same boundary the
packages keep at runtime. `tintContrast.test.ts` resolves the tinted buttons'
colours from `tokens.css` and `Button.module.css` (jsdom applies no CSS) and
holds their text at 4.5:1 at rest and on hover on the page, the panel, a hovered
row and the in-progress row's tint and hover. `dialogDrag.test.tsx` holds a
dialog's drag (rag-t0045): the clamp as arithmetic (`clampDialogOffset`), and
pointer drags against a stubbed box, since jsdom has no layout.

## The application

### Routes

| Route        | What it is                                                                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Search over **live** topics. Query and filters live in the query string (`?q=&repo=&type=&status=`), so a result set is a link you can send someone. `corpus=tracker` searches the tracker's documents and tickets instead (`POST /search` with `corpus: "tracker"`); a hit opens its document or ticket |
| `/topic/:id` | One topic, whole: header, the immutable `summary`, the current state, the event timeline and the typed links. `/topic/rag-0009` is the point of the whole viewer — an id an agent quoted, opened from the bar or pasted straight in                                                                      |
| `/archived`  | The soft-deleted set, listed newest first. An optional box narrows it by substring, server-side. Each row restores from here                                                                                                                                                                             |
| `/new`       | Create a topic — the only place a `summary` is ever set                                                                                                                                                                                                                                                  |

| `/projects` | The tracker's project list, with what is waiting in each, and a box to open one by name |
| `/projects/:project` | A project's **dashboard**: done, review, the queue, blocked, deferred. See _The tracker_ below |
| `/projects/:project/ticket/:id` | One tracker ticket, whole; the older `/projects/:project/item/:id` still opens it (rag-t0050) |
| `/projects/:project/docs` | A project's **documents**: concepts by state, specs with their milestones, other documents, attachments (`?tab=`) |
| `/projects/:project/docs/new` | **New concept**: title, slug and first text in the editor |
| `/projects/:project/doc/*` | One document by its path (`…/doc/specs/audio/m03-music.md`): view, edit (`?tab=edit`), history (`?tab=history`) |
| `/projects/:project/roadmap` | A project's **roadmap**: its figures, released and planned phases, complete and archived folded. See _The tracker_ below |
| `/projects/:project/roadmap/:id` | One **phase**: title and body, frozen tickets, released tickets by status, Release or Recall, Archive, history |
| `/projects/:project/history` | A project's **history**: done (acknowledged or not), cancelled and failed tickets, newest first, filtered by status, type and text (`?status=&type=&q=`); a row opens the ticket page, which has Reopen |

**Search is at `/`, and cannot move to `/search`.** `rag-serve` reserves
`/search`, `/ledger`, `/health`, `/info` and `/reindex` and excludes them from
the SPA fallback, so that a mistyped endpoint stays a JSON 404 rather than
quietly returning an HTML page. A client route with one of those names would
never survive a refresh or a pasted link — in production or behind the dev
proxy, which mirrors the same list. Check any new route against it. The same rule
is why the tracker's pages are at `/projects/…`: `/tracker/…` is its API
(ledger rag-0035).

### Opening a quoted id is the primary journey

An agent writes `demo-0001` into a commit message, a chat log or another topic's
prose, and somebody wants to read it. Everything else here — search, the archive
listing — is a way of finding an id you were _not_ given, so the direct route
gets the prominent affordance:

- **The top bar carries an id box on every page** (`ledger/OpenTopic.tsx`), the
  tracker's included since 2026-10-30, when it also learned to open a **ticket**
  (`demo-t0001`, its ticket page) and a **document** (`demo-d0001`, looked up, then
  opened at its path; a missing one is named), and since spec:roadmap m04 a **phase**
  (`demo-p0001`, its phase page, which names a missing one). The bar reads Search,
  Tracker, Archived. On a project's pages it takes a short id too (2026-10-31):
  `t1630` means that project's `-t1630`, likewise `d0003`, `l0077` and `p0002`.
  including the topic page, where the next thing a reader does with an id is
  usually to follow another one. Type or paste, press Enter, arrive. It was
  previously only on the 404 page — an affordance you found by first getting
  lost — and that page now renders the same component rather than its own copy.
- **The search box recognises an id and offers a direct route**, as a strip above
  the results reading _Open `demo-0001`_. It does **not** take Enter: submitting
  still searches, because "what mentions `demo-0001`" is a real question — an id
  is quoted in other topics' prose and in `supersedes` links.

Three answers, and the shape rule is what makes the third cheap:

| The id                        | What happens                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| exists                        | `/topic/{id}` renders it                                                                                             |
| was retired by a **move**     | `GET /ledger/{id}` answers **200** with a `{moved, moved_to}` pointer; `TopicView` follows it and says what happened |
| is well-formed but **absent** | the topic page names it — _There is no topic `demo-0404`_ — with the bar's box still there to try another            |
| is **malformed**              | the box says so before any request, and states the shape                                                             |

`ledger/ids.ts` owns that shape rule alongside the two it already held.
`parseTopicId` splits `{repo}-l{seq:04}` (the form minted since rag-t0051) and
the legacy `{repo}-{seq:04}` alike at the **final** hyphen, because a project
name may contain hyphens and digits of its own (`demo-v2-0001` is the project
`demo-v2`, `shq-suite-l0012` the project `shq-suite`), and four digits is the
server's `format_topic_id` minimum rather than a width — a project past 9,999
topics keeps minting ids. A tracker id (`demo-t0042`, `demo-d0007`) is not a
topic id.

**The route itself stays permissive**, and deliberately: `POST /ledger` does not
validate `repo` (an empty one mints `-0001`), so the ledger can hold ids this
recogniser rejects. They remain reachable by pasted address and get an honest
answer from the server; only the boxes a person types into apply the rule, and
only to skip a round trip that could not have succeeded.

### There is no browse-everything view, and the UI says so

`POST /ledger/search` requires a non-empty query for live topics: retrieval is
an embedding against a vector index, not a table scan, and a search costs an
embed + ANN + rerank round trip of roughly a second. So the landing state is a
search prompt rather than an empty table, and the search fires on submit rather
than on a keystroke.

The archive is the exception, for a structural reason: an archived topic is
purged from the index and kept in SQLite, so that listing is a `LIKE` over a
table with no embedding involved — which is why it needs no query and can be
ordered by date.

**That listing asks for an explicit page size and says when it filled it.**
`POST /ledger/search` applies its own `LIMIT 50` when `top_k` is absent and
reports `count` as the length of that page, so a caller that omits it is handed
a truncated list that describes itself as complete. `ArchivedView` sends
`ARCHIVE_PAGE` rows and, when exactly that many come back, renders a notice
saying the list is a window — and that the narrowing box is not limited to it,
because the `LIKE` runs server-side ahead of the `LIMIT`. A bigger number is not
the fix; it moves the same lie further away.

### The four writes

The viewer is a first-class ledger client: it can do everything an agent can
through the ledger tools, and **nothing more**. All four live in
`app/src/writes/`, and all four go through `app/src/api/client.ts`.

| Write             | Endpoint                    | Where it is                                                      |
| ----------------- | --------------------------- | ---------------------------------------------------------------- |
| Append + amend    | `POST /ledger/{id}/append`  | The form at the foot of `/topic/:id` (`AppendPanel`)             |
| Create            | `POST /ledger`              | `/new` (`CreateView`)                                            |
| Archive / restore | `POST /ledger/{id}/archive` | The topic header, and every row of `/archived` (`ArchiveDialog`) |
| Move              | `POST /ledger/{id}/move`    | The topic header, behind a confirmation (`MoveDialog`)           |

**Append is the only way to amend.** `set_state`, `set_status`, `set_title`,
`set_tags` and `supersedes` all ride on an event, and the event's note body is
**required whatever else it does** — the server rejects a blank one and so does
the form. That is the shape of the feature rather than a validation detail: a
topic's status can be read off the topic, but _why_ it moved exists only if
somebody wrote it down at the moment they moved it.

Three consequences the interface has to state before the button is pressed,
because none of them are undoable by re-editing a field:

- **`set_tags` replaces the tag set wholesale.** `[]` clears it; absent leaves
  it. The form pre-populates the topic's current tags for exactly that reason —
  a `ChipList` that started empty would let someone add one tag and silently
  delete the other four.
- **`supersedes` changes a _different_ topic**, flipping it to `superseded` and
  linking the two in both directions. The form says so under the field, as soon
  as the field holds an id.
- **Move mints a new id and retires the old one.** The old id keeps working as a
  pointer — `GET /ledger/{old}` answers with a redirect rather than a 404, and
  `TopicView` follows it — but no commit message, comment or chat log quoting it
  is updated. It is a confirmation with that sentence in it, never a dropdown.

**`summary` is not amendable and has no field anywhere.** There is no
`set_summary` on any code path in the server, and adding one to serve a UI
convenience would be the one change here that destroys evidence: a topic framed
wrongly is worth more than one tidied to match its outcome. `/new` is the only
place a summary is ever written, and it says so at the point of writing.

`/new` also shows what it is about to produce rather than making the reader
submit to find out: the id the project name will mint (`{repo}-l0001`), and the
status the chosen type defaults to (`decision` → proposed, everything else →
open). `repo` is validated client-side as well as on the server, because it is
interpolated straight into the id and from there into a URL.

**Nothing is optimistic.** Every write is followed by a re-read of the topic by
id, never a patch of local state: the server decides the event id, the
timestamp, whether a status transition was legal, and what `supersedes` did
elsewhere. A client that merged its own request body into the record would be
drawing a plausible fiction, and the one place it diverged is the place nobody
would think to check.

**A failed write says so, in the server's own words.** `{"error": …}` is
rendered as-is. The exception is a **422**, which is axum rejecting the body
before the handler runs — plain text, not the error shape — so the client
supplies the sentence and keeps the framework's text as the detail, where the
missing field name still shows.

### Writes are gated on an identity, and the control never hides

`useAuthor()` returning `null` is the whole gate; there is no session and
nothing to ask the server. What follows is easy to get backwards, so it is a
house rule: a write control belonging to a reader with no identity set is
**shown and enabled**, and pressing it opens the identity prompt instead of
writing. Hiding it would suggest the application cannot do the thing; disabling
it would leave a dead control and no way to work out what would revive it.

The gate lives in `app/src/writes/gate.ts` — one hook, and the two sentences
(identity needed, index lag) that must read the same wherever they appear.

### Writes lag the index

A write hits SQLite immediately, so `GET /ledger/{id}` reflects it at once; the
vector index reconciles through a trigger file and takes ~30 s–3 min. After a
write, navigate to the topic **by id** — re-running a search that cannot yet see
the change reads as the write having failed.

No view here re-searches after a write, and the interface says the rest out loud
rather than leaving it to be discovered: the append form's confirmation, the
create form's commit row, the archive and restore confirmations and the archive
listing's own note all name the lag in the same words.

### Identity

`rag-serve` has no notion of a caller. `author_email` is a required body field
on every write and is never checked, which matches the rest of the system's
trusted-LAN posture. The viewer therefore holds a self-asserted address in
`localStorage`, validated only for shape, and shows it in the top bar where it
can always be changed. Reads need no identity at all, so nothing prompts on a
first visit; the prompt happens at the point of a write.

`author_agent` is **always** sent as null. A null agent is what marks a write as
a person's rather than an agent's, so the fields are built in one place
(`api/client.ts`'s `authorFields`) and typed as `null` rather than
`string | null`, which makes populating it a compile error rather than a review
comment.

### Summarise: the one LLM call, and the only optional feature

A ledger entry written by an agent runs to thousands of words. The **Summarise**
tab — a handle fixed to the right edge of `/topic/:id`, opening a `Drawer` — asks
a model to compress the one on screen. `app/src/summarise/`, one endpoint:

```
POST /ledger/{id}/summarise   { "model"?: "...", "system_prompt"?: "..." }
  ->  { summary, model, usage: { input_tokens, output_tokens }, truncated }
```

Five things about it that are decisions rather than details:

- **The key is optional and lives only on the server.** `rag-serve` reads
  `ANTHROPIC_API_KEY`; absent, the route answers **503** and `/info` reports
  `summarise_ready: false`. The browser is told that one boolean and nothing
  else. When it is false the tab **stays visible and explains itself** — the same
  house rule as the write controls with no identity set, and the same sentence
  in both places it can be met (`summarise_ready: false` up front, or a 503
  after).
- **The endpoint takes an id, never content.** The server loads the topic
  itself. A body carrying the prose would be the client re-sending what the
  server already has, and would turn the route into a general-purpose LLM proxy
  for anyone who can reach the port, billed to whoever owns the key. The models
  are an allow-list checked server-side, for the same reason.
- **The model list and the default prompt come from `/info`.** Both are
  constants in `crates/core/src/anthropic.rs`; the picker and the prompt box are
  reads of them, not copies. So what a reader sees in the box is exactly what
  would run if they left it alone, and the two cannot drift. The prompt is
  editable before every press — _summarise this_ and _list only what changed_ are
  different questions of the same entry — with one click back to the default.
- **Nothing is cached, at either end**, and there is no backfill. Two presses are
  two calls and can produce two summaries. A stored summary would go stale the
  moment somebody appended to the topic and the staleness would be silent, which
  is worse than the penny a run costs. The token counts are drawn under the
  summary because that is the only place the price of a press is ever stated.
- **The summary is untrusted output.** The model has just read prose written by
  any unauthenticated client on the LAN, so what comes back renders through
  `markdown/render.ts` like every other ledger string — see below. Server-side,
  the instruction goes in the `system` field and the entry travels as a
  delimited **user** message; it is never concatenated into the system prompt.

#### The prompt library

The instruction box is prefilled from `/info`, but one instruction is not enough,
so the drawer also offers a **chooser** of saved prompts —
`app/src/summarise/PromptChooser.tsx`, three endpoints:

```
GET  /prompts          -> { configured, prompts: [ { name, body } ] }
POST /prompts/save        { name, body }   ->  { name, body }     (an upsert)
POST /prompts/delete      { name }         ->  { name, deleted }
```

Four rules, each of which could reasonably have gone the other way:

- **A prompt is a Markdown file on the server** (`~/rag/prompts/{name}.md`) — no
  database, no ids, no metadata. The chooser and a text editor are two views of
  one directory, which is why a name is restricted to letters, digits, spaces,
  `-` and `_`: it has to survive a round trip through a filename.
- **The built-in default is not a file and is not in the list.** It comes from
  `/info`, sits at the top of the chooser, and has **no Delete** — absent rather
  than disabled, because it is not a thing that could be deleted. Saving an
  edited version of it asks for a name, since there is nothing to write over.
- **An unsaved edit is never lost silently.** The box says so while it differs
  from the saved body, offers one press back, and switching selection asks
  before discarding. An edit still _runs_ perfectly well — the box is what gets
  sent, saved or not.
- **The name check here is a courtesy, not the barrier.** `POST /prompts/save`
  writes a file on a service with no authentication; the real guard is
  `crates/serve/src/prompts.rs` (allow-listed names, containment re-check,
  `.md` only, no symlinks, capped body and count). The client mirrors it only so
  a person is told what to type before a round trip. A server with no prompts
  directory answers `configured: false`, and the drawer then offers the built-in
  alone and draws no Save it cannot honour.

Changing topic clears the summary and keeps the reader's model and prompt, which
is why the panel is not keyed by id at its call site the way `AppendPanel` is: a
`key` would throw away all three, and the model and the prompt are the reader's
settings rather than the entry's.

### Rendered Markdown is sanitised in exactly one place

Event bodies, `summary` and `current_state` are agent-written Markdown, and the
ledger accepts writes from any client on the LAN with no authentication. Every
rendered string goes through `app/src/markdown/render.ts`: `markdown-it` with
`html: false`, **and** DOMPurify over the result. Two independent barriers,
deliberately — `html: false` is one option on one constructor call, and nothing
would fail if a later edit flipped it. `dangerouslySetInnerHTML` appears in
`app/src/markdown/Markdown.tsx` and nowhere else, which is what makes the
guarantee checkable with a grep.

The module exports **one** function, and that is part of the same property: an
uncalled second renderer is a second code path an audit has to reason about and
a ready-made call site for somebody who has not read the module header. There is
a third barrier outside the bundle — `rag-serve` sends a
`Content-Security-Policy` with the document (`crates/serve/src/web.rs`), which is
the only one of the three enforced by the browser rather than by the code that
might be got wrong.

## The tracker

`app/src/tracker/` is the tracker's half of the application (`specs/tracker`,
m03 the dashboard, m04 the documents; the HTTP contract is `specs/tracker/api.md`). Its writes follow the
ledger's rules above: the identity gate prompts rather than hides
(`tracker/gate.ts`), nothing is optimistic, and a failure is the server's own
sentence.

| File                                                         | What it is                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api.ts`, `types.ts`                                         | The client for **every** m01 route — the queue, tickets, documents, revisions and diffs, specs, milestones, concepts, attachments — typed from `api.md`. The documents pages (m04) build on it as it stands                                                                                                                                                                                                  |
| `paths.ts`                                                   | The pages' addresses (`/projects/…`), link targets, `att:` URLs, the last project used                                                                                                                                                                                                                                                                                                                       |
| `useQueue.ts`                                                | The dashboard's live read: every 10 s while the tab is visible, conditional, newest request wins                                                                                                                                                                                                                                                                                                             |
| `useVelocity.ts`, `velocity.ts`, `VelocityBar.tsx`           | The velocity widget (spec:velocity m02): its read (`GET /tracker/{project}/velocity`, on mount, on a new queue view, every 60 s while visible), its wording (rates, and lengths in minutes to months, rag-t0062) and tooltips, the window kept in `localStorage`, and the row under the dashboard's header                                                                                                   |
| `Stat.tsx`, `stat.module.css`                                | A key figure, designed (rag-t0062): `Stat` as a report tile (large value, small muted label, unit muted, details under) or inline in the widget's row (label muted, value emphasised), named and reading as "Label: value"; `SplitStat`, two counts and a thin split bar (confirmed against sent back)                                                                                                       |
| `ReportView.tsx`, `charts.tsx`, `reportMath.ts`              | The velocity report (spec:velocity m03) at `/projects/{project}/report?window=`: the figures as tiles, Burn-down, Time in each state (with still-open chips), Completion and resolution as tiles, read from `GET /tracker/{project}/report` beside the velocity; the hand-drawn SVG charts (`BurnDown`, `RangeBars`) with a hidden table each; hourly UTC buckets summed into local days, labels, nice ticks |
| `QueueView.tsx`, `QueueList.tsx`, `RowMenu.tsx`, `parts.tsx` | The dashboard: sections (Done, Drafts, Requests, Review, the queue, Blocked, Deferred), Add request, two-line rows (`SecondLine`, `FlatRow`), gate markers, drag, the row menu (Defer, Make draft), the row's approval control (ratify from the badge, Approve), Confirm and Send back, Publish, a marker's gate title, the Parallel and Draft badges, a dependency's waits-on chips                         |
| `RoadmapView.tsx`, `PhaseList.tsx`, `useRoadmap.ts`          | The Roadmap tab (spec:roadmap m04): the figures as `Stat` tiles, released phases with progress, planned phases as a sortable list (`PhaseList`, the queue's drag and keys over phases), Complete and Archived folded; the read (`GET /tracker/{project}/roadmap?window=`, the `useVelocity` shape, plus `refresh()`)                                                                                         |
| `PhaseView.tsx`, `phaseTitles.tsx`, `roadmap.module.css`     | A phase's page: title and body, frozen tickets (`QueueList`), released tickets by status, Release, Recall, Archive; a ticket's `PhaseChip`, the page's one read of every phase's title (`PhaseTitlesProvider`), and the queue's phase filter                                                                                                                                                                 |
| `useFeed.ts`                                                 | A page's live read of its project's event feed (`/tracker/{project}/events/ws`, JSON frames, drafts and roadmap events included): each event to the page, a resync on every open, reconnect with backoff and a 10 s poll while down, closed while hidden. The ticket, roadmap and phase pages follow it; `useFeedRefresh` is the plain form, one settled re-read a burst                                     |
| `ItemView.tsx`, `ItemActions.tsx`, `linkTitles.tsx`          | The ticket page and its writes; a request's Became panel, a ticket's From request; each link's title read from its target's record (rag-t0046)                                                                                                                                                                                                                                                               |
| `dialogs.tsx`                                                | The note dialog every noted write uses (the note optional, labelled so; required for Add note alone), the approval dialog (ratify, approve), Add ticket, Add gate, Add request (each with Save as draft), Publish, Make draft, and the roadmap's New phase, Release, Recall and Move to phase                                                                                                                |
| `saveShortcut.ts`                                            | Ctrl+S / Cmd+S: one window listener, the latest active form wins, a modal over a form blocks it, the browser's Save Page never opens while a form is registered                                                                                                                                                                                                                                              |
| `DocsView.tsx`, `NewConceptView.tsx`                         | The documents page (concepts by state, specs and milestones with Edit title and Move up / down, other documents, attachments) and New concept                                                                                                                                                                                                                                                                |
| `DocView.tsx`, `RecordPanel.tsx`, `docParts.tsx`             | A document: rendered, its record (state, approval, a concept's links, a spec's milestones) and their writes, Rename…, the View / Edit / History tabs, a rename's redirect                                                                                                                                                                                                                                    |
| `RenameDialogs.tsx`, `milestoneOrder.ts`                     | Rename… (a document's path and title) and Edit title… (a spec's or milestone's), each offering to change the other title too; a milestone move's order writes (rag-t0003)                                                                                                                                                                                                                                    |
| `DocEditor.tsx`, `drafts.ts`                                 | The editor (markdown beside a live preview; pasted and dropped files become attachments; Ctrl+S saves) and the unsaved text it keeps in this browser (`drafts.ts`: the name predates server drafts)                                                                                                                                                                                                          |
| `DocHistory.tsx`, `diff.ts`                                  | Revisions with their diffs, an old body, Restore; the line diff a stale save is drawn with                                                                                                                                                                                                                                                                                                                   |
| `Attachments.tsx`                                            | A project's attachments: preview, size, type, uploader, the `att:` reference to copy, Upload                                                                                                                                                                                                                                                                                                                 |
| `HistoryView.tsx`                                            | The History page (rag-t0008): done, cancelled and failed tickets, newest first, with status, type and text filters                                                                                                                                                                                                                                                                                           |
| `scrollMemory.ts`, `CopyButton.tsx`                          | A list page's scroll kept for the way back (rag-t0040); copying a reference, with the plain-http fall-back (rag-t0042)                                                                                                                                                                                                                                                                                       |

Decisions that are easy to undo by accident:

- **Writes carry `surface: 'web'` and no `agent`.** The tracker refuses unknown
  fields, so the ledger's `author_agent: null` must never reach it; `web` is
  what marks a write as the owner's (D10). `trackerAuthor` in `tracker/api.ts`
  builds the fields, and a test holds it to being the only place.
- **Reordering is one `move` per gesture, never a position.** A drop at the top
  is `before` the first row; anywhere else `after` the row above it — the rows
  _as drawn_, so a blocked ticket sitting between them in the list is never
  disturbed. Alt+↑ is `before` the row above, Alt+↓ `after` the row below; the
  menu's Move to top and bottom are `top` and `bottom`. Drag is pointer events
  on the grip (`touch-action: none`), so mouse, pen and touch are one code
  path; Escape cancels.
- **The one optimistic pixel.** A dropped row is drawn where it was dropped
  until the server answers the move; then the list is the server's again,
  whichever way it answered. A refusal says so, in the server's words, with
  _The list shows the server's order_. A refresh that brings a different order
  in the middle of a drag cancels the drag rather than dropping it against
  neighbours that may have moved.
- **A list page restores its scroll once, after its rows** (rag-t0040). The
  dashboard, History and Documents keep their scroll in `sessionStorage` per
  project (`scrollMemory.ts`) and put it back on a return only: a back or
  forward, a reload, or a link carrying `RETURN_STATE` (the ticket page's crumb,
  a document's link back, the project tabs). Anything else opens at the top. A
  new link back to a list page should carry `RETURN_STATE`.
- **The velocity row reads its own route, beside the queue** (spec:velocity
  m02; D11–D15 in `specs/velocity/master.md`). `useVelocity` reads
  `GET /tracker/{project}/velocity` when the dashboard opens, again whenever
  `useQueue` brings a different view (its `revision`; a 304 is not a change,
  nor is the first view), and every 60 s while the tab is visible, since the
  windows move with the clock; hidden, it stops. A failed read keeps the last
  figures, and a first read that fails draws nothing: the queue's banner speaks
  for a dead server. The row is drawn only when the project has a counted
  ticket (`remaining + deferred + windows.7d.done > 0`). The pill (`Segmented`,
  **7 d** | **24 h**) moves Velocity and ETA only, never the counts, and the
  choice is kept for every project in `localStorage`
  (`rag.tracker.velocityWindow`, guarded; anything but `7d` or `24h` reads as
  `7d`). Wording, in `velocity.ts` so the report (m03) says it the same way: a
  rate is a whole number from 10, one decimal under (`2.4/day`), and a whole
  number when one decimal would be (`8/day`, `0/day`). The ETA (`eta_days`,
  fractional since rag-t0062) is worded as a length from hours up
  (`durationParts`: one decimal below 5, whole from 5, half away from zero;
  the unit moves up once the value is over 1.5 of the next, so `32 hours`,
  `1.6 days`, `1.6 weeks`, `6 weeks`, `4.6 months`; singular for exactly one),
  `done` for nothing remaining and `—` (read "unknown") when the velocity
  is 0. The MCP line words it with the same rule (`format_eta` in
  `crates/mcp/src/tracker.rs`), pinned by the same cases. Each figure is a
  `Stat` (`Stat.tsx`): the label muted and the value emphasised on one row,
  named and reading "Velocity: 8/day"; its tooltip is its native `title`. **Report**
  opens `/projects/{project}/report?window=` in the window the row shows
  (`REPORT_READY = true` in `VelocityBar.tsx` since m03).
- **The report is a page of its own, and its charts are hand-drawn SVG**
  (spec:velocity m03; D16–D20, C6, C7). `ReportView.tsx` reads
  `GET /tracker/{project}/report?window=` and the velocity (for the counts
  now) in parallel, on open and on each change of window; it is not polled.
  The window is `?window=` when the address names one, else the widget's kept
  choice, and the pill writes both. **The burn-down does not follow it**: it is
  always the last 7 days (owner, 2026-11-03). The server's buckets are hourly in
  UTC, and the page sums them into the **browser's local days**
  (`reportMath.ts` `localDays`: `added` and `done` summed, `remaining` the
  day's last hour), so a day ends at the reader's midnight, and an hour that
  straddles a half-hour zone's midnight counts on the day it starts in.
  `charts.tsx` draws `BurnDown` and `RangeBars` as inline SVG at the
  container's measured width (`ResizeObserver`; 640 where there is none, as
  in jsdom), colours from the tokens only, a `<title>` on every mark, and a
  visually hidden `<table>` of the same numbers under each, so the picture is
  never their only carrier. **No chart library**: three charts do not justify
  a dependency. Lengths read by the ETA's rule from minutes up (`formatElapsed`
  in `velocity.ts`: `42 minutes`, `90 minutes`, `1.5 hours`, `2 days`,
  `1.8 weeks`). The figures across the top and Completion and resolution are
  `Stat` tiles (rag-t0062): a large value, a small muted label, the unit
  muted, the median and the count as details, in a grid that wraps to two
  columns on a phone; confirmed against sent back is a `SplitStat` with a
  thin bar. What is still open in each state is a chip each, named in full
  ("Pending: 2 still open, the oldest 5 days"). The charts' captions run the
  panel's full width (capped at a measure, they wrapped short of the chart
  and read as cut off).
- **A document's link back opens the tab that lists it** (rag-t0059).
  `docsTabOf` in `paths.ts`: a spec or milestone goes back to
  `/docs?tab=specs`, a concept to `/docs` (Concepts, the default), a free
  document to `?tab=other`, and a document that could not be read by its path
  (`specs/…` to Specs). Without the tab, the link landed on Concepts, and the
  scroll memory restored Concepts' position rather than Specs'. The documents
  page's tabs are in the address, so the browser's Back already returned to
  the tab the reader left.
- **The roadmap: frozen means frozen** (spec:roadmap m04; R1-R8, D19, D24, D25,
  D29 in `specs/roadmap/master.md`). A **Roadmap** tab follows Queue at
  `/projects/{project}/roadmap`, and a phase has a page at `…/roadmap/{id}`.
  Nothing on either dispatches work, and neither calls a frozen ticket queued.
  The figures (**Queue ETA**, **Frozen**, **Planned out**, **Velocity**) are
  durations of active work, never dates (D24): an ETA is worded as the widget
  words one (`etaParts`, `—` read as unknown) and carries the widget's tooltip
  (`ETA_TOOLTIP`), and the pill is the widget's own choice, the same
  `rag.tracker.velocityWindow`. `useRoadmap` reads on mount, on a new `viewKey` or
  window, and every 60 s while visible (none hidden); a failed read keeps the last
  figures, and a first failure leaves `null` for the page's `ErrorState`. Both
  pages also re-read on any feed event, settled to one read a burst at
  `LIVE_SETTLE_MS` (`useFeedRefresh`).
- **The web's one feed reader asks for `roadmap=true`, always** (D19), as it does
  `drafts=true`: stamped events are out of the default feed, a frozen ticket's page
  must follow its own edits, and a frozen draft's events carry both flags, so it
  needs both. The ticket page's handler is unchanged: it ignores a `phase` target,
  and its one settled re-read a burst makes a release of forty cost one read.
- **`PhaseList` is its own component**, not a generalised `QueueList`, which is
  bound to tickets through its row, menu and approval. It has the same drag, Escape
  and Alt+arrows and the same one optimistic pixel, over `PhaseFigures`, sharing
  `placeFor`. **Its `revision` is the server's order as a string**, not a read
  counter: every read brings new figures, and only a change of order may cancel a
  drag. A phase's frozen list is `QueueList` with the same kind of key. Its row menu
  has no Defer (`onDefer` omitted: D5), and Publish in place of Make draft on a
  draft, since the server refuses a write that changes nothing.
- **The phase on a row is one read a page, not one a row** (RM-47; R6). The ticket
  carries the phase's id and no title, so that listing the queue needs no join.
  `PhaseTitlesProvider` holds `id → title` from one `useRoadmap`, and `PhaseChip`
  looks its id up, reading the id when it has no title (not read yet, or the read
  failed). `enabled` is whether the page has a ticket with a phase, so a project
  with no roadmap makes no such read. On a phase's own page `omit` drops the chip:
  every row there is that phase's. The queue's **phase filter** is `?phase=<id>`, as
  `label` is, and client-side: the options are the phases the view's tickets name,
  gates stay through it, and reordering is off. `GET …/items` is the one read that
  takes the parameter, and a blank `?phase=` is a 404, not "no filter" (rag-l0099),
  so `listItems` never sends one.
- **Release and Recall state what they will do, then what they did** (RM-46). The
  counts come from the page's `tickets`, read with the phase: Release's are the
  frozen ones, drafts stated apart (they stay drafts), Recall's the `pending` ones,
  blocked or a draft or neither, against those in progress or review. Each lists
  `would_wait` under _Left waiting across the boundary_, each id a link; it warns and
  never refuses. **After the write, the answer's `waiting` is what is shown**, in a
  notice on the page beside what moved, whether or not it matches `would_wait`, so a
  phase that changed under the dialog cannot leave a stale warning standing. A
  released ticket's group is by `dotState`, and a **failed** ticket has a group of its
  own, which RM-45's list omits: it is still in the queue, and has to appear.
- **A frozen ticket's page reads `frozen` wherever it read `queued`** (RM-48), since
  `queued` is false while frozen: Block and Unblock, Make draft (D6, D16), the
  dependency picker, whose list also reads the phase's own tickets
  (`GET /items` leaves frozen ones out, and they are the common dependency), and
  _In phase_ in place of _In the queue_. Its status goes only to done or cancelled
  (`offeredStatuses`), which is a courtesy: the store is the guard. **`setItemPhase`
  is kept apart from `updateItem`**, its body built field by field, because `phase`
  and `frozen` are single-purpose writes (D8): the server refuses anything else
  beside them, so a stamped event cannot hide a status change. **Move to phase**
  lists the planned and released phases, each the ticket's status rules out offered
  disabled with its reason (`phaseMoveRefusal`), and says what the chosen one will do,
  including that a deferred ticket stops being deferred when it freezes (D4).
- **The poll is conditional and stops when hidden.** `If-None-Match` with the
  last `ETag`, `cache: 'no-store'` so the 304 reaches the code rather than the
  browser cache answering it, and no timer while `document.visibilityState` is
  `hidden`; showing the tab refreshes at once.
- **The ticket page is live through the event feed**, not a poll (the owner,
  2026-10-29). `useProjectFeed` opens
  `/tracker/{project}/events/ws?surface=any&kinds=all&format=json` and the page
  re-reads the ticket 250 ms after any item event in the project (a burst is
  one read): its own events, and its neighbours' moves, which change what
  _In the queue_ says. A read identical to what is shown does not re-render; a
  failed live read keeps the page. Every socket open re-reads, since nothing is
  replayed. **Edit diffs against the ticket as it was when the dialog opened**,
  so an agent's change made while it is up is never sent back as the owner's.
  The dev server proxies `/tracker` with `ws: true` for this.
- **Reordering is off while the unratified filter is on**: the hidden rows are
  neighbours too, and the menu's top and bottom still work.
- **The owner approves from the dashboard row** (rag-t0009). An
  _Agent-approved_ badge, in any section, is a `<button>` (named
  _Agent-approved: ratify <id>_) that opens the same ratify confirmation as the
  ticket page's **Ratify**; every other approval stays a plain badge. An
  unapproved row in the queue or under Blocked carries **Approve** (`owner`);
  Done rows do not, as approving finished work records nothing useful. Both go
  through `ApprovalDialog` in `dialogs.tsx`, which the ticket page uses too, the
  note optional; the row re-reads after and the keyboard is put back on the row
  (the badge it was on is gone).
- **New work starts owner-approved** (rag-t0010). Add ticket and Add gate each
  have _Create it owner-approved_ (`Checkbox` from `@rag/ui`), ticked by default
  and again each time the dialog is reset: the owner adding work is the owner's
  approval. Ticked sends `approval: "owner"`; unticked sends no `approval`, so
  the server's default (`unapproved`) applies.
- **Requests are the owner's, and `became` is the server's** (rag-t0044).
  _Add request_ (the header, not the queue's buttons) sends `type: "request"`
  with a title and the request text, owner-approved by default; the Requests
  section lists the view's `requests` between Done and Review and is drawn only
  when there are some. A ticket's `from` link is shown as _From request_ and a
  request's `became` links as its _Became_ panel, neither under Links. The
  Edit dialog never offers `became` (`addableLinkKinds`), nor `from` on a
  request, and draws no remove on a `became` link: the server writes and
  removes it with the ticket's `from`, and refuses a body naming it.
- **Renames and titles have two halves** (rag-t0003). A spec, milestone or
  concept has a title, and its document has its own; the server keeps them
  apart. **Rename…** on a document (`POST /tracker/docs/{id}/rename`: path,
  title, note) offers to retitle its record too, ticked when the two still
  agree; **Edit title…** on the Specs tab offers to retitle the document,
  ticked by default, and reads the document first so an equal title is not
  sent. Each half is its own write and event. When the first lands and the
  second is refused, the dialog closes on what happened and the page says what
  did not. A new path moves the page there as a redirect does, and the old path
  keeps opening it.
- **A milestone move is order writes, not a position** (rag-t0003). The API
  sorts by `order`, then code, and has no move: `milestoneOrder.ts` swaps the
  orders of the milestone and the neighbour it passes, or, when ties would make
  a swap land elsewhere, renumbers 1…n writing what changes plus the two that
  change places (an unchanged order with a note is a note event). Each write
  carries a note (_Moved up, before m01._), sequentially; a refusal stops the
  rest, says so, and the re-read shows the server's order. The buttons are off
  until the re-read lands, and the focus goes back to the button pressed (or its
  twin at an end).
- **`att:` references render only where asked.** `renderMarkdown(source,
{ attachments: true })` rewrites an image source or link that is exactly
  `att:` and 12–64 hex characters to `/tracker/attachments/<hex>`, on parsed
  tokens before the sanitiser runs; the ledger's prose never asks.
- **"Draft" means a server record not yet published** (2026-10-30): a ticket
  or document with `draft: true`, whose changes the feed leaves out unless asked
  (`drafts=true`), and which nothing dispatches. The dashboard draws such
  tickets under **Drafts** (above Requests) and nowhere else; **Publish** sends
  `draft: false`, **Make draft** `draft: true` (a ticket through
  `POST /tracker/items/{id}`, a document through `POST /tracker/docs/{id}/draft`);
  Add ticket, Add gate, Add request and New concept have **Save as draft** as a
  second button, not a box, because a draft does not land where the main
  button says. The page's own feed (`useFeed.ts`) asks for drafts, so the
  owner's open ticket still follows them. **Text typed and not yet saved is
  called _unsaved_ on screen**, never a draft; `drafts.ts` and its storage key
  keep the old name, so nothing kept before is lost.
- **Ctrl+S (Cmd+S) saves** (2026-10-30, `saveShortcut.ts`): the document
  editor from anywhere on its page, the ticket's Edit, New concept (Create
  concept, not the draft) and the add dialogs (their main button). **In the
  editor and the ticket's Edit it saves on the spot and stays open** (2026-10-31),
  where their Save buttons close; New concept creates and goes on in the
  document's editor; the add dialogs submit and close. It does nothing while the
  Save button cannot be pressed (nothing changed, a save in flight, an upload, no
  identity), but the browser's Save Page is kept shut either way. The most recently opened form
  wins; a modal over a form (a rename, a note) takes the key from it.
- **Nothing typed into a document is lost.** The editor keeps a draft in
  `localStorage` (`rag.tracker.draft:<project>:<doc id>`, guarded: a browser that
  refuses storage gets a warning, not a failure) on every change and when the
  page is left, with the revision it was written against; only a successful
  save or the reader's own _Discard_ removes it. A **stale save** (409) never
  replaces the editor's text: the newer revision's diff against it is shown,
  with who saved since, and **Overwrite** resends the same text against the new
  revision; **Discard mine** asks first. A draft older than the document is
  restored as it was and saved through the same conflict view.
- **A pasted, dropped or attached file** is uploaded and its reference
  (`![name](att:…)`, or `[name](att:…)` for a non-image) written at the cursor
  through a placeholder; Save waits while an upload is in flight. Dropped files
  go to the cursor too, not to the drop point. One implementation,
  `tracker/attach.tsx` (`useAttachments` with its `dropZone`, so a drop lands on the
  box's bar too and anywhere on Add request's form, `AttachTextarea`, `AttachButton`;
  rag-t0053), serves the documents editor, a ticket's body (Add ticket, Add
  request, Edit) and every note field (`NoteDialog`: Add note, Send back,
  Confirm, block, defer, ratify, remove…; Edit's note; the documents pages'
  rename, title and links notes), each with an **Attach** button. A failed
  upload removes only its placeholder: the typed text stays, and the box says
  which file and why (the 50 MB cap is checked before sending).
- **Notes in a ticket's history are Markdown** with `att:` resolved, through
  the same renderer and sanitiser as the body. An attached image there is a
  thumbnail (at most 24rem × 12rem); `render.ts` wraps every attached image
  not already in a link in one to its own file, which a modifier-click, a
  middle click or a page without script follows.
- **The image viewer** (`tracker/ImageViewer.tsx`, `viewerMath.ts`;
  rag-t0055): a plain click on an attached image (a ticket's body or history,
  a document, the editor's preview, the Attachments list) opens it over the
  whole window at 100 %, or narrower to fit the width; the wheel zooms about
  the cursor (a quarter of the opening scale to 800 %), `+`, `-` and `0` zoom
  about the middle and reset, a left-button drag pans (never past the
  picture's edge), one finger pans and two pinch on a touch screen. Esc, the
  X top right or a backdrop click (not a drag) closes it; Tab stays on its
  close button and focus goes back where it was. `Markdown` opens it only with
  `attachments` set, so ledger prose is untouched.
- **Links between documents resolve as the repository did.** In a document,
  `renderMarkdown(source, { documentLinks: { project, from } })` rewrites a link
  with no scheme ending in `.md` to its page: `/…` and `specs/…`, `concepts/…`
  from the project's root, anything else from the document's own folder; `..`
  above the root, or a character no document path holds, leaves it as written.
  Those links open in the same tab, and `DocMarkdown` turns a plain click on one
  into a router navigation.
- **`dangerouslySetInnerHTML` gets one object per string** (`Markdown.tsx`):
  React 19 compares the prop by identity, and a new object per render rewrote
  the prose on every parent render, replacing a link between press and release.
- **The History page is the way back to a finished ticket.** Nothing is
  deleted (Remove cancels), but the dashboard stops drawing a ticket once it is
  cancelled, or done and acknowledged. `/projects/:project/history` reads
  `GET /tracker/{project}/items?status=` for `done`, `cancelled` and `failed`
  in parallel and filters on the client; it is not polled. **Only `done` has a
  time of its own** (`done_at`): a cancelled or failed ticket is placed by
  `updated_at`, its last change, and the page says so (_(last change)_ on the
  stamp and in its note), so a note written after a cancel moves the ticket up.
  Adding a cancel time would be a server change (a column, or reading events
  per ticket) that the page does not need.
- **One theme.** The design system has one dark `:root` (see below); the
  tracker uses its tokens. The status colours are R12's: `good`, `acc`,
  `bright`, `crit`, `warn`, and `teal` for deferred (rag-t0017: the one token
  the tracker added, chosen to stay apart from in progress's blue and done's
  green); `acc2`, a light grey since 2026-11-03, captions the velocity row's
  figures, since `acc` is the link colour; gates are drawn in `extra`, the one accent no status
  uses. Review (rag-t0024) shares failed's `crit`, the owner's choice: its word
  and its diamond dot (failed keeps the disc) tell them apart.
- **Review is its own section, above the queue** (rag-t0024). The queue
  view's `review` array is drawn as **Review** between Done and the queue, red,
  each row with **Confirm** (`status: "done"`) and **Send back** (`status:
"in_progress"`, back to its place), the note optional; the ticket page has the
  same two on a review ticket. A ticket in review and blocked is drawn under
  Review with its block beside it (`dotState` lets review win). The block
  reason `approval` (_Needs approval_) is gone from the Block dialog: the
  server refuses it, and the status replaced it.
- **Rows are two lines** (rag-t0026). Line one: status, id, title (the free
  width), then the approval and the section's actions; the menu in the queue.
  Line two (`SecondLine`): type, assignee, the Parallel badge or a block's
  reason and waits-on, then the labels at the right. No row draws link chips
  (rag-t0031): a ticket's links are on its page; waits-on stays, as the
  block's reason. Gate markers stay one
  line. The status and the type each sit in a slot as wide as the widest word
  of their kind (a hidden stack of every word under the visible one, so
  exact in any font or scale) and the
  assignee, cut with an ellipsis rather than wrapped, follows it, so every
  assignee on the page starts at one x: a Done, Review, Blocked or Deferred row
  leads with the room the queue's grip takes (rag-t0033). An in-progress row is
  tinted a dark navy across both lines: `--rag-inprogress-row`, the owner's
  blue `--rag-inprogress` (#0b61ac) at 20% over the panel, and
  `--rag-inprogress-row-hover`, 28%, on hover (rag-t0023, rag-t0029,
  rag-t0033: an 11% tint of `acc`, then a solid fill, both wrong). Its words,
  badges and buttons keep the palette's colours, each at least 4.5:1 on both.
  Done is drawn in the server's order, oldest first (rag-t0029). The
  row's **Approve** is the tinted `accent` button and
  the ratify badge is filled amber at rest (rag-t0025): a `ghost` or unfilled
  control takes the row's hover colour and vanishes under the pointer.
- **Deferred is its own section, not a kind of blocked** (rag-t0017). The
  queue view's `deferred` array is drawn as **Deferred** below Blocked, teal,
  each row with **Resume** (`status: "pending"`, back to its place); a queue
  row's menu and the ticket page offer **Defer** (`status: "deferred"`). A ticket
  both deferred and blocked is drawn under Deferred with its block beside it
  (`dotState` lets deferred win over blocked). The History page leaves deferred
  out: it is still queued.
- **Parallel is a badge and a box, not a place** (rag-t0013). A parallel ticket
  stays below its gate in the queue, where it lands; its row carries a neutral
  **Parallel** badge, and Add ticket and the ticket page's Edit have the box
  (unticked by default; never on a gate). `tracker_next` is what offers it
  early, not the dashboard.
- **Waits on** (rag-t0018). A row blocked with reason `dependency` (_Waits on
  tickets_) shows each ticket it waits on as a chip linking to its page, under
  Blocked, under Deferred and on the ticket page. The ticket page's Block dialog
  offers a **Waits on** picker for that reason, over the project's other
  queued tickets, read from `GET /tracker/{project}/items` only when the reason
  is chosen; an empty choice is refused in the client. The unblock when the
  last one is done is the server's: the page just re-reads.
- **A frozen gate says what a row says** (spec:roadmap m04). A marker is one line
  with no second line to hold a badge, and the queue's list has no draft or blocked
  gate, but a phase's frozen list has both, so `GateMarker` draws the Draft badge and
  the blocked state itself.
- **The gate marker on a phone** (rag-t0019). Below 40rem the marker's label
  takes the row and wraps: name, Release, state and id on the first line, the
  gate's title on its own line, cut with an ellipsis. The id is never hidden.
  jsdom has no layout, so the test pins the CSS rules; the layout itself was
  measured once in headless Chromium at 375 px (title 234 px wide, no
  horizontal scroll).
- **A done gate under Done** (rag-t0021) is the queue's marker line, not a
  row: `GateMarker` (exported from `QueueList.tsx`) draws the rules and the
  label for both, and its `done` variant sets `--marker-colour` to the done
  status's `--rag-good` in place of the queue's `--rag-extra` purple. It has
  no grip or menu there and links to the ticket page as done rows do. History
  keeps gates as plain rows.
- **Labels** (rag-t0027). A ticket's labels are rounded chips (`LabelChips` in
  `parts.tsx`) at the right end of a row's second line, where the link chips
  were (rag-t0031; they wrap, and a long one is cut with an ellipsis), each a
  link to the dashboard filtered to it (`?label=Physics`); the ticket page lists
  them in its header and each change in its history. The dashboard's **label
  filter** is a select of the labels the view's tickets carry, held in the URL
  and matched case-insensitively; it keeps the queue's gates (the batch still
  shows) and turns reordering off, as _Unratified only_ does. History has the
  same `?label=` filter, its chips filtering History itself. **The editor**
  (`LabelEditor.tsx`, Add ticket and the ticket page's Edit) is the design
  system's `ChipList` with its `suggestions` (a native `datalist`) fed from
  `GET /tracker/{project}/labels` when the dialog opens, plus the project's
  eight most used labels as one-click buttons. Typed text is split on commas,
  put in the project's casing and checked as the server checks it
  (`labels.ts`); text left in the box is committed through the `ChipList`
  handle on submit. The labels are sent wholesale, and by Edit only when the
  set changed.

## The design system

`ui/src/tokens.css` is the whole theme: one `:root` block of custom properties,
no light/dark axis and no provider. A component names a token, never a colour.
Import it once at the application root.

**The tinted controls' shares are tokens (2026-10-27, rag-t0034).** The `accent`
and `caution` buttons and the tracker's ratify pill fill with
`--rag-tint-acc` / `--rag-tint-warn` of their colour at rest (14 %, 16 %) and
`--rag-tint-acc-hover` / `--rag-tint-warn-hover` (24 %, 26 %; the pill's hover
was 30 %) under the pointer or keyboard focus, and on hover their text takes
`--rag-tint-lift` (35 %) of `--rag-bright`: the same hue, paler. The deeper fill
alone put the text under WCAG AA's 4.5:1 on a row's hover ground (4.45:1 on a
plain row's `--rag-surface2`, 4.0:1 on an in-progress row's). Lifted, the worst
case is 5.1:1 (the accent on the in-progress hover, `#152e44`), measured in
headless Chromium as well as in `tintContrast.test.ts`. A deeper hover share or
a smaller lift is what fails first.

A third tint, **`good`** (rag-t0041), is the done green for a control that
finishes something (the ticket page's Confirm): `--rag-tint-good` and
`--rag-tint-good-hover` (14 %, 24 %, the accent's shares) and the same lift.

**A dialog moves (2026-10-27, rag-t0045).** `Dialog` (and so `ConfirmDialog` and
every tracker and ledger dialog built on it) is dragged by its title bar, with a
mouse, a pen or a finger: pointer events with the pointer captured, and
`touch-action: none` on the header so a finger drags rather than scrolls. A press
on the close button is the button's. The dialog is a `translate` from where
layout centres it, clamped so the whole box stays 8 px inside the viewport
(`clampDialogOffset`, exported; a box larger than the viewport on an axis is
pinned to its leading edge, title bar on screen) as it moves and again when the
window or the dialog resizes, and it is reset each time the dialog opens. Its
scrim is `--rag-scrim-light` (black at 28 %) rather than `--rag-shadow` (55 %),
so the page under a dialog moved aside stays legible; the drawer keeps the
darker one. The keyboard is unchanged: focus to the dialog on open, the Tab
trap, Escape, focus back on close.

Icons are a fixed registry (`ui/src/icons/registry.ts`) over `lucide-react`.
Names arrive as strings — a column declares one, a nav item declares one — so a
bundler cannot see which glyphs are reachable; naming them in one table is what
keeps the bundle to the icons actually drawn. Adding a glyph is one import and
one row.

Strings the components draw for themselves resolve through `ui/src/i18n`;
`en-GB` is the only catalogue. Application strings belong to the application.
