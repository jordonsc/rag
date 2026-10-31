m04: documents in the web UI
============================
**State: Done** (2026-10-27; acceptance 1–3 on the server's UI pending the release). Spec: [`master.md`](master.md), D4, D8, D9, D16, R13, R14. **Build
from [`api.md`](api.md)**, the HTTP contract m01 built.

*Written before rag-t0050 (2026-10-28) named a queue record a **ticket**: this milestone's plan, its as-built and
the addenda before that date keep the word *item* as they were written. The API keeps `item` ([`api.md`](api.md)).*

Where the owner writes concept documents and reads and edits specs.


Work items
----------
| WP | Work | Size | Files |
|---|---|---|---|
| TC-01 | **The documents page** (D16), `/projects/:project/docs` (not under `/tracker/`, the API's: [`api.md`](api.md) § *Web UI paths*): **Concepts** by state (open, refining, refined, archived) with **New concept** (title, slug, first body); **Specs**, each with its state and milestones (code, title, state, approval) | M | `web/app/src/tracker/DocsView.tsx` (new) |
| TC-02 | **The document page**, `/projects/:project/doc/*path`: the document rendered (`att:` images resolved; a relative link to another document's path opens it); the record's state, approval and links with their actions (a concept's state and links; a spec's or milestone's state and approval); a redirect followed and shown | M | `DocView.tsx` (new) |
| TC-03 | **The editor**: a markdown text area with a live preview side by side (stacked on a narrow screen); an image **pasted or dropped** uploads as an attachment and inserts its `att:` reference at the cursor; Save sends the whole body with its base revision and a message; a **stale save** (409) shows the newer revision's diff against the user's text and keeps the user's text, with **Overwrite** (save again against the new revision) and **Discard mine**; an unsaved draft survives a reload (`localStorage`, guarded) | M | `DocEditor.tsx` (new) |
| TC-04 | **History**: the revisions with author, agent, surface, time and message; any one's diff against the one before (a line diff, additions and deletions coloured); **Restore** (asks for a message) | S | `DocHistory.tsx` (new) |
| TC-05 | **Attachments list** per project: name, size, type, uploader and when, a preview for an image, and its `att:` reference to copy | S | `Attachments.tsx` (new) |
| TC-06 | **Docs**: `web/README.md` (the documents views) | S | as listed |


Tests
-----
* The documents page lists concepts by state and specs with their milestones from a fixture.
* A pasted image uploads and its `att:` reference appears at the cursor.
* A save against a stale revision shows the conflict with both texts kept; Overwrite resends with the new revision.
* A draft is restored after a remount; a successful save clears it.
* The history shows each revision and its diff; Restore calls its route.
* A rendered `att:` image's `src` is the attachment's route; a link to `specs/audio/m03-music.md` opens that
  document's page.


Acceptance
----------
1. The owner writes a new concept in the browser with two pasted images, saves it, edits it again, and sees both
   revisions and their diff.
2. An agent edits the same concept through `tracker_doc_edit` while the owner has it open in the editor; the owner's
   save is refused as stale and shows the agent's change, and nothing is lost.
3. A spec with milestones created through the MCP tools shows on the Specs tab and each document opens.
4. `npm test` and the typecheck pass.


TC-07 (the manager's decision, moved from m05's TS-02)
-----------------------------------------------------
**The web UI's search can filter to the tracker corpus**: a **Corpus** choice (Ledger, Tracker) on the search view,
`corpus=tracker` in the address. Built against `POST /search` with `"filters": {"corpus": "tracker"}` (and `repo`
for a project), which m05 landed in `crates/serve` alongside.


As built
--------
2026-10-27. Code in `web/app/src/tracker/`: `DocsView.tsx` (TC-01), `NewConceptView.tsx`, `DocView.tsx` and
`RecordPanel.tsx` (TC-02), `DocEditor.tsx` and `drafts.ts` (TC-03), `DocHistory.tsx` and `diff.ts` (TC-04),
`Attachments.tsx` (TC-05), `docParts.tsx` (the rendered document, the line diff, the Queue / Documents switch);
`paths.ts` gains `resolveDocLink`, `slugify`, `isSlug`, `newConceptPath`; `vocab.ts` the record states and document
kinds; `api.ts` `searchTracker` (TC-07); `dialogs.tsx`'s `NoteDialog` a `noteHelp`. Routes in `App.tsx`; the
dashboard's head gains the Queue / Documents switch. `markdown/render.ts` gains opt-in document links,
`markdown/Markdown.tsx` a stable `__html` object (below); `views/SearchView.tsx` the corpus filter; seven glyphs in
`web/ui/src/icons/registry.ts`. Tests: `trackerDocs.test.tsx` (21), `trackerDocUnits.test.ts` (15),
`markdownStable.test.tsx` (2). Docs: `web/README.md` (routes, tests, § *The tracker*), `README.md` § *Tracker*,
`CLAUDE.md`'s routing table.

Checked by hand against a scratch `rag-serve` (scratch data, port 17894) in headless Chrome over CDP: a new concept
written with **two pasted images** (both uploaded, referenced at the cursor, previewed and rendered), saved, edited
again, its two revisions and their diff read (acceptance 1); an agent edit through the API while the editor was
open, the owner's save refused as stale with the agent's change in the diff and the agent named, the owner's text
intact, Overwrite saving it (acceptance 2's server half); a spec with two milestones created through the API listed
on the Specs tab, a relative link in its master opening the milestone (acceptance 3's server half); a draft restored
after a reload; no horizontal scroll at 375 px on the documents page, the editor, the history and the attachments.
Acceptance 1–3 on the deployed UI, with the MCP tools themselves, wait for the release.

Choices the spec left open, made in keeping with its intent (ledger rag-0048 drafts and conflicts, rag-0049 links,
rag-0050 pages; rag-0047 the defect):

* **Four tabs, not two** (D16 names Concepts and Specs): **Other documents** (kind `doc`, created through MCP, would
  otherwise be unreachable) and **Attachments** (TC-05's list needed a home). The tab is in the address
  (`?tab=specs`).
* **New concept is a page** (`/projects/<project>/docs/new`), not a dialog: it is where the owner writes at length,
  so it gets the editor, its preview, paste-to-attach and a draft (the title and slug are a sibling draft). The
  slug follows the title until typed; the create's `note` is the editor's message.
* **A document's View / Edit / History are tabs in the address** (`?tab=edit`), so a reload in the editor comes back
  to it with its draft. Entering a tab re-reads the document, so Edit starts from the newest revision.
* **Drafts** (`rag.tracker.draft:<project>:<doc id>`, guarded `localStorage`) are written 300 ms after a change and on
  leaving the page, with the base revision; only a successful save or the reader's *Discard* removes one. A
  browser that refuses storage gets a warning. A draft older than the document keeps its own base, so saving it
  goes through the same conflict view as any stale save; the page flags an unsaved draft on its Edit tab.
* **The stale save** keeps the editor's text untouched and shows the newer revision's **line diff against it**,
  made in the browser (the server never saw the user's text; a Myers diff, `tracker/diff.ts`), with who saved each
  revision since (a revisions read). **Overwrite** resends the same text against `current_revision`; **Discard
  mine** confirms, then loads the newer text. Nothing is merged.
* **Pasted and dropped files**: images become `![name](att:…)`, anything else `[name](att:…)`; a placeholder holds the
  cursor's place while it uploads, and Save waits. A drop inserts at the cursor, not the drop point. Without an
  identity nothing uploads and the editor says why. The editor is a plain monospace `textarea` (not the design
  system's) so it can size to the pane.
* **Document links** (rag-0049): a link with no scheme ending in `.md` resolves from the project root when it starts
  `/`, `specs/` or `concepts/`, otherwise from the document's folder; it opens in place. `docs/…` paths (still in the
  repository) land on a page that says the tracker does not hold them.
* **A rename's redirect** replaces the address (Back does not bounce) and says *<old> was renamed*.
* **The record's writes** are the item page's: *State…* (a note optional since 2026-10-27; it was required), *Approve* (`owner`), *Ratify* (`agent` →
  `ratified`), *Withdraw approval*, and on a concept *Links…*. Spec and milestone titles, order and document renames
  are not offered (the spec does not ask for them; MCP has them). *Superseded 2026-10-27 by rag-t0003, below.*
* **History** shows revisions newest first with author, agent, surface, message and size; *Diff from N−1*, *View* (the
  body as it was) and *Restore…* (a message optional since 2026-10-27; it was required) on each but the current; below them the activity of the
  document and its record (state, approval, link, rename events; the `edit` events are the revisions).
* **Attachments** show an `<img>` preview for any `image/*` (an SVG in an `<img>` runs no script), the uploader and
  agent, and a copy button for the `att:` reference (the reference is also selectable when the clipboard is
  refused); **Upload** adds files without writing them into a document.
* **Defect found and fixed** (rag-0047): `Markdown.tsx` passed a new `{ __html }` object every render, and React 19
  compares it by identity, so every parent render rewrote the prose's DOM. On the document page the record arrives
  after the body and the link under the pointer was replaced before the click landed. The object is now memoised;
  `markdownStable.test.tsx` fails without it.
* **The search view's corpus** (TC-07) hides the ledger's type and status filters when the tracker is chosen (the
  `/search` route takes neither); a tracker hit shows its title, citation, kind and project, and opens its document
  or item.

### Addendum 2026-10-27: renames, titles and milestone order (rag-t0003)

The documents pages now offer what the bullet above left to MCP, all through the existing API (no server change),
every write `surface: web`:

* **Rename…** on a document's page (`DocView.tsx`, `RenameDialogs.tsx`): its title and path, and an optional note,
  as one `POST /tracker/docs/{id}/rename`. The path is checked as the store checks it (`isDocPath` in `paths.ts`) and
  an unchanged rename is not sendable. A new path moves the page there as a redirect does (*<old> was renamed*), and
  the old path keeps opening the document (the server's redirect).
* **Edit title…** on the Specs tab, for a spec or a milestone (`POST …/specs/{slug}[/milestones/{code}]` with
  `title`), and **Move up** / **Move down** on a milestone.
* **Two titles.** A spec, milestone or concept and its document each have a title, which start equal and which the
  server keeps apart. Each dialog offers to change the other one too (Rename…: ticked when the two still agree; Edit
  title…: ticked, and the document is read first so an equal title is not sent), as a second write with its own
  event in that record's history. If the first lands and the second is refused, the dialog closes and the page says
  what was not done.
* **A move is order writes** (`milestoneOrder.ts`): the milestone and the neighbour it passes swap `order`s, each
  write with a note (*Moved up, before m01.*, *Moved down, after m03.*). When tied orders would make a swap land
  somewhere else, the spec's milestones are renumbered 1…n, writing those that change and always the two that change
  places (an unchanged order with a note is a note event). The writes run in turn; a refusal stops the rest and is
  said with the server's order shown. Not atomic: the API has no move for milestones, and a half-made move is
  visible and repairable with the same buttons, so a new route was not added.

Tests: `trackerDocRename.test.tsx` (12, against a stateful fake server: a rename's writes, the page moving, a reload
at the old path redirecting with both writes in History; title writes; moves, a refused move, the identity prompt;
negatives for a bad path, a blank title and an unchanged rename) and `trackerMilestoneOrder.test.ts` (8, including
300 random lists with ties). Web: app 490 and ui 200 tests pass; typecheck and the format check are clean.

### Addendum 2026-10-28: Attach in the editor, the image viewer (rag-t0053, rag-t0055)

The editor's paste and drop code moved into `tracker/attach.tsx`, shared with the ticket page's bodies and note
fields (m03's addendum of the same date); the editor's behaviour is unchanged, and its Markdown pane's head gains an
**Attach** button beside *Paste or drop a file to attach it*. The documents pages' own note fields (rename, title,
a concept's links) and `NoteDialog`'s (state changes, restore) take files the same way. A plain click on an
attached image in a document, the editor's preview or the **Attachments** list (its preview is now a button,
*View <name>*) opens the image viewer (`tracker/ImageViewer.tsx`): 100 % or fitted to the width, wheel zoom about
the cursor, drag to pan, Esc, the X or a backdrop click to close. Checked in headless Chromium with the m03 check.

### Addendum, 2026-10-30: drafts and Ctrl+S in the documents pages

The web's half of the owner's draft state (m03's addendum of the same date; the store's in `api.md`). A document's
page shows a **Draft** badge beside its state while `draft` is true, with **Publish** (accent) before *Rename…*; a
published one offers **Make draft** (ghost) after it. Both open the note dialog and send
`POST /tracker/docs/{id}/draft` with `{draft, note?}`. A concept's draft-ness is its document's. The documents
page's concept and other-document rows carry the badge. *Amended the same day (owner):* a spec's or a milestone's
document offers neither Publish nor Make draft, and the Specs tab shows no Draft badge, since a spec has its own
`draft` state and is agent-driven; the Specs tab now opens with a line saying so, *Specs are agent-created
documents, refined from a concept.*, as the Concepts tab's does. **New concept** gains **Save
as draft** beside *Create concept* (the editor's `offerDraft`; its `onSave` now takes `asDraft`), creating the
concept with `draft: true`.

**Ctrl+S (Cmd+S) works anywhere on the editor's page**, not only in its Markdown box (TC-03 had it there): the
editor registers with `useSaveShortcut` while mounted, and the key does what Save does, or nothing while Save
cannot be pressed. A dialog over the editor (Rename…, a discard confirm) takes the key, so the editor behind it is
never saved by it. On New concept it is *Create concept*, not the draft.

The editor's browser-kept text is now called *unsaved* on screen (see m03's addendum); `drafts.ts` keeps its name
and key.

### Addendum, 2026-10-31: Ctrl+S saves on the spot

The owner: Ctrl+S "shouldn't exit edit mode - just save on the spot and allow you to continue working". In the
editor it now saves and stays: the same element, so the cursor, selection and scroll are untouched, the base
revision moves to the one returned, the message clears, and *Saved as revision N.* shows until the text moves on.
The page re-reads the document behind it, so View and History are current. **Only what was sent stops being
unsaved**: text typed while the save is in flight stays dirty and is kept in the browser against the new base. A
409 opens the stale-save view as before. The **Save button still saves and closes**, and Overwrite is a button.
**New concept** has no document to stay on until it exists, so Ctrl+S creates it and opens the document's own
editor (`?tab=edit`): editing goes on, but that is a new page, so the cursor does not carry over. In
`trackerDrafts.test.tsx`.
