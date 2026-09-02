# `web/` — the ledger viewer

A React SPA that reads and writes the ledger over `rag-serve`'s existing HTTP
API. It is served same-origin by `rag-serve` in production, so there is no CORS
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
`/reindex` — to a live `rag-serve`, so a dev session needs neither a local
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

What the application suite covers, in the order it matters:

| File                            | What it defends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown.test.ts`              | The sanitiser as a security boundary: script tags, event handlers, `javascript:`/`data:text/html` URLs, SVG-borne script, entity and mixed-case evasions, malformed-tag tricks — asserted against the **parsed DOM**, not the HTML string. Plus the other failure: that code fences, tables, lists and links still render. Also the structural rule that `dangerouslySetInnerHTML` appears exactly once                                                                                        |
| `markdownSecondBarrier.test.ts` | The same module with `markdown-it` mocked to a pass-through, so DOMPurify is tested **alone**. With `html: false` in force the parser hides the sanitiser, and a sanitiser quietly reduced to a no-op would pass every test in the file above                                                                                                                                                                                                                                                  |
| `client.test.ts`                | Both `POST /ledger/search` response shapes; a moved id answered with a **200** pointer; the `{"error": …}` body and the 422 that has none; and the `author_agent: null` guarantee, behaviourally (what reaches the wire) and structurally (nothing but `authorFields`/`creatorFields` names those fields)                                                                                                                                                                                      |
| `identity.test.tsx`             | Email validation, `localStorage` that **throws** on read, write and clear, and the write gate — `useAuthor()` returning null blocks the write and opens the prompt instead                                                                                                                                                                                                                                                                                                                     |
| `writes.test.tsx`               | All four writes: a note required whatever else is amended, `set_tags` pre-populated so an edit cannot wipe the set, `set_title`/`set_tags` omitted when unchanged, no summary editor anywhere, `repo` validated before it becomes an id, archive and restore through one endpoint, the move consequence stated before it is confirmed — and that a write is followed by a re-read or a navigation, never a re-search                                                                           |
| `views.test.tsx`                | Each view renders, asks for the right thing and tells the truth in its empty state: no zero-query browse for live topics, a plain list for archived ones that states its own page size and warns when it filled it, and a pasted `/topic/{id}` opening the topic                                                                                                                                                                                                                               |
| `openTopic.test.tsx`            | Opening a quoted id: the bar's box on every route, Enter with no mouse, a moved id followed, a well-formed absent one answered by name — and the two things that must _not_ happen, a round trip for a malformed id and the search box taking Enter away from a search                                                                                                                                                                                                                         |
| `ids.test.ts`                   | What may be minted into a topic id, how one is recognised (the final-hyphen split, so `demo-v2-0001` is the project `demo-v2`) and how one becomes a URL — plus the three structural rules that keep each of those in one module, since the defect they replace was a rule written down at one call site and not applied at the other four                                                                                                                                                     |
| `summarise.test.tsx`            | The Summarise drawer: the model list and the default prompt read from `/info` rather than copied, what the reader edited being what is sent, the entry itself never leaving the browser, no cache (two presses, two calls), a 503 drawn as _not configured_ rather than as a fault, and a topic change clearing the summary while keeping the prompt                                                                                                                                           |
| `promptLibrary.test.tsx`        | The saved prompt library: the built-in listed first and never as a saved file, a chosen prompt loading into the box and being what runs, an unsaved edit announced and never lost to a change of selection without being asked, Save on the built-in asking for a name instead of overwriting anything, a path-shaped name refused before it leaves the browser, Delete absent (not disabled) for the built-in, and a server with no prompts directory saying so while staying entirely usable |
| `vocab.test.ts`                 | The display tables' one promise: an unheard-of value comes back as itself, including for the names inherited from `Object.prototype`                                                                                                                                                                                                                                                                                                                                                           |

`app/src/__tests__/sources.ts` is the helper the structural assertions use — the
handful of guarantees that are properties of the codebase rather than of any one
function, and that fail by a _new_ line appearing somewhere else.

The design system's own suite (`ui/src/__tests__/`) covers components in
isolation and knows nothing about the ledger, which is the same boundary the
packages keep at runtime.

## The application

### Routes

| Route        | What it is                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Search over **live** topics. Query and filters live in the query string (`?q=&repo=&type=&status=`), so a result set is a link you can send someone                                                                                 |
| `/topic/:id` | One topic, whole: header, the immutable `summary`, the current state, the event timeline and the typed links. `/topic/rag-0009` is the point of the whole viewer — an id an agent quoted, opened from the bar or pasted straight in |
| `/archived`  | The soft-deleted set, listed newest first. An optional box narrows it by substring, server-side. Each row restores from here                                                                                                        |
| `/new`       | Create a topic — the only place a `summary` is ever set                                                                                                                                                                             |

**Search is at `/`, and cannot move to `/search`.** `rag-serve` reserves
`/search`, `/ledger`, `/health`, `/info` and `/reindex` and excludes them from
the SPA fallback, so that a mistyped endpoint stays a JSON 404 rather than
quietly returning an HTML page. A client route with one of those names would
never survive a refresh or a pasted link — in production or behind the dev
proxy, which mirrors the same list. Check any new route against it.

### Opening a quoted id is the primary journey

An agent writes `demo-0001` into a commit message, a chat log or another topic's
prose, and somebody wants to read it. Everything else here — search, the archive
listing — is a way of finding an id you were _not_ given, so the direct route
gets the prominent affordance:

- **The top bar carries a topic-id box on every page** (`ledger/OpenTopic.tsx`),
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
`parseTopicId` splits `{repo}-{seq:04}` at the **final** hyphen, because a
project name may contain hyphens and digits of its own (`demo-v2-0001` is the
project `demo-v2`), and four digits is the server's `format!("{}-{:04}", …)`
minimum rather than a width — a project past 9,999 topics keeps minting ids.

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
submit to find out: the id the project name will mint (`{repo}-0001`), and the
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

## The design system

`ui/src/tokens.css` is the whole theme: one `:root` block of custom properties,
no light/dark axis and no provider. A component names a token, never a colour.
Import it once at the application root.

Icons are a fixed registry (`ui/src/icons/registry.ts`) over `lucide-react`.
Names arrive as strings — a column declares one, a nav item declares one — so a
bundler cannot see which glyphs are reachable; naming them in one table is what
keeps the bundle to the icons actually drawn. Adding a glyph is one import and
one row.

Strings the components draw for themselves resolve through `ui/src/i18n`;
`en-GB` is the only catalogue. Application strings belong to the application.
