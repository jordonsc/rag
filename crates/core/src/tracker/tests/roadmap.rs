//! The roadmap's store (spec:roadmap m01): the migration, phases, freezing,
//! release, recall, stamping, spans, the figures, integrity and the forward look.
//! After every operation the integrity check must pass ([`assert_sound`]).

use chrono::{DateTime, Utc};
use serde_json::json;

use super::*;
use crate::tracker::phases::roadmap_walk;
use crate::tracker::roadmap::READS;

const P: &str = "p";

/// A Sunday noon; the report's 7 days start on the hour.
const NOW: &str = "2026-11-08T12:00:00Z";

fn now() -> DateTime<Utc> {
    NOW.parse().unwrap()
}

fn plan(project: &str, title: &str) -> NewPhase {
    NewPhase {
        project: project.into(),
        title: title.into(),
        body: String::new(),
        place: Place::Bottom,
        note: None,
    }
}

/// `check` is `ok` and the open spans match the rows. Returns the main walk.
async fn assert_sound(s: &TrackerStore, project: &str) -> Vec<String> {
    let order = sound(s, project).await;
    assert_spans_match_rows(s).await;
    order
}

async fn planned(s: &TrackerStore, title: &str) -> String {
    let id = s
        .create_phase(plan(P, title), &mcp())
        .await
        .unwrap()
        .phase
        .id;
    assert_sound(s, P).await;
    id
}

async fn released(s: &TrackerStore, title: &str) -> String {
    let id = planned(s, title).await;
    s.release_phase(&id, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    id
}

async fn archived(s: &TrackerStore, title: &str) -> String {
    let id = planned(s, title).await;
    s.archive_phase(&id, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    id
}

/// A dev ticket created in a phase.
async fn in_phase(s: &TrackerStore, phase: &str, title: &str) -> String {
    let id = s
        .create_item_in_phase(new_item(P, title), phase, &mcp())
        .await
        .unwrap()
        .item
        .id;
    assert_sound(s, P).await;
    id
}

async fn draft_in_phase(s: &TrackerStore, phase: &str, title: &str) -> String {
    let id = s
        .create_item_in_phase(
            NewItem {
                draft: true,
                ..new_item(P, title)
            },
            phase,
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    assert_sound(s, P).await;
    id
}

async fn item(s: &TrackerStore, id: &str) -> Item {
    s.get_item(id, false).await.unwrap().unwrap().item
}

async fn last_event(s: &TrackerStore, id: &str) -> Event {
    s.get_item(id, true)
        .await
        .unwrap()
        .unwrap()
        .events
        .pop()
        .unwrap()
}

async fn phase_of(s: &TrackerStore, id: &str) -> PhaseRecord {
    s.get_phase(id, true, false).await.unwrap().unwrap()
}

async fn last_phase_event(s: &TrackerStore, id: &str) -> Event {
    phase_of(s, id).await.events.pop().unwrap()
}

/// A phase's frozen tickets, in order.
async fn frozen_in(s: &TrackerStore, phase: &str) -> Vec<String> {
    s.get_phase(phase, false, true)
        .await
        .unwrap()
        .unwrap()
        .tickets
        .unwrap()
        .into_iter()
        .filter(|i| i.frozen)
        .map(|i| i.id)
        .collect()
}

async fn roadmap_order(s: &TrackerStore, project: &str) -> Vec<String> {
    let mut conn = s.pool.acquire().await.unwrap();
    roadmap_walk(&mut conn, project).await.unwrap()
}

/// The queue's ends, from the project row.
async fn queue_ends(s: &TrackerStore) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT head_id, tail_id FROM projects WHERE name = ?")
        .bind(P)
        .fetch_one(&s.pool)
        .await
        .unwrap()
}

async fn change(s: &TrackerStore, id: &str, what: PhaseChange) -> ItemRecord {
    let rec = s.set_item_phase(id, what, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    rec
}

async fn refused_change(s: &TrackerStore, id: &str, what: PhaseChange, want: &str) {
    let before = item(s, id).await;
    let e = s.set_item_phase(id, what, None, &mcp()).await.unwrap_err();
    assert!(matches!(e, TrackerError::Refused(_)), "{e}");
    assert!(e.to_string().contains(want), "{e} (wanted {want:?})");
    let after = item(s, id).await;
    assert_eq!(
        (after.frozen, after.phase_id, after.prev_id, after.next_id),
        (
            before.frozen,
            before.phase_id,
            before.prev_id,
            before.next_id
        ),
        "a refusal changed {id}"
    );
    assert_sound(s, P).await;
}

async fn wait_on(s: &TrackerStore, id: &str, on: &[&String]) {
    s.update_item(
        id,
        ItemUpdate {
            block_reason: Some(BlockReason::Dependency),
            depends_on: Some(on.iter().map(|o| o.to_string()).collect()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert_sound(s, P).await;
}

async fn open_span(s: &TrackerStore, id: &str, track: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT state FROM item_spans WHERE item_id = ? AND track = ? AND ended_at IS NULL",
    )
    .bind(id)
    .bind(track)
    .fetch_optional(&s.pool)
    .await
    .unwrap()
}

// ---- 1. The live database opens -------------------------------------------------

/// `projects`, `items` and `events` exactly as they were at 7d5b74a, written out
/// by hand: a schema derived from `SCHEMA_SQL` would hide an index on an added
/// column there (spec:roadmap Risk 4).
const SCHEMA_AT_7D5B74A: &str = "
CREATE TABLE projects (
    name       TEXT PRIMARY KEY,
    head_id    TEXT,
    tail_id    TEXT,
    item_seq   INTEGER NOT NULL DEFAULT 0,
    doc_seq    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE items (
    id              TEXT PRIMARY KEY,
    project         TEXT NOT NULL REFERENCES projects(name),
    seq             INTEGER NOT NULL,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL,
    blocked         INTEGER NOT NULL DEFAULT 0,
    block_reason    TEXT,
    block_note      TEXT,
    approval        TEXT NOT NULL,
    assignee        TEXT,
    intensity       TEXT,
    release         INTEGER NOT NULL DEFAULT 0,
    parallel        INTEGER NOT NULL DEFAULT 0,
    draft           INTEGER NOT NULL DEFAULT 0,
    prev_id         TEXT,
    next_id         TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    done_at         TEXT,
    acknowledged_at TEXT
);
CREATE TABLE events (
    event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT NOT NULL,
    target_kind  TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    ts           TEXT NOT NULL,
    author_email TEXT NOT NULL,
    agent        TEXT NOT NULL,
    surface      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    body         TEXT NOT NULL,
    fields       TEXT NOT NULL DEFAULT '{}',
    fields_before TEXT,
    draft        INTEGER NOT NULL DEFAULT 0
);
INSERT INTO projects (name, head_id, tail_id, item_seq, created_at)
    VALUES ('old', 'old-t0001', 'old-t0002', 3, '2026-11-01T00:00:00Z');
INSERT INTO items (id, project, seq, type, title, status, approval, prev_id, next_id, created_at,
    updated_at) VALUES
    ('old-t0001', 'old', 1, 'dev', 'first', 'pending', 'owner', NULL, 'old-t0002',
     '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    ('old-t0002', 'old', 2, 'gate', 'second', 'in_progress', 'owner', 'old-t0001', NULL,
     '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    ('old-t0003', 'old', 3, 'dev', 'third', 'done', 'owner', NULL, NULL,
     '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, surface, kind, body,
    fields) VALUES
    ('old', 'item', 'old-t0001', '2026-11-01T00:00:00Z', 'a@example.com', 'Claude', 'mcp',
     'create', 'Created.', '{\"status\":\"pending\"}');
";

#[tokio::test]
async fn an_older_database_without_the_columns_opens_twice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::query(SCHEMA_AT_7D5B74A).execute(&pool).await.unwrap();
        pool.close().await;
    }
    for _ in 0..2 {
        let s = TrackerStore::open(&path, dir.path().join("att"))
            .await
            .unwrap();
        for (table, column) in [
            ("projects", "phase_seq"),
            ("projects", "roadmap_head_id"),
            ("projects", "roadmap_tail_id"),
            ("items", "phase_id"),
            ("items", "frozen"),
            ("events", "roadmap"),
        ] {
            let have: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM pragma_table_info(?) WHERE name = ?")
                    .bind(table)
                    .bind(column)
                    .fetch_optional(&s.pool)
                    .await
                    .unwrap();
            assert!(have.is_some(), "no {table}.{column}");
        }
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
                .fetch_all(&s.pool)
                .await
                .unwrap();
        for name in [
            "phases",
            "idx_phases_project",
            "idx_items_project_frozen",
            "idx_items_phase",
            "idx_events_activity",
        ] {
            assert!(names.iter().any(|n| n == name), "no {name} in {names:?}");
        }
        for id in ["old-t0001", "old-t0002", "old-t0003"] {
            let i = item(&s, id).await;
            assert!(!i.frozen && i.phase_id.is_none(), "{id}");
        }
        assert!(item(&s, "old-t0001").await.queued);
        let events = s.get_item("old-t0001", true).await.unwrap().unwrap().events;
        assert!(events.iter().all(|e| !e.roadmap));
        let report = s.check("old").await.unwrap();
        assert!(report.ok, "{:?}", report.problems);
        assert_eq!(report.order, ids(&["old-t0001", "old-t0002"]));
        assert_eq!((report.queued, report.frozen), (2, 0));
        s.pool.close().await;
    }
}

#[test]
fn no_index_on_an_added_column_is_in_the_schema_that_runs_first() {
    assert!(!SCHEMA_SQL.contains("idx_items_project_frozen"));
    assert!(!SCHEMA_SQL.contains("idx_items_phase"));
    assert!(!SCHEMA_SQL.contains("idx_events_activity"));
    assert!(ROADMAP_INDEXES_SQL.contains("idx_events_activity"));
    assert!(ROADMAP_INDEXES_SQL.contains("idx_items_project_frozen"));
    assert!(ROADMAP_INDEXES_SQL.contains("WHERE frozen = 1"));
    assert!(ROADMAP_INDEXES_SQL.contains("idx_items_phase"));
}

// ---- 2. The reader guard (spec:roadmap Risk 1) -----------------------------------

/// Every queue figure and listing, leaving out only the new `frozen` counts.
async fn every_figure(s: &TrackerStore) -> serde_json::Value {
    let mut view = serde_json::to_value(s.queue_view(P).await.unwrap()).unwrap();
    view.as_object_mut().unwrap().remove("frozen");
    let mut projects = serde_json::to_value(s.list_projects().await.unwrap()).unwrap();
    for p in projects.as_array_mut().unwrap() {
        p.as_object_mut().unwrap().remove("frozen");
    }
    let v = s.velocity(P, Utc::now()).await.unwrap();
    let items = s.list_items(P, None, None).await.unwrap();
    let pending = s
        .list_items(P, Some(ItemStatus::Pending), None)
        .await
        .unwrap();
    let labels: Vec<(String, i64)> = s
        .project_labels(P)
        .await
        .unwrap()
        .into_iter()
        .filter(|l| l.label != "Frozen only")
        .map(|l| (l.label, l.queued))
        .collect();
    let report = s.check(P).await.unwrap();
    json!({
        "view": view,
        "projects": projects,
        "counts": [v.in_progress, v.in_review, v.pending, v.blocked, v.deferred, v.remaining],
        "items": items,
        "pending": pending,
        "labels": labels,
        "order": report.order,
        "queued": report.queued,
    })
}

#[tokio::test]
async fn a_frozen_ticket_is_in_no_queue_figure_or_listing() {
    let f = fixture().await;
    let s = &f.store;
    let a = s
        .create_item(
            NewItem {
                labels: vec!["Physics".into()],
                ..new_item(P, "queued")
            },
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    let b = create(s, P, "working").await;
    set_status(s, &b, ItemStatus::InProgress).await;
    let c = create(s, P, "put aside").await;
    set_status(s, &c, ItemStatus::Deferred).await;
    assert_sound(s, P).await;
    let before = every_figure(s).await;

    let ph = planned(s, "Creatures").await;
    assert_eq!(
        every_figure(s).await,
        before,
        "an empty phase changed a figure"
    );
    for ty in [
        ItemType::Dev,
        ItemType::Design,
        ItemType::Recon,
        ItemType::Analysis,
    ] {
        s.create_item_in_phase(
            NewItem {
                item_type: ty,
                labels: vec!["Physics".into(), "Frozen only".into()],
                ..new_item(P, "frozen")
            },
            &ph,
            &mcp(),
        )
        .await
        .unwrap();
        assert_sound(s, P).await;
    }
    let draft = draft_in_phase(s, &ph, "a frozen draft").await;
    let blocked = in_phase(s, &ph, "a frozen blocked one").await;
    s.update_item(
        &blocked,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    s.create_item_in_phase(new_gate(P, Intensity::Quick), &ph, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;

    assert_eq!(
        every_figure(s).await,
        before,
        "a frozen ticket reached a figure"
    );
    assert!(item(s, &draft).await.frozen);
    assert!(!item(s, &a).await.frozen);
    // The frozen counts are right: four, the draft, the blocked one and the gate.
    assert_eq!(s.queue_view(P).await.unwrap().frozen, 7);
    let project = s.list_projects().await.unwrap().pop().unwrap();
    assert_eq!(project.frozen, 7);
    assert_eq!(s.check(P).await.unwrap().frozen, 7);
    // A frozen ticket's label is still the project's vocabulary.
    let labels = s.project_labels(P).await.unwrap();
    let physics = labels.iter().find(|l| l.label == "Physics").unwrap();
    assert_eq!((physics.count, physics.queued), (5, 1));
    let only = labels.iter().find(|l| l.label == "Frozen only").unwrap();
    assert_eq!((only.count, only.queued), (4, 0));
    // A frozen ticket reads `queued: false`.
    assert!(!item(s, &blocked).await.queued);
}

// ---- 3. Create ------------------------------------------------------------------

#[tokio::test]
async fn create_in_a_phase_follows_its_state() {
    let f = fixture().await;
    let s = &f.store;
    let q = create(s, P, "queued").await;
    let ph = planned(s, "Planned").await;
    let a = in_phase(s, &ph, "a").await;
    let b = in_phase(s, &ph, "b").await;
    assert_eq!(frozen_in(s, &ph).await, vec![a.clone(), b.clone()]);
    let rec = item(s, &a).await;
    assert!(rec.frozen && !rec.queued);
    assert_eq!(rec.phase_id.as_deref(), Some(ph.as_str()));
    let created = last_event(s, &a).await;
    assert_eq!(created.fields["phase"], json!(ph));
    assert_eq!(created.fields["frozen"], json!(true));

    // At a named place: its place is in the phase.
    let top = s
        .create_item_in_phase(
            NewItem {
                place: Place::Top,
                ..new_item(P, "top")
            },
            &ph,
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    let mid = s
        .create_item_in_phase(
            NewItem {
                place: Place::After(a.clone()),
                ..new_item(P, "mid")
            },
            &ph,
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![top, a.clone(), mid, b.clone()]
    );
    assert_eq!(assert_sound(s, P).await, vec![q.clone()]);
    // A place in the queue is no place in a phase.
    let e = s
        .create_item_in_phase(
            NewItem {
                place: Place::Before(q.clone()),
                ..new_item(P, "elsewhere")
            },
            &ph,
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("is not in phase"), "{e}");

    // Released: straight into the queue, linked, unfrozen, with no frozen field.
    let rel = released(s, "Released").await;
    let r = in_phase(s, &rel, "released").await;
    let rec = item(s, &r).await;
    assert!(!rec.frozen && rec.queued);
    assert_eq!(rec.phase_id.as_deref(), Some(rel.as_str()));
    assert_eq!(assert_sound(s, P).await, vec![q.clone(), r.clone()]);
    let created = last_event(s, &r).await;
    assert_eq!(created.fields["phase"], json!(rel));
    assert!(created.fields.get("frozen").is_none());
    // At a named place in the queue.
    let r2 = s
        .create_item_in_phase(
            NewItem {
                place: Place::Top,
                ..new_item(P, "released at the top")
            },
            &rel,
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    assert_eq!(assert_sound(s, P).await, vec![r2, q, r]);

    // Archived: refused.
    let arch = archived(s, "Archived").await;
    let e = s
        .create_item_in_phase(new_item(P, "x"), &arch, &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("archived"), "{e}");

    // A request: refused in each.
    for phase in [&ph, &rel, &arch] {
        let e = s
            .create_item_in_phase(
                NewItem {
                    item_type: ItemType::Request,
                    ..new_item(P, "idea")
                },
                phase,
                &mcp(),
            )
            .await
            .unwrap_err();
        assert!(
            e.to_string().contains("a request cannot have a phase"),
            "{e}"
        );
    }

    // Another project's phase: refused. An unknown one: not found.
    let e = s
        .create_item_in_phase(new_item("other", "x"), &ph, &mcp())
        .await
        .unwrap_err();
    assert!(matches!(e, TrackerError::Refused(_)), "{e}");
    let e = s
        .create_item_in_phase(new_item(P, "x"), "p-p9999", &mcp())
        .await
        .unwrap_err();
    assert!(matches!(e, TrackerError::NotFound(_)), "{e}");
    assert_sound(s, P).await;
    // A refused create leaves no ticket and burns no sequence number.
    assert_eq!(create(s, P, "after the refusals").await, "p-t0008");
}

// ---- 4. Anchors -----------------------------------------------------------------

#[tokio::test]
async fn a_move_stays_on_its_own_list() {
    let f = fixture().await;
    let s = &f.store;
    let q1 = create(s, P, "q1").await;
    let q2 = create(s, P, "q2").await;
    let ph = planned(s, "One").await;
    let a = in_phase(s, &ph, "a").await;
    let b = in_phase(s, &ph, "b").await;
    let c = in_phase(s, &ph, "c").await;
    let other = planned(s, "Two").await;
    let o = in_phase(s, &other, "o").await;

    let unchanged = |order: Vec<String>, phase: Vec<String>| {
        assert_eq!(order, vec![q1.clone(), q2.clone()]);
        assert_eq!(phase, vec![a.clone(), b.clone(), c.clone()]);
    };

    // A queue move before or after a frozen ticket is refused.
    for place in [Place::Before(a.clone()), Place::After(c.clone())] {
        let e = s.move_item(&q1, place, None, &mcp()).await.unwrap_err();
        assert!(e.to_string().contains("is frozen in phase"), "{e}");
        unchanged(assert_sound(s, P).await, frozen_in(s, &ph).await);
    }
    // A frozen move before a queued ticket, or another phase's, is refused.
    for place in [
        Place::Before(q1.clone()),
        Place::After(q2.clone()),
        Place::Before(o.clone()),
    ] {
        let e = s.move_item(&a, place, None, &mcp()).await.unwrap_err();
        assert!(e.to_string().contains("is not in phase"), "{e}");
        unchanged(assert_sound(s, P).await, frozen_in(s, &ph).await);
    }

    // Within its phase, each of the four. The queue's ends are never touched.
    let ends = queue_ends(s).await;
    s.move_item(&c, Place::Top, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![c.clone(), a.clone(), b.clone()]
    );
    s.move_item(&c, Place::Bottom, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![a.clone(), b.clone(), c.clone()]
    );
    s.move_item(&c, Place::Before(a.clone()), None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![c.clone(), a.clone(), b.clone()]
    );
    s.move_item(&c, Place::After(a.clone()), None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![a.clone(), c.clone(), b.clone()]
    );
    assert_eq!(queue_ends(s).await, ends);
    let phase = phase_of(s, &ph).await.phase;
    assert_eq!(phase.head_id.as_deref(), Some(a.as_str()));
    assert_eq!(phase.tail_id.as_deref(), Some(b.as_str()));
    // The other phase's list is untouched too.
    assert_eq!(frozen_in(s, &other).await, vec![o.clone()]);
    // A frozen ticket's move is stamped.
    assert!(last_event(s, &c).await.roadmap);
    assert_eq!(last_event(s, &c).await.kind, EventKind::Move);
}

// ---- 5. set_item_phase: RM-09's table --------------------------------------------

#[tokio::test]
async fn a_request_can_have_no_phase_of_any_kind() {
    let f = fixture().await;
    let s = &f.store;
    let r = s
        .create_item(
            NewItem {
                item_type: ItemType::Request,
                ..new_item(P, "idea")
            },
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    let (pl, re, ar) = (
        planned(s, "P").await,
        released(s, "R").await,
        archived(s, "A").await,
    );
    for what in [
        PhaseChange::Set(pl),
        PhaseChange::Set(re),
        PhaseChange::Set(ar),
        PhaseChange::Clear,
        PhaseChange::Frozen(false),
        PhaseChange::Frozen(true),
    ] {
        refused_change(s, &r, what, "a request cannot have a phase").await;
    }
}

#[tokio::test]
async fn a_ticket_frozen_elsewhere_moves_by_the_target_phases_state() {
    let f = fixture().await;
    let s = &f.store;
    let q = create(s, P, "queued").await;
    let (from, to, re, ar) = (
        planned(s, "Q").await,
        planned(s, "P").await,
        released(s, "R").await,
        archived(s, "A").await,
    );
    let t = in_phase(s, &from, "t").await;
    let u = in_phase(s, &from, "u").await;
    let already = in_phase(s, &to, "already").await;

    // Set(P), P planned: unlink Q, link P's bottom; frozen all along.
    let rec = change(s, &t, PhaseChange::Set(to.clone())).await;
    assert!(rec.item.frozen);
    assert_eq!(rec.item.phase_id.as_deref(), Some(to.as_str()));
    assert_eq!(frozen_in(s, &from).await, vec![u.clone()]);
    assert_eq!(frozen_in(s, &to).await, vec![already.clone(), t.clone()]);
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Move);
    assert_eq!(e.body, format!("Moved to phase {to}."));
    assert_eq!(e.fields["phase"], json!(to));
    assert_eq!(e.fields["prev_id"], json!(already));
    assert!(e.fields.get("frozen").is_none());
    assert_eq!(e.before.as_ref().unwrap()["phase"], json!(from));
    assert!(e.roadmap);

    // Set(P), P archived: refused.
    refused_change(s, &t, PhaseChange::Set(ar.clone()), "archived").await;

    // Set(P), P released: unlink, the queue's bottom, unfrozen.
    let rec = change(s, &t, PhaseChange::Set(re.clone())).await;
    assert!(!rec.item.frozen && rec.item.queued);
    assert_eq!(rec.item.phase_id.as_deref(), Some(re.as_str()));
    assert_eq!(assert_sound(s, P).await, vec![q.clone(), t.clone()]);
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Move);
    assert_eq!(e.body, format!("Moved to phase {re}."));
    assert_eq!(e.fields["frozen"], json!(false));
    assert_eq!(e.before.as_ref().unwrap()["frozen"], json!(true));
    assert!(e.roadmap);

    // Clear: the queue's bottom, unfrozen, no phase.
    let rec = change(s, &u, PhaseChange::Clear).await;
    assert!(!rec.item.frozen && rec.item.phase_id.is_none());
    assert_eq!(
        assert_sound(s, P).await,
        vec![q.clone(), t.clone(), u.clone()]
    );
    assert_eq!(
        rec.events.last().unwrap().body,
        format!("Removed from {from}.")
    );
    assert_eq!(rec.events.last().unwrap().kind, EventKind::Move);
    assert!(rec.events.last().unwrap().roadmap);

    // Pull: the queue's bottom, unfrozen, keeping the link.
    let v = in_phase(s, &from, "v").await;
    let rec = change(s, &v, PhaseChange::Frozen(false)).await;
    assert!(!rec.item.frozen);
    assert_eq!(rec.item.phase_id.as_deref(), Some(from.as_str()));
    assert_eq!(
        assert_sound(s, P).await,
        vec![q.clone(), t.clone(), u.clone(), v.clone()]
    );
    let e = rec.events.last().unwrap();
    assert_eq!(
        (e.kind, e.body.as_str()),
        (EventKind::Move, "Pulled to the queue.")
    );
    assert!(e.fields.get("phase").is_none());
    assert!(e.roadmap);

    // Frozen(true) while frozen: nothing to do.
    let w = in_phase(s, &from, "w").await;
    refused_change(s, &w, PhaseChange::Frozen(true), "nothing to update").await;
    // Into its own phase: nothing to do.
    refused_change(s, &w, PhaseChange::Set(from.clone()), "nothing to update").await;
    // Clear and pull work on one frozen in its own phase too (as above).
    let rec = change(s, &w, PhaseChange::Clear).await;
    assert!(rec.item.phase_id.is_none());
    assert_eq!(phase_of(s, &from).await.phase.head_id, None);
    assert_eq!(phase_of(s, &from).await.phase.tail_id, None);
}

#[tokio::test]
async fn a_pending_ticket_freezes_links_and_clears() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, P, "a").await;
    let b = create(s, P, "b").await;
    let c = create(s, P, "c").await;
    let (pl, re, ar) = (
        planned(s, "P").await,
        released(s, "R").await,
        archived(s, "A").await,
    );

    // Nothing to clear, pull or freeze with no phase.
    refused_change(s, &b, PhaseChange::Clear, "nothing to update").await;
    refused_change(s, &b, PhaseChange::Frozen(false), "nothing to update").await;
    refused_change(s, &b, PhaseChange::Frozen(true), "no phase").await;
    // Archived: refused.
    refused_change(s, &b, PhaseChange::Set(ar.clone()), "archived").await;

    // Set(P), P released: only the link; its place in the queue is unchanged.
    let rec = change(s, &b, PhaseChange::Set(re.clone())).await;
    assert!(!rec.item.frozen);
    assert_eq!(
        assert_sound(s, P).await,
        vec![a.clone(), b.clone(), c.clone()]
    );
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Link);
    assert_eq!(e.body, format!("Linked to phase {re}."));
    assert_eq!(e.fields["phase"], json!(re));
    assert!(e.fields.get("prev_id").is_none());
    // The same link again is nothing to do.
    refused_change(s, &b, PhaseChange::Set(re.clone()), "nothing to update").await;
    // Frozen(true) with its phase released: refused.
    refused_change(s, &b, PhaseChange::Frozen(true), "only a planned phase").await;

    // Clear: the link goes, its place stays.
    let rec = change(s, &b, PhaseChange::Clear).await;
    assert!(rec.item.phase_id.is_none());
    assert_eq!(
        assert_sound(s, P).await,
        vec![a.clone(), b.clone(), c.clone()]
    );
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Link);
    assert_eq!(e.body, format!("Removed from {re}."));

    // Set(P), P planned: unlink the queue, frozen at P's bottom.
    let rec = change(s, &b, PhaseChange::Set(pl.clone())).await;
    assert!(rec.item.frozen);
    assert_eq!(assert_sound(s, P).await, vec![a.clone(), c.clone()]);
    assert_eq!(frozen_in(s, &pl).await, vec![b.clone()]);
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Move);
    assert_eq!(e.body, format!("Frozen in {pl}."));
    assert_eq!(e.fields["frozen"], json!(true));
    assert_eq!(e.fields["phase"], json!(pl));

    // Pulled, it re-freezes in its own phase by either write, with no phase field.
    change(s, &b, PhaseChange::Frozen(false)).await;
    assert_eq!(
        assert_sound(s, P).await,
        vec![a.clone(), c.clone(), b.clone()]
    );
    let rec = change(s, &b, PhaseChange::Frozen(true)).await;
    assert!(rec.item.frozen);
    assert!(rec.events.last().unwrap().fields.get("phase").is_none());
    assert_eq!(rec.events.last().unwrap().body, format!("Frozen in {pl}."));
    change(s, &b, PhaseChange::Frozen(false)).await;
    let rec = change(s, &b, PhaseChange::Set(pl.clone())).await;
    assert!(rec.item.frozen);
    assert!(rec.events.last().unwrap().fields.get("phase").is_none());
    change(s, &b, PhaseChange::Frozen(false)).await;
    // Unfrozen: Frozen(false) is nothing to do.
    refused_change(s, &b, PhaseChange::Frozen(false), "nothing to update").await;

    // A note replaces the generated body.
    let rec = s
        .set_item_phase(&b, PhaseChange::Clear, Some("Not this one."), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.events.last().unwrap().body, "Not this one.");
    assert_sound(s, P).await;

    // A phase of another project: refused.
    let other = s
        .create_phase(plan("other", "Theirs"), &mcp())
        .await
        .unwrap()
        .phase
        .id;
    refused_change(s, &b, PhaseChange::Set(other), "belongs to project").await;
    // An unknown phase: not found.
    let e = s
        .set_item_phase(&b, PhaseChange::Set("p-p9999".into()), None, &mcp())
        .await
        .unwrap_err();
    assert!(matches!(e, TrackerError::NotFound(_)), "{e}");
}

#[tokio::test]
async fn any_other_status_links_but_never_freezes() {
    let f = fixture().await;
    let s = &f.store;
    let (pl, re, ar) = (
        planned(s, "P").await,
        released(s, "R").await,
        archived(s, "A").await,
    );
    for to in [
        ItemStatus::InProgress,
        ItemStatus::Failed,
        ItemStatus::Review,
        ItemStatus::Done,
        ItemStatus::Cancelled,
    ] {
        let t = create(s, P, "t").await;
        set_status(s, &t, to).await;
        let want = "only a pending or deferred ticket can be frozen";
        refused_change(s, &t, PhaseChange::Set(pl.clone()), want).await;
        refused_change(s, &t, PhaseChange::Set(ar.clone()), "archived").await;
        refused_change(s, &t, PhaseChange::Frozen(false), "nothing to update").await;

        // Set(P), P released: only the link, whatever the status.
        let rec = change(s, &t, PhaseChange::Set(re.clone())).await;
        assert_eq!(rec.item.phase_id.as_deref(), Some(re.as_str()));
        assert_eq!(rec.item.status, to);
        assert!(!rec.item.frozen);
        assert_eq!(rec.events.last().unwrap().kind, EventKind::Link);
        refused_change(s, &t, PhaseChange::Frozen(true), want).await;

        // Clear: the link goes.
        let rec = change(s, &t, PhaseChange::Clear).await;
        assert!(rec.item.phase_id.is_none());
        assert_eq!(rec.item.status, to);
    }
}

#[tokio::test]
async fn a_deferred_ticket_is_resumed_by_freezing() {
    let f = fixture().await;
    let s = &f.store;
    let (pl, re) = (planned(s, "P").await, released(s, "R").await);
    let t = create(s, P, "t").await;

    // Set(P), P planned: frozen, pending, in one stamped event saying both.
    set_status(s, &t, ItemStatus::Deferred).await;
    let rec = change(s, &t, PhaseChange::Set(pl.clone())).await;
    assert!(rec.item.frozen);
    assert_eq!(rec.item.status, ItemStatus::Pending);
    assert_eq!(frozen_in(s, &pl).await, vec![t.clone()]);
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Move);
    assert!(e.roadmap);
    assert_eq!(
        e.body,
        format!("Status: deferred → pending. Frozen in {pl}.")
    );
    assert_eq!(e.fields["status"], json!("pending"));
    assert_eq!(e.before.as_ref().unwrap()["status"], json!("deferred"));

    // Frozen(true) in its own planned phase does the same, and a note still
    // replaces the generated body.
    change(s, &t, PhaseChange::Frozen(false)).await;
    set_status(s, &t, ItemStatus::Deferred).await;
    let rec = s
        .set_item_phase(&t, PhaseChange::Frozen(true), Some("Later."), &mcp())
        .await
        .unwrap();
    assert!(rec.item.frozen);
    assert_eq!(rec.item.status, ItemStatus::Pending);
    let e = rec.events.last().unwrap();
    assert_eq!(e.body, "Later.");
    assert_eq!(e.fields["status"], json!("pending"));

    // A released phase freezes nothing, so only the link is written: still deferred.
    change(s, &t, PhaseChange::Frozen(false)).await;
    set_status(s, &t, ItemStatus::Deferred).await;
    let rec = change(s, &t, PhaseChange::Set(re.clone())).await;
    assert!(!rec.item.frozen);
    assert_eq!(rec.item.status, ItemStatus::Deferred);
    assert!(rec.events.last().unwrap().fields.get("status").is_none());
}

// ---- 6. Status ------------------------------------------------------------------

#[tokio::test]
async fn a_frozen_ticket_only_closes_and_a_reopen_lands_at_the_queues_top() {
    let f = fixture().await;
    let s = &f.store;
    let q1 = create(s, P, "q1").await;
    let q2 = create(s, P, "q2").await;
    let ph = planned(s, "Phase").await;
    let a = in_phase(s, &ph, "a").await;
    let b = in_phase(s, &ph, "b").await;
    let c = in_phase(s, &ph, "c").await;
    let d = in_phase(s, &ph, "d").await;
    let ends = queue_ends(s).await;

    for to in [
        ItemStatus::InProgress,
        ItemStatus::Failed,
        ItemStatus::Deferred,
        ItemStatus::Review,
    ] {
        let e = s
            .update_item(&b, status(to, "no"), &mcp())
            .await
            .unwrap_err();
        assert!(matches!(e, TrackerError::Refused(_)), "{e}");
        assert!(e.to_string().contains("pull it to the queue first"), "{e}");
        assert!(item(s, &b).await.frozen);
        assert_sound(s, P).await;
    }

    // Done from the middle: its neighbours rejoin, the ends stand.
    let rec = s
        .update_item(&b, status(ItemStatus::Done, "done already"), &mcp())
        .await
        .unwrap();
    assert!(!rec.item.frozen && !rec.item.queued);
    assert_eq!(rec.item.phase_id.as_deref(), Some(ph.as_str()));
    assert!(rec.item.prev_id.is_none() && rec.item.next_id.is_none());
    let done = rec.events.last().unwrap();
    assert_eq!(done.fields["frozen"], json!(false));
    assert_eq!(done.before.as_ref().unwrap()["frozen"], json!(true));
    assert_sound(s, P).await;
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![a.clone(), c.clone(), d.clone()]
    );
    assert_eq!(
        queue_ends(s).await,
        ends,
        "the queue's ends were overwritten"
    );
    assert_eq!(assert_sound(s, P).await, vec![q1.clone(), q2.clone()]);

    // Cancelled from the head, then the tail: the phase's ends follow.
    s.update_item(&a, status(ItemStatus::Cancelled, "no"), &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(
        phase_of(s, &ph).await.phase.head_id.as_deref(),
        Some(c.as_str())
    );
    s.update_item(&d, status(ItemStatus::Cancelled, "no"), &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(
        phase_of(s, &ph).await.phase.tail_id.as_deref(),
        Some(c.as_str())
    );
    assert_eq!(queue_ends(s).await, ends);

    // A generated body does not say `Set frozen.`
    s.update_item(
        &c,
        ItemUpdate {
            status: Some(ItemStatus::Done),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let e = last_event(s, &c).await;
    assert!(!e.body.contains("frozen"), "{}", e.body);
    assert_eq!(phase_of(s, &ph).await.phase.head_id, None);
    assert_eq!(phase_of(s, &ph).await.phase.tail_id, None);

    // A reopen lands at the queue's top, unfrozen, keeping the link.
    set_status(s, &b, ItemStatus::Pending).await;
    let rec = item(s, &b).await;
    assert!(!rec.frozen && rec.queued);
    assert_eq!(rec.phase_id.as_deref(), Some(ph.as_str()));
    assert_eq!(
        assert_sound(s, P).await,
        vec![b.clone(), q1.clone(), q2.clone()]
    );
    // It is a queue ticket again: its reopen is not stamped.
    assert!(!last_event(s, &b).await.roadmap);
}

#[tokio::test]
async fn a_frozen_tickets_other_fields_stay_editable() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;
    let t = in_phase(s, &ph, "t").await;
    let rec = s
        .update_item(
            &t,
            ItemUpdate {
                title: Some("new title".into()),
                body: Some("new body".into()),
                assignee: Some("dev-1".into()),
                labels: Some(vec!["Physics".into()]),
                approval: Some(Approval::Owner),
                block_reason: Some(BlockReason::Redesign),
                draft: Some(true),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert!(rec.item.frozen && rec.item.blocked && rec.item.draft);
    assert_eq!(rec.item.title, "new title");
    assert_eq!(rec.item.phase_id.as_deref(), Some(ph.as_str()));
    assert_sound(s, P).await;
    s.update_item(
        &t,
        ItemUpdate {
            blocked: Some(false),
            draft: Some(false),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert!(item(s, &t).await.frozen);
    assert_sound(s, P).await;
}

// ---- 7. Dependencies ------------------------------------------------------------

#[tokio::test]
async fn a_dependency_works_across_the_boundary_either_way() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;

    // Frozen waits on queued; no blocked span while frozen; the unblock fires,
    // stamped, as its ticket is frozen.
    let frozen_waiter = in_phase(s, &ph, "frozen waiter").await;
    let queued_target = create(s, P, "queued target").await;
    wait_on(s, &frozen_waiter, &[&queued_target]).await;
    assert!(item(s, &frozen_waiter).await.blocked);
    assert_eq!(open_span(s, &frozen_waiter, "blocked").await, None);
    finish(s, &queued_target).await;
    assert_sound(s, P).await;
    let waiter = item(s, &frozen_waiter).await;
    assert!(!waiter.blocked && waiter.frozen);
    let e = last_event(s, &frozen_waiter).await;
    assert_eq!(e.kind, EventKind::Unblock);
    assert!(e.roadmap);

    // Queued waits on frozen; the frozen one's done fires the unblock, not
    // stamped, as that ticket is in the queue.
    let queued_waiter = create(s, P, "queued waiter").await;
    let frozen_target = in_phase(s, &ph, "frozen target").await;
    wait_on(s, &queued_waiter, &[&frozen_target]).await;
    assert_eq!(
        open_span(s, &queued_waiter, "blocked").await.as_deref(),
        Some("blocked")
    );
    set_status(s, &frozen_target, ItemStatus::Done).await;
    assert_sound(s, P).await;
    assert!(!item(s, &queued_waiter).await.blocked);
    let e = last_event(s, &queued_waiter).await;
    assert_eq!(e.kind, EventKind::Unblock);
    assert!(!e.roadmap);
    assert!(last_event(s, &frozen_target).await.roadmap);

    // The other order: the block first, then the freeze on either side. Freezing
    // the waiter closes its blocked span; thawing it opens one.
    let target = create(s, P, "target").await;
    let waiter = create(s, P, "waiter").await;
    wait_on(s, &waiter, &[&target]).await;
    assert_eq!(
        open_span(s, &waiter, "blocked").await.as_deref(),
        Some("blocked")
    );
    change(s, &waiter, PhaseChange::Set(ph.clone())).await;
    assert_eq!(open_span(s, &waiter, "blocked").await, None);
    let rec = item(s, &waiter).await;
    assert!(rec.frozen && rec.blocked);
    change(s, &waiter, PhaseChange::Frozen(false)).await;
    assert_eq!(
        open_span(s, &waiter, "blocked").await.as_deref(),
        Some("blocked")
    );
    change(s, &target, PhaseChange::Set(ph.clone())).await;
    assert!(item(s, &target).await.frozen);
    assert!(item(s, &waiter).await.blocked);
    assert_sound(s, P).await;
}

// ---- 8. From --------------------------------------------------------------------

#[tokio::test]
async fn a_frozen_ticket_from_a_request_writes_became_unstamped() {
    let f = fixture().await;
    let s = &f.store;
    let request = s
        .create_item(
            NewItem {
                item_type: ItemType::Request,
                ..new_item(P, "idea")
            },
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    let ph = planned(s, "Phase").await;
    let t = s
        .create_item_in_phase(
            NewItem {
                links: vec![Link {
                    kind: LinkKind::From,
                    target: request.clone(),
                }],
                ..new_item(P, "from it")
            },
            &ph,
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    assert_sound(s, P).await;
    let r = item(s, &request).await;
    assert!(r
        .links
        .iter()
        .any(|l| l.kind == LinkKind::Became && l.target == t));
    let became = last_event(s, &request).await;
    assert_eq!(became.kind, EventKind::Link);
    assert!(!became.roadmap);
    assert!(last_event(s, &t).await.roadmap);
}

// ---- 9. Release -----------------------------------------------------------------

#[tokio::test]
async fn release_joins_the_queue_at_its_place_keeping_order() {
    let f = fixture().await;
    let s = &f.store;
    let q1 = create(s, P, "q1").await;
    let q2 = create(s, P, "q2").await;
    type Position = fn(&[String]) -> usize;
    let phases: [(Place, &str, Position); 4] = [
        (Place::Bottom, "bottom", |order| order.len() - 2),
        (Place::Top, "top", |_| 0),
        (Place::Before(q2.clone()), "before", |order| {
            order.iter().position(|i| i.ends_with("t0002")).unwrap() - 2
        }),
        (Place::After(q1.clone()), "after", |order| {
            order.iter().position(|i| i.ends_with("t0001")).unwrap() + 1
        }),
    ];
    for (place, word, at) in phases {
        let ph = planned(s, word).await;
        let a = in_phase(s, &ph, "a").await;
        let b = in_phase(s, &ph, "b").await;
        let out = s
            .release_phase(&ph, place.clone(), None, &mcp())
            .await
            .unwrap();
        let order = assert_sound(s, P).await;
        let k = at(&order);
        assert_eq!(order[k..k + 2], [a.clone(), b.clone()], "{word}: {order:?}");
        assert!(!item(s, &a).await.frozen && !item(s, &b).await.frozen);
        assert!(item(s, &a).await.queued);
        assert_eq!(item(s, &a).await.phase_id.as_deref(), Some(ph.as_str()));

        let phase = &out.record.phase;
        assert_eq!(phase.state, PhaseState::Released);
        assert!(phase.released_at.is_some());
        assert!(phase.head_id.is_none() && phase.tail_id.is_none());
        assert!(phase.prev_id.is_none() && phase.next_id.is_none());
        assert_eq!(out.moved, 2);
        assert!(!roadmap_order(s, P).await.contains(&ph));
        assert!(frozen_in(s, &ph).await.is_empty());

        let said = match &place {
            Place::Bottom => "bottom".to_string(),
            Place::Top => "top".to_string(),
            Place::Before(x) => format!("before {x}"),
            Place::After(x) => format!("after {x}"),
        };
        assert_eq!(out.placed.as_deref(), Some(said.as_str()));
        let e = out.record.events.last().unwrap();
        assert_eq!(e.kind, EventKind::Release);
        assert_eq!(e.body, "Phase released.");
        assert_eq!(e.fields["tickets"], json!(2));
        assert_eq!(e.fields["placed"], json!(said));
        assert_eq!(e.fields["state"], json!("released"));
        assert_eq!(e.fields["released_at"], json!(phase.released_at));
        assert_eq!(e.before.as_ref().unwrap()["state"], json!("planned"));
        assert_eq!(
            e.before.as_ref().unwrap()["released_at"],
            serde_json::Value::Null
        );
        assert!(!e.roadmap);
        // The phase's event holds the write's last id.
        assert_eq!(e.event_id, s.latest_event_id().await.unwrap());
        // Each moved ticket's history explains its state.
        let moved = last_event(s, &a).await;
        assert_eq!(moved.kind, EventKind::Move);
        assert_eq!(moved.body, format!("Released with phase {ph}."));
        assert_eq!(moved.fields["frozen"], json!(false));
        assert_eq!(moved.before.as_ref().unwrap()["frozen"], json!(true));
        assert!(moved.roadmap);
    }
}

#[tokio::test]
async fn release_with_a_bad_anchor_changes_nothing() {
    let f = fixture().await;
    let s = &f.store;
    let q = create(s, P, "q").await;
    let ph = planned(s, "One").await;
    let a = in_phase(s, &ph, "a").await;
    let other = planned(s, "Two").await;
    let o = in_phase(s, &other, "o").await;
    let empty = planned(s, "Empty").await;
    let closed = create(s, P, "closed").await;
    set_status(s, &closed, ItemStatus::Done).await;
    let events = s.latest_event_id().await.unwrap();
    for (phase, anchor) in [
        (&ph, a.clone()),
        (&ph, o.clone()),
        (&ph, closed.clone()),
        (&ph, "p-t9999".to_string()),
        // Even a phase with nothing to join.
        (&empty, o.clone()),
    ] {
        let e = s
            .release_phase(phase, Place::Before(anchor.clone()), None, &mcp())
            .await
            .unwrap_err();
        assert!(matches!(e, TrackerError::Refused(_)), "{anchor}: {e}");
        assert_eq!(assert_sound(s, P).await, vec![q.clone()]);
        assert_eq!(frozen_in(s, &ph).await, vec![a.clone()]);
        assert_eq!(
            phase_of(s, phase).await.phase.state,
            PhaseState::Planned,
            "{anchor}"
        );
        assert_eq!(s.latest_event_id().await.unwrap(), events);
    }
}

#[tokio::test]
async fn release_of_nothing_and_of_a_draft() {
    let f = fixture().await;
    let s = &f.store;
    // An empty phase releases, marked released.
    let empty = planned(s, "Empty").await;
    let out = s
        .release_phase(&empty, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(out.moved, 0);
    assert_eq!(out.record.phase.state, PhaseState::Released);
    assert_eq!(
        out.record.events.last().unwrap().fields["tickets"],
        json!(0)
    );
    // Only a planned phase releases.
    let e = s
        .release_phase(&empty, Place::Bottom, None, &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("only a planned phase"), "{e}");

    // A draft moves too, still a draft, in the queue view's drafts.
    let ph = planned(s, "Drafts").await;
    let d = draft_in_phase(s, &ph, "d").await;
    let t = in_phase(s, &ph, "t").await;
    assert!(s.queue_view(P).await.unwrap().drafts.is_empty());
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_eq!(assert_sound(s, P).await, vec![d.clone(), t.clone()]);
    let view = s.queue_view(P).await.unwrap();
    assert_eq!(
        view.drafts.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![d.clone()]
    );
    assert_eq!(
        view.queue.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![t]
    );
    assert!(item(s, &d).await.draft);
    assert!(last_event(s, &d).await.draft);
    assert!(last_event(s, &d).await.roadmap);
}

// ---- 10. Recall -----------------------------------------------------------------

#[tokio::test]
async fn recall_freezes_only_the_pending_in_queue_order() {
    let f = fixture().await;
    let s = &f.store;
    let q = create(s, P, "q").await;
    let first = planned(s, "On the roadmap").await;
    let ph = planned(s, "Phase").await;
    let a = in_phase(s, &ph, "a").await;
    let b = in_phase(s, &ph, "b").await;
    let c = in_phase(s, &ph, "c").await;
    let working = in_phase(s, &ph, "working").await;
    let reviewed = in_phase(s, &ph, "in review").await;
    let finished = in_phase(s, &ph, "finished").await;
    let draft = draft_in_phase(s, &ph, "draft").await;
    let blocked = in_phase(s, &ph, "blocked").await;
    s.update_item(
        &blocked,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    // Their queue order is now theirs: c ahead of a, the rest after.
    mv(s, P, &c, Place::Before(a.clone())).await;
    set_status(s, &working, ItemStatus::InProgress).await;
    set_status(s, &reviewed, ItemStatus::Review).await;
    set_status(s, &finished, ItemStatus::Done).await;
    // A ticket reopened or created later is pending too, wherever it sits.
    let late = in_phase(s, &ph, "late").await;
    mv(s, P, &late, Place::Top).await;

    let out = s.recall_phase(&ph, Some("Not yet."), &mcp()).await.unwrap();
    assert_eq!(out.moved, 6);
    assert_eq!(out.placed, None);
    assert_eq!(
        frozen_in(s, &ph).await,
        vec![
            late.clone(),
            c.clone(),
            a.clone(),
            b.clone(),
            draft.clone(),
            blocked.clone()
        ]
    );
    assert_eq!(
        assert_sound(s, P).await,
        vec![q.clone(), working.clone(), reviewed.clone()]
    );
    // What stays keeps its link; the draft and the blocked one are frozen as they are.
    assert_eq!(
        item(s, &working).await.phase_id.as_deref(),
        Some(ph.as_str())
    );
    assert_eq!(item(s, &finished).await.status, ItemStatus::Done);
    assert!(item(s, &draft).await.draft && item(s, &draft).await.frozen);
    assert!(item(s, &blocked).await.blocked && item(s, &blocked).await.frozen);

    let phase = &out.record.phase;
    assert_eq!(phase.state, PhaseState::Planned);
    assert_eq!(phase.released_at, None);
    // The top of the roadmap, as it is next.
    assert_eq!(roadmap_order(s, P).await, vec![ph.clone(), first.clone()]);

    let e = out.record.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Recall);
    assert_eq!(e.body, "Phase recalled. Not yet.");
    assert_eq!(e.fields["tickets"], json!(6));
    assert_eq!(e.fields["released_at"], serde_json::Value::Null);
    assert_eq!(e.before.as_ref().unwrap()["state"], json!("released"));
    assert!(!e.roadmap);
    assert_eq!(e.event_id, s.latest_event_id().await.unwrap());
    let moved = last_event(s, &a).await;
    assert_eq!(moved.body, format!("Recalled with phase {ph}."));
    assert_eq!(moved.fields["frozen"], json!(true));
    assert_eq!(moved.before.as_ref().unwrap()["frozen"], json!(false));
    assert!(moved.roadmap);

    // Only a released phase recalls.
    let e = s.recall_phase(&ph, None, &mcp()).await.unwrap_err();
    assert!(e.to_string().contains("only a released phase"), "{e}");

    // Releasing again adds only the frozen, at the tail.
    let out = s
        .release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_eq!(out.moved, 6);
    assert_eq!(
        assert_sound(s, P).await,
        vec![q, working, reviewed, late, c, a, b, draft, blocked]
    );
}

#[tokio::test]
async fn a_phase_with_nothing_pending_recalls_with_no_tickets() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;
    let a = in_phase(s, &ph, "a").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    set_status(s, &a, ItemStatus::InProgress).await;
    let out = s.recall_phase(&ph, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(out.moved, 0);
    assert_eq!(out.record.phase.state, PhaseState::Planned);
    assert_eq!(out.record.events.last().unwrap().body, "Phase recalled.");
    assert_eq!(
        out.record.events.last().unwrap().fields["tickets"],
        json!(0)
    );
}

// ---- 11. Archive ----------------------------------------------------------------

#[tokio::test]
async fn archive_and_unarchive_per_state() {
    let f = fixture().await;
    let s = &f.store;
    // Planned and empty: out of the roadmap; back at its bottom.
    let a = planned(s, "A").await;
    let b = planned(s, "B").await;
    let c = planned(s, "C").await;
    let rec = s.archive_phase(&a, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(rec.phase.state, PhaseState::Archived);
    assert!(rec.phase.prev_id.is_none() && rec.phase.next_id.is_none());
    assert_eq!(roadmap_order(s, P).await, vec![b.clone(), c.clone()]);
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Edit);
    assert_eq!(e.fields["state"], json!("archived"));
    assert_eq!(e.before.as_ref().unwrap()["state"], json!("planned"));
    assert!(e.roadmap);
    let again = s.archive_phase(&a, None, &mcp()).await.unwrap_err();
    assert!(again.to_string().contains("already archived"), "{again}");

    let rec = s.unarchive_phase(&a, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(rec.phase.state, PhaseState::Planned);
    assert_eq!(
        roadmap_order(s, P).await,
        vec![b.clone(), c.clone(), a.clone()]
    );
    let not = s.unarchive_phase(&a, None, &mcp()).await.unwrap_err();
    assert!(not.to_string().contains("only an archived phase"), "{not}");

    // Planned with a frozen ticket: refused, naming the count.
    let t = in_phase(s, &b, "frozen").await;
    let u = in_phase(s, &b, "frozen too").await;
    let e = s.archive_phase(&b, None, &mcp()).await.unwrap_err();
    assert!(e.to_string().contains("2 open tickets"), "{e}");
    assert!(
        e.to_string().contains("cancel, move or release them first"),
        "{e}"
    );
    assert_eq!(phase_of(s, &b).await.phase.state, PhaseState::Planned);
    // A pulled open ticket blocks it too.
    change(s, &t, PhaseChange::Frozen(false)).await;
    set_status(s, &u, ItemStatus::Cancelled).await;
    let e = s.archive_phase(&b, None, &mcp()).await.unwrap_err();
    assert!(e.to_string().contains("1 open ticket"), "{e}");
    // Closed, it goes, tickets keeping the link.
    set_status(s, &t, ItemStatus::Done).await;
    s.archive_phase(&b, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(item(s, &t).await.phase_id.as_deref(), Some(b.as_str()));

    // Released: archived whatever its tickets, and back to released.
    let r = planned(s, "R").await;
    let open = in_phase(s, &r, "open").await;
    s.release_phase(&r, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    let rec = s.archive_phase(&r, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(rec.phase.state, PhaseState::Archived);
    assert!(rec.phase.released_at.is_some());
    assert!(item(s, &open).await.queued);
    let rec = s.unarchive_phase(&r, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(rec.phase.state, PhaseState::Released);
    assert!(!roadmap_order(s, P).await.contains(&r));
}

#[tokio::test]
async fn a_phase_edits_and_moves_and_answers_with_its_size() {
    let f = fixture().await;
    let s = &f.store;
    let a = planned(s, "A").await;
    let b = planned(s, "B").await;
    let c = planned(s, "C").await;

    // Edit, a note, and neither.
    let rec = s
        .update_phase(
            &a,
            PhaseUpdate {
                title: Some("Creatures".into()),
                body: Some("# Plan".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.phase.title, "Creatures");
    assert_eq!(rec.phase.body, "# Plan");
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Edit);
    assert_eq!(e.before.as_ref().unwrap()["title"], json!("A"));
    let rec = s
        .update_phase(
            &a,
            PhaseUpdate {
                note: Some("Reviewed.".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.events.last().unwrap().kind, EventKind::Note);
    let same = PhaseUpdate {
        title: Some("Creatures".into()),
        ..Default::default()
    };
    let e = s.update_phase(&a, same, &mcp()).await.unwrap_err();
    assert!(e.to_string().contains("nothing to update"), "{e}");
    let blank = PhaseUpdate {
        title: Some("  ".into()),
        ..Default::default()
    };
    assert!(s.update_phase(&a, blank, &mcp()).await.is_err());
    assert_sound(s, P).await;

    // Moves, each of the four.
    s.move_phase(&c, Place::Top, None, &mcp()).await.unwrap();
    assert_eq!(
        roadmap_order(s, P).await,
        vec![c.clone(), a.clone(), b.clone()]
    );
    assert_sound(s, P).await;
    s.move_phase(&c, Place::Bottom, None, &mcp()).await.unwrap();
    assert_eq!(
        roadmap_order(s, P).await,
        vec![a.clone(), b.clone(), c.clone()]
    );
    assert_sound(s, P).await;
    s.move_phase(&c, Place::Before(b.clone()), None, &mcp())
        .await
        .unwrap();
    assert_eq!(
        roadmap_order(s, P).await,
        vec![a.clone(), c.clone(), b.clone()]
    );
    assert_sound(s, P).await;
    let rec = s
        .move_phase(&a, Place::After(b.clone()), None, &mcp())
        .await
        .unwrap();
    assert_eq!(
        roadmap_order(s, P).await,
        vec![c.clone(), b.clone(), a.clone()]
    );
    assert_sound(s, P).await;
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Move);
    assert_eq!(e.fields["prev_id"], json!(b));
    assert_eq!(
        e.before.as_ref().unwrap()["prev_id"],
        serde_json::Value::Null
    );

    // Refused: relative to itself, an unknown phase, one not planned, another
    // project's; and any phase that is not planned. Nothing changes.
    let done = released(s, "Released").await;
    let other = s
        .create_phase(plan("other", "Theirs"), &mcp())
        .await
        .unwrap()
        .phase
        .id;
    for place in [
        Place::Before(a.clone()),
        Place::After("p-p9999".to_string()),
        Place::Before(done.clone()),
        Place::After(other.clone()),
    ] {
        let e = s.move_phase(&a, place, None, &mcp()).await.unwrap_err();
        assert!(matches!(e, TrackerError::Refused(_)), "{e}");
        assert_eq!(
            roadmap_order(s, P).await,
            vec![c.clone(), b.clone(), a.clone()]
        );
        assert_sound(s, P).await;
    }
    let e = s
        .move_phase(&done, Place::Top, None, &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("only a planned phase"), "{e}");

    // The record's JSON: `released_at` is always there, `tickets` only if asked.
    let plain = serde_json::to_value(phase_of(s, &a).await).unwrap();
    assert!(plain.get("released_at").is_some_and(|v| v.is_null()));
    assert!(plain.get("tickets").is_none() && plain.get("would_wait").is_none());
    let full = s.get_phase(&a, false, true).await.unwrap().unwrap();
    let full = serde_json::to_value(full).unwrap();
    assert!(full.get("tickets").is_some() && full.get("would_wait").is_some());
    assert_eq!(
        s.get_phase("p-p9999", true, true)
            .await
            .unwrap()
            .map(|r| r.phase.id),
        None
    );
}

#[tokio::test]
async fn a_phases_size_and_its_tickets_order() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;
    // Planned: frozen, a frozen draft, a frozen blocked one, one pulled.
    let frozen = in_phase(s, &ph, "frozen").await;
    let draft = draft_in_phase(s, &ph, "draft").await;
    let blocked = in_phase(s, &ph, "blocked").await;
    s.update_item(
        &blocked,
        ItemUpdate {
            block_reason: Some(BlockReason::Review),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let pulled = in_phase(s, &ph, "pulled").await;
    change(s, &pulled, PhaseChange::Frozen(false)).await;
    let done = in_phase(s, &ph, "done").await;
    set_status(s, &done, ItemStatus::Done).await;
    let gone = in_phase(s, &ph, "gone").await;
    set_status(s, &gone, ItemStatus::Cancelled).await;
    let queue_head = create(s, P, "ahead of it").await;
    mv(s, P, &queue_head, Place::Top).await;
    let rec = s.get_phase(&ph, false, true).await.unwrap().unwrap();
    assert_eq!(
        rec.size,
        PhaseSize {
            frozen: 2,
            open: 1,
            done: 1,
            cancelled: 1,
            drafts: 1,
            blocked: 1,
            total: 6,
            complete: false,
        }
    );
    // Frozen in phase order, unfrozen queued in queue order, the rest by age.
    assert_eq!(
        rec.tickets
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect::<Vec<_>>(),
        vec![
            frozen.clone(),
            draft.clone(),
            blocked.clone(),
            pulled.clone(),
            done.clone(),
            gone.clone()
        ]
    );
    // The listing agrees, and filters; another project's or an unknown is not found.
    let listed = s.list_phase_items(P, &ph, None, None).await.unwrap();
    assert_eq!(listed.len(), 6);
    let only = s
        .list_phase_items(P, &ph, Some(ItemStatus::Done), None)
        .await
        .unwrap();
    assert_eq!(
        only.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![done.clone()]
    );
    for (project, phase) in [("other", ph.as_str()), (P, "p-p9999")] {
        let e = s
            .list_phase_items(project, phase, None, None)
            .await
            .unwrap_err();
        assert!(matches!(e, TrackerError::NotFound(_)), "{e}");
    }
    // A phase id reaches SQL by a bind: this one matches nothing.
    let e = s
        .list_phase_items(P, "x' OR '1'='1", None, None)
        .await
        .unwrap_err();
    assert!(matches!(e, TrackerError::NotFound(_)), "{e}");

    // Complete is derived: a released phase with every linked ticket closed.
    let empty = released(s, "Empty").await;
    assert!(!phase_of(s, &empty).await.size.complete, "no linked ticket");
    let rel = planned(s, "Released").await;
    let a = in_phase(s, &rel, "a").await;
    let d = draft_in_phase(s, &rel, "d").await;
    // Planned with everything closed is not complete.
    set_status(s, &a, ItemStatus::Done).await;
    set_status(s, &d, ItemStatus::Cancelled).await;
    assert!(!phase_of(s, &rel).await.size.complete);
    s.release_phase(&rel, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    let size = phase_of(s, &rel).await.size;
    assert!(size.complete);
    assert_eq!(
        (size.done, size.cancelled, size.drafts, size.total),
        (1, 0, 1, 2)
    );
    // Reopening makes it incomplete; a pending draft is open.
    set_status(s, &d, ItemStatus::Pending).await;
    assert!(!phase_of(s, &rel).await.size.complete);
    assert_sound(s, P).await;
}

// ---- 12. D13 --------------------------------------------------------------------

fn waits(pairs: &[(&str, &str)]) -> Vec<Waiting> {
    pairs
        .iter()
        .map(|(ticket, on)| Waiting {
            ticket: ticket.to_string(),
            on: on.to_string(),
        })
        .collect()
}

async fn would_wait(s: &TrackerStore, phase: &str) -> Vec<Waiting> {
    s.get_phase(phase, false, true)
        .await
        .unwrap()
        .unwrap()
        .would_wait
        .unwrap()
}

#[tokio::test]
async fn what_a_release_leaves_waiting_is_what_the_read_said_it_would() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "This").await;
    let later = planned(s, "Later").await;
    let a = in_phase(s, &ph, "a").await;
    let b = in_phase(s, &later, "b").await;
    // A released ticket would wait on a ticket of a phase still planned.
    wait_on(s, &a, &[&b]).await;
    // A queued ticket on a frozen one is not this release's, linked to neither.
    let x = create(s, P, "x").await;
    wait_on(s, &x, &[&b]).await;
    // A frozen pair in this phase crosses nothing: both thaw.
    let c = in_phase(s, &ph, "c").await;
    let d = in_phase(s, &ph, "d").await;
    wait_on(s, &c, &[&d]).await;

    let said = would_wait(s, &ph).await;
    assert_eq!(said, waits(&[(a.as_str(), b.as_str())]));
    let out = s
        .release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(out.waiting, said);
    assert_eq!(out.moved, 3);

    // Later's release leaves nothing waiting: its one ticket thaws.
    assert!(would_wait(s, &later).await.is_empty());
    let out = s
        .release_phase(&later, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert!(out.waiting.is_empty());
    assert_sound(s, P).await;
}

#[tokio::test]
async fn what_a_recall_leaves_waiting_is_what_the_read_said_it_would() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "This").await;
    let a = in_phase(s, &ph, "a").await;
    let c = in_phase(s, &ph, "c").await;
    let frozen_too = in_phase(s, &ph, "frozen too").await;
    let later = planned(s, "Later").await;
    let b = in_phase(s, &later, "b").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    // A ticket outside it waits on one it would freeze.
    let x = create(s, P, "x").await;
    wait_on(s, &x, &[&a]).await;
    // One of its own that stays waits on one it would freeze.
    set_status(s, &c, ItemStatus::InProgress).await;
    wait_on(s, &c, &[&a]).await;
    // One it freezes that waits on another phase's: frozen, it no longer crosses.
    wait_on(s, &frozen_too, &[&b]).await;
    // An unrelated pair is not its business.
    let y = create(s, P, "y").await;
    let z = create(s, P, "z").await;
    wait_on(s, &y, &[&z]).await;

    let said = would_wait(s, &ph).await;
    assert_eq!(
        said,
        waits(&[(c.as_str(), a.as_str()), (x.as_str(), a.as_str())])
    );
    let out = s.recall_phase(&ph, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(out.waiting, said);
    assert_eq!(out.moved, 2);
    // An archived phase has neither to come.
    let done = archived(s, "Archived").await;
    assert!(would_wait(s, &done).await.is_empty());
    // Nothing crossing: empty.
    let empty = planned(s, "Empty").await;
    assert!(would_wait(s, &empty).await.is_empty());
}

// ---- 13. Stamping ---------------------------------------------------------------

#[tokio::test]
async fn every_roadmap_write_is_stamped_and_nothing_else_is() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;
    let other = planned(s, "Other").await;
    let rel = released(s, "Released").await;
    // The phase's own events: create, edit, move, archive, all stamped.
    assert!(last_phase_event(s, &ph).await.roadmap, "phase create");
    s.update_phase(
        &ph,
        PhaseUpdate {
            title: Some("New".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert!(last_phase_event(s, &ph).await.roadmap, "phase edit");
    s.update_phase(
        &ph,
        PhaseUpdate {
            note: Some("A note.".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert!(last_phase_event(s, &ph).await.roadmap, "phase note");
    s.move_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert!(last_phase_event(s, &ph).await.roadmap, "phase move");
    let gone = archived(s, "Gone").await;
    assert!(last_phase_event(s, &gone).await.roadmap, "phase archive");

    // A ticket: freeze, edit while frozen, thaw, pull, done and cancel from frozen.
    let t = create(s, P, "t").await;
    assert!(!last_event(s, &t).await.roadmap, "a queue create");
    change(s, &t, PhaseChange::Set(ph.clone())).await;
    assert!(last_event(s, &t).await.roadmap, "freeze");
    s.update_item(
        &t,
        ItemUpdate {
            title: Some("edited".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert!(last_event(s, &t).await.roadmap, "edit while frozen");
    change(s, &t, PhaseChange::Set(rel.clone())).await;
    assert!(
        last_event(s, &t).await.roadmap,
        "thaw into a released phase"
    );
    // After thaw, an edit is a queue ticket's.
    s.update_item(
        &t,
        ItemUpdate {
            title: Some("edited again".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert!(!last_event(s, &t).await.roadmap, "after thaw an edit");

    let u = in_phase(s, &ph, "u").await;
    assert!(last_event(s, &u).await.roadmap, "a frozen create");
    change(s, &u, PhaseChange::Frozen(false)).await;
    assert!(last_event(s, &u).await.roadmap, "pull");
    let v = in_phase(s, &ph, "v").await;
    set_status(s, &v, ItemStatus::Done).await;
    assert!(last_event(s, &v).await.roadmap, "done from frozen");
    let w = in_phase(s, &ph, "w").await;
    set_status(s, &w, ItemStatus::Cancelled).await;
    assert!(last_event(s, &w).await.roadmap, "cancel from frozen");

    // A link-only write on an unfrozen ticket, and a removal.
    let l = create(s, P, "l").await;
    change(s, &l, PhaseChange::Set(rel.clone())).await;
    assert!(last_event(s, &l).await.roadmap, "a link-only write");
    change(s, &l, PhaseChange::Clear).await;
    assert!(last_event(s, &l).await.roadmap, "a removal");

    // A create in a released phase is a queue ticket arriving.
    let r = in_phase(s, &rel, "r").await;
    assert!(!last_event(s, &r).await.roadmap, "a released-phase create");

    // The frozen draft: both flags until published; published, the second alone.
    let d = draft_in_phase(s, &other, "d").await;
    let created = last_event(s, &d).await;
    assert!(created.draft && created.roadmap, "a frozen draft's create");
    s.update_item(
        &d,
        ItemUpdate {
            draft: Some(false),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let published = last_event(s, &d).await;
    assert!(
        !published.draft && published.roadmap,
        "publish of a frozen draft"
    );

    // Release and recall: each ticket's event stamped, the phase's own not.
    let out = s
        .release_phase(&other, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert!(!out.record.events.last().unwrap().roadmap, "release");
    assert!(last_event(s, &d).await.roadmap, "a released ticket's move");
    let out = s.recall_phase(&other, None, &mcp()).await.unwrap();
    assert!(!out.record.events.last().unwrap().roadmap, "recall");
    assert!(last_event(s, &d).await.roadmap, "a recalled ticket's move");
    assert_sound(s, P).await;
}

// ---- 14. The feed ---------------------------------------------------------------

#[tokio::test]
async fn stamped_events_are_out_of_the_feed_unless_asked_for() {
    let f = fixture().await;
    let s = &f.store;
    let mut rx = s.subscribe();
    let since = s.latest_event_id().await.unwrap();
    let ph = planned(s, "Creatures").await;
    let a = in_phase(s, &ph, "a").await;
    let q = create(s, P, "q").await;
    change(s, &a, PhaseChange::Frozen(false)).await;
    change(s, &a, PhaseChange::Frozen(true)).await;

    let default = s
        .events_after(&FeedFilter::default(), since, None)
        .await
        .unwrap();
    assert_eq!(
        default
            .iter()
            .map(|e| e.target_id.clone())
            .collect::<Vec<_>>(),
        vec![q.clone()],
        "only the queue ticket's create reaches a default feed"
    );
    let asked = FeedFilter {
        roadmap: true,
        ..FeedFilter::default()
    };
    let all = s.events_after(&asked, since, None).await.unwrap();
    assert_eq!(all.len(), 5);
    assert!(all.iter().any(|e| e.target_id == ph && e.roadmap));
    assert_eq!(
        s.count_events_after(&FeedFilter::default(), since)
            .await
            .unwrap(),
        1
    );
    assert_eq!(s.count_events_after(&asked, since).await.unwrap(), 5);
    // The phase's title is read for its frame.
    let created = all.iter().find(|e| e.target_id == ph).unwrap();
    assert_eq!(created.title.as_deref(), Some("Creatures"));
    assert_eq!(created.target_kind, TargetKind::Phase);
    assert_eq!(created.target_label(), format!("phase:{ph}"));

    // `matches` is the same test as the SQL.
    for filter in [FeedFilter::default(), asked.clone()] {
        let sql: Vec<i64> = s
            .events_after(&filter, since, None)
            .await
            .unwrap()
            .iter()
            .map(|e| e.event_id)
            .collect();
        let rust: Vec<i64> = all
            .iter()
            .filter(|e| filter.matches(e))
            .map(|e| e.event_id)
            .collect();
        assert_eq!(sql, rust);
    }
    // A draft's stamped event needs both.
    let d = draft_in_phase(s, &ph, "d").await;
    let e = s.events_after(&asked, since, None).await.unwrap();
    assert!(
        e.iter().all(|e| e.target_id != d),
        "drafts were not asked for"
    );
    let both = FeedFilter {
        roadmap: true,
        drafts: true,
        ..FeedFilter::default()
    };
    let e = s.events_after(&both, since, None).await.unwrap();
    assert!(e.iter().any(|e| e.target_id == d));

    // A live subscriber receives them, as a replay would show them.
    let mut live = Vec::new();
    while let Ok(e) = rx.try_recv() {
        live.push(e);
    }
    let all = s.events_after(&both, since, None).await.unwrap();
    assert_eq!(
        live.iter().map(|e| e.event_id).collect::<Vec<_>>(),
        all.iter().map(|e| e.event_id).collect::<Vec<_>>(),
        "stamped events never reached the channel"
    );
    assert!(live.iter().any(|e| e.roadmap));
}

#[tokio::test]
async fn a_release_is_one_frame_under_the_default_kinds() {
    assert!(DEFAULT_FEED_KINDS.contains(&EventKind::Release));
    assert!(DEFAULT_FEED_KINDS.contains(&EventKind::Recall));
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Creatures").await;
    for t in ["a", "b", "c"] {
        in_phase(s, &ph, t).await;
    }
    let since = s.latest_event_id().await.unwrap();
    let out = s
        .release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    let event_id = out.record.events.last().unwrap().event_id;
    let filter = FeedFilter {
        kinds: Some(DEFAULT_FEED_KINDS.to_vec()),
        ..FeedFilter::default()
    };
    let frames = s.events_after(&filter, since, None).await.unwrap();
    assert_eq!(frames.len(), 1, "{frames:?}");
    let release = &frames[0];
    assert_eq!(release.event_id, event_id);
    assert_eq!(release.kind, EventKind::Release);
    assert_eq!(
        release.line(),
        format!(
            "#{event_id} p mcp release phase:{ph} \"Creatures\" {{state: planned → released; \
             tickets: 3; placed: bottom}}: Phase released. [Claude Test]"
        )
    );
    // Asked for, the three tickets' moves are there, marked, and the frame's last.
    let asked = FeedFilter {
        roadmap: true,
        ..FeedFilter::default()
    };
    let all = s.events_after(&asked, since, None).await.unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(all.last().unwrap().event_id, event_id);
    assert!(
        all[0].line().contains(" (roadmap) {frozen: yes → no}"),
        "{}",
        all[0].line()
    );

    // A recall: the same, with a note that follows the words and never replaces them.
    let since = s.latest_event_id().await.unwrap();
    s.recall_phase(&ph, Some("Not yet."), &mcp()).await.unwrap();
    let frames = s.events_after(&filter, since, None).await.unwrap();
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert!(
        frames[0].line().contains(
            "{state: released → planned; tickets: 3}: Phase recalled. Not yet. [Claude Test]"
        ),
        "{}",
        frames[0].line()
    );

    // A release's note follows it too.
    let since = s.latest_event_id().await.unwrap();
    s.release_phase(&ph, Place::Top, Some("Go."), &mcp())
        .await
        .unwrap();
    let frames = s.events_after(&filter, since, None).await.unwrap();
    assert_eq!(frames[0].body, "Phase released. Go.");

    // A burst quotes it as it quotes a note, so it still says what it was.
    let note = FeedEvent {
        event_id: frames[0].event_id + 1,
        kind: EventKind::Note,
        target_kind: TargetKind::Item,
        target_id: "p-t0001".into(),
        body: "Noted.".into(),
        ..frames[0].clone()
    };
    let burst = burst_line(&[frames[0].clone(), note]);
    assert!(
        burst.contains(&format!(
            "phase:{ph} \"Creatures\": release {{state: planned → released; tickets: 3; placed: \
             top}}: Phase released. Go."
        )),
        "{burst}"
    );
    // Several on one record count in the phase's own words.
    let again = FeedEvent {
        event_id: frames[0].event_id + 1,
        ..frames[0].clone()
    };
    let burst = burst_line(&[frames[0].clone(), again]);
    assert!(burst.contains("2 phase releases"), "{burst}");
    let recall = FeedEvent {
        event_id: frames[0].event_id + 1,
        kind: EventKind::Recall,
        ..frames[0].clone()
    };
    let burst = burst_line(&[frames[0].clone(), recall]);
    assert!(burst.contains("1 phase recall"), "{burst}");
}

#[test]
fn a_change_names_frozen_and_phase_after_the_status() {
    let said = describe_changes(
        EventKind::Move,
        TargetKind::Item,
        &json!({ "frozen": false, "phase": "p-p0002", "prev_id": "p-t0001" }),
        Some(&json!({ "frozen": true, "phase": "p-p0001", "prev_id": null })),
    );
    assert_eq!(
        said,
        vec![
            "moved: top → after p-t0001",
            "frozen: yes → no",
            "phase: p-p0001 → p-p0002"
        ]
    );
    let cleared = describe_changes(
        EventKind::Link,
        TargetKind::Item,
        &json!({ "phase": null }),
        Some(&json!({ "phase": "p-p0001" })),
    );
    assert_eq!(cleared, vec!["phase: p-p0001 → none"]);
}

// ---- 15. Spans ------------------------------------------------------------------

#[tokio::test]
async fn the_status_span_reads_frozen_while_frozen_and_never_the_status() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;
    let t = create(s, P, "t").await;
    assert_eq!(open_span(s, &t, "status").await.as_deref(), Some("pending"));
    // Freeze.
    change(s, &t, PhaseChange::Set(ph.clone())).await;
    assert_eq!(open_span(s, &t, "status").await.as_deref(), Some("frozen"));
    assert_eq!(item(s, &t).await.status, ItemStatus::Pending);
    // Thaw.
    change(s, &t, PhaseChange::Frozen(false)).await;
    assert_eq!(open_span(s, &t, "status").await.as_deref(), Some("pending"));
    // Release and recall.
    let u = in_phase(s, &ph, "u").await;
    assert_eq!(open_span(s, &u, "status").await.as_deref(), Some("frozen"));
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    assert_eq!(open_span(s, &u, "status").await.as_deref(), Some("pending"));
    s.recall_phase(&ph, None, &mcp()).await.unwrap();
    assert_sound(s, P).await;
    assert_eq!(open_span(s, &u, "status").await.as_deref(), Some("frozen"));
    // Done from frozen.
    set_status(s, &u, ItemStatus::Done).await;
    assert_sound(s, P).await;
    assert_eq!(open_span(s, &u, "status").await.as_deref(), Some("done"));
    // The state is never an item status.
    let statuses: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items WHERE status = 'frozen'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(statuses, 0);
    assert!(ItemStatus::from_str("frozen").is_err());
}

#[tokio::test]
async fn the_backfill_replays_the_frozen_flag() {
    let f = fixture().await;
    let s = &f.store;
    let ph = planned(s, "Phase").await;
    let frozen = in_phase(s, &ph, "frozen").await;
    let pulled = in_phase(s, &ph, "pulled").await;
    change(s, &pulled, PhaseChange::Frozen(false)).await;
    let refrozen = create(s, P, "refrozen").await;
    change(s, &refrozen, PhaseChange::Set(ph.clone())).await;
    let blocked = in_phase(s, &ph, "blocked").await;
    s.update_item(
        &blocked,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    // Rebuild every span from the events, as the backfill does.
    let live: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT item_id, track, state FROM item_spans ORDER BY item_id, track, started_event, state",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM item_spans")
        .execute(&s.pool)
        .await
        .unwrap();
    let mut tx = s.write_tx().await.unwrap();
    let done = crate::tracker::spans::backfill(&mut tx)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(done.corrected, 0, "the replay disagreed with a row");
    let rebuilt: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT item_id, track, state FROM item_spans ORDER BY item_id, track, started_event, state",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(rebuilt, live);
    assert_spans_match_rows(s).await;
    assert_eq!(
        open_span(s, &frozen, "status").await.as_deref(),
        Some("frozen")
    );
    assert_eq!(open_span(s, &blocked, "blocked").await, None);
}

// ---- 16. Figures ----------------------------------------------------------------

/// Pins the events written since it last ran, and the spans they opened and
/// closed, at a time, so real write paths give figures over pinned moments.
struct Clock {
    last: i64,
}

impl Clock {
    async fn new(s: &TrackerStore) -> Self {
        Self {
            last: s.latest_event_id().await.unwrap(),
        }
    }

    async fn at(&mut self, s: &TrackerStore, ts: &str) {
        for sql in [
            "UPDATE events SET ts = ? WHERE event_id > ?",
            "UPDATE item_spans SET started_at = ? WHERE started_event > ?",
            "UPDATE item_spans SET ended_at = ? WHERE ended_event > ?",
        ] {
            sqlx::query(sql)
                .bind(ts)
                .bind(self.last)
                .execute(&s.pool)
                .await
                .unwrap();
        }
        self.last = s.latest_event_id().await.unwrap();
    }
}

async fn week(s: &TrackerStore) -> Report {
    s.report(P, ReportWindow::Week, now()).await.unwrap()
}

fn bucket(r: &Report, at: &str) -> usize {
    r.buckets
        .iter()
        .position(|b| b.start == at)
        .unwrap_or_else(|| panic!("no bucket starts at {at}"))
}

fn total(r: &Report, f: fn(&Bucket) -> i64) -> i64 {
    r.buckets.iter().map(f).sum()
}

#[tokio::test]
async fn a_recall_lowers_remaining_with_no_done_bar() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    in_phase(s, &ph, "t").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-03T10:00:00Z").await;
    s.recall_phase(&ph, None, &mcp()).await.unwrap();
    clock.at(s, "2026-11-04T11:00:00Z").await;
    assert_sound(s, P).await;

    let r = week(s).await;
    let at = |t: &str| r.buckets[bucket(&r, t)].remaining;
    assert_eq!(at("2026-11-03T09:00:00Z"), 0, "frozen is not remaining");
    assert_eq!(at("2026-11-03T10:00:00Z"), 1, "released");
    assert_eq!(at("2026-11-04T10:00:00Z"), 1, "still released");
    assert_eq!(at("2026-11-04T11:00:00Z"), 0, "recalled");
    assert_eq!(r.buckets.last().unwrap().remaining, 0);
    assert_eq!(total(&r, |b| b.done), 0);
    // A past figure is right, however the ticket ends up.
    assert_eq!(total(&r, |b| b.added), 1);
}

#[tokio::test]
async fn added_is_the_first_entry_into_a_counted_state_once() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    // Created frozen, released, recalled, released: added once, at the first.
    let ph = planned(s, "Phase").await;
    in_phase(s, &ph, "t").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-03T10:00:00Z").await;
    s.recall_phase(&ph, None, &mcp()).await.unwrap();
    clock.at(s, "2026-11-04T10:00:00Z").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-05T10:00:00Z").await;
    let r = week(s).await;
    assert_eq!(total(&r, |b| b.added), 1);
    assert_eq!(r.buckets[bucket(&r, "2026-11-03T10:00:00Z")].added, 1);
    assert_sound(s, P).await;
}

#[tokio::test]
async fn a_frozen_draft_is_added_at_the_later_of_its_publication_and_its_thaw() {
    let publish = || ItemUpdate {
        draft: Some(false),
        ..Default::default()
    };

    // Published, then released: at the release.
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    let d = draft_in_phase(s, &ph, "d").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    s.update_item(&d, publish(), &mcp()).await.unwrap();
    clock.at(s, "2026-11-03T09:00:00Z").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-04T09:00:00Z").await;
    let r = week(s).await;
    assert_eq!(total(&r, |b| b.added), 1);
    assert_eq!(r.buckets[bucket(&r, "2026-11-04T09:00:00Z")].added, 1);

    // Released, then published: at the publication.
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    let d = draft_in_phase(s, &ph, "d").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-03T09:00:00Z").await;
    s.update_item(&d, publish(), &mcp()).await.unwrap();
    clock.at(s, "2026-11-04T09:00:00Z").await;
    let r = week(s).await;
    assert_eq!(total(&r, |b| b.added), 1);
    assert_eq!(r.buckets[bucket(&r, "2026-11-04T09:00:00Z")].added, 1);

    // Published and never thawed: not added.
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    let d = draft_in_phase(s, &ph, "d").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    s.update_item(&d, publish(), &mcp()).await.unwrap();
    clock.at(s, "2026-11-03T09:00:00Z").await;
    assert_eq!(total(&week(s).await, |b| b.added), 0);

    // Created frozen before the window and released in it: added.
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    in_phase(s, &ph, "t").await;
    clock.at(s, "2026-10-01T09:00:00Z").await;
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-03T09:00:00Z").await;
    let r = week(s).await;
    assert_eq!(total(&r, |b| b.added), 1);
    assert_eq!(r.buckets[bucket(&r, "2026-11-03T09:00:00Z")].added, 1);
}

#[tokio::test]
async fn straight_from_frozen_to_done_is_no_completion_until_it_is_reopened() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    let t = in_phase(s, &ph, "t").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    set_status(s, &t, ItemStatus::Done).await;
    clock.at(s, "2026-11-03T09:00:00Z").await;

    let r = week(s).await;
    assert_eq!(total(&r, |b| b.done), 0, "no bar");
    assert_eq!(total(&r, |b| b.added), 0, "never added");
    assert_eq!(r.velocity.done, 0, "not in velocity");
    assert_eq!(r.mttc.count, 0);
    assert_eq!(r.mttc.never_in_progress, 0, "not in MTTC");
    let v = s.velocity(P, now()).await.unwrap();
    assert_eq!(v.windows.week.done, 0);

    // Reopened, it is added at the reopen, and its next done counts.
    set_status(s, &t, ItemStatus::Pending).await;
    clock.at(s, "2026-11-04T09:00:00Z").await;
    let r = week(s).await;
    assert_eq!(total(&r, |b| b.added), 1);
    assert_eq!(r.buckets[bucket(&r, "2026-11-04T09:00:00Z")].added, 1);
    assert_eq!(r.buckets.last().unwrap().remaining, 1);
    set_status(s, &t, ItemStatus::Done).await;
    clock.at(s, "2026-11-05T09:00:00Z").await;
    let r = week(s).await;
    assert_eq!(total(&r, |b| b.done), 1);
    assert_eq!(r.buckets[bucket(&r, "2026-11-05T09:00:00Z")].done, 1);
    assert_eq!(r.velocity.done, 1, "velocity.done equals the report's");
    assert_eq!(r.mttc.never_in_progress, 1);
    assert_eq!(s.velocity(P, now()).await.unwrap().windows.week.done, 1);
    assert_sound(s, P).await;
}

#[tokio::test]
async fn a_past_done_of_a_ticket_since_frozen_still_counts() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let t = create(s, P, "t").await;
    clock.at(s, "2026-11-02T09:00:00Z").await;
    finish(s, &t).await;
    clock.at(s, "2026-11-02T10:00:00Z").await;
    set_status(s, &t, ItemStatus::Pending).await;
    clock.at(s, "2026-11-02T11:00:00Z").await;
    let ph = planned(s, "Phase").await;
    change(s, &t, PhaseChange::Set(ph.clone())).await;
    clock.at(s, "2026-11-02T12:00:00Z").await;
    assert!(item(s, &t).await.frozen);

    let r = week(s).await;
    assert_eq!(total(&r, |b| b.done), 1);
    assert_eq!(r.velocity.done, 1);
    assert_eq!(s.velocity(P, now()).await.unwrap().windows.week.done, 1);
    assert_eq!(r.buckets.last().unwrap().remaining, 0, "frozen now");
}

#[tokio::test]
async fn planning_is_not_active_time_but_a_release_is() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    let ph = planned(s, "Phase").await;
    let t = in_phase(s, &ph, "t").await;
    s.update_item(
        &t,
        ItemUpdate {
            title: Some("edited".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    clock.at(s, "2026-11-08T11:30:00Z").await;
    let v = s.velocity(P, now()).await.unwrap();
    assert_eq!(v.windows.week.active_seconds, 0, "stamped events are idle");
    assert_eq!(v.windows.day.active_seconds, 0);

    // The frame's own event counts; the tickets' moves beside it do not matter.
    s.release_phase(&ph, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    clock.at(s, "2026-11-08T11:45:00Z").await;
    let v = s.velocity(P, now()).await.unwrap();
    assert_eq!(v.windows.week.active_seconds, 15 * 60);
    assert_eq!(v.remaining, 1);
}

// ---- 17. Plans ------------------------------------------------------------------

#[tokio::test]
async fn every_statement_of_the_roadmap_read_uses_an_index() {
    let f = fixture().await;
    for sql in READS {
        let explain = format!("EXPLAIN QUERY PLAN {sql}");
        let mut q = sqlx::query_as::<_, (i64, i64, i64, String)>(&explain);
        for _ in 0..sql.matches('?').count() {
            q = q.bind("x");
        }
        let plan: Vec<String> = q
            .fetch_all(&f.store.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, _, _, detail)| detail)
            .collect();
        assert!(
            plan.iter().all(|d| !d.starts_with("SCAN")),
            "a full scan in {plan:?} for {sql}"
        );
        assert!(
            plan.iter()
                .any(|d| d.starts_with("SEARCH") && d.contains("INDEX")),
            "no index named in {plan:?} for {sql}"
        );
    }
}

#[test]
fn the_roadmaps_queue_read_lists_the_queued_statuses() {
    assert!(crate::tracker::roadmap::QUEUE_SQL.contains(crate::tracker::items::QUEUED_IN));
}

// ---- 18. The forward look -------------------------------------------------------

/// One ticket done in the hour before [`NOW`] and nothing else in the window, so
/// the velocity is 24 a day: one in the minimum hour of active time.
async fn one_done(s: &TrackerStore) {
    let t = create(s, P, "done").await;
    finish(s, &t).await;
}

#[tokio::test]
async fn a_released_phases_eta_is_everything_above_its_last_ticket() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    one_done(s).await;
    // The queue: counted, blocked (counted), deferred (not), a draft (not).
    let _x = create(s, P, "x").await;
    let y = create(s, P, "blocked").await;
    s.update_item(
        &y,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let z = create(s, P, "deferred").await;
    set_status(s, &z, ItemStatus::Deferred).await;
    s.create_item(
        NewItem {
            draft: true,
            ..new_item(P, "draft")
        },
        &mcp(),
    )
    .await
    .unwrap();
    s.create_item(
        NewItem {
            item_type: ItemType::Request,
            ..new_item(P, "idea")
        },
        &mcp(),
    )
    .await
    .unwrap();
    // Two released phases, and a counted ticket below them.
    let first = planned(s, "First").await;
    in_phase(s, &first, "a").await;
    in_phase(s, &first, "b").await;
    s.release_phase(&first, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    let second = planned(s, "Second").await;
    in_phase(s, &second, "c").await;
    s.release_phase(&second, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    create(s, P, "below").await;
    // An all-draft released phase has nothing to project.
    let drafts = planned(s, "Drafts").await;
    draft_in_phase(s, &drafts, "d").await;
    s.release_phase(&drafts, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    assert_sound(s, P).await;
    clock.at(s, "2026-11-08T11:00:00Z").await;

    let r = s.roadmap(P, ReportWindow::Week, now()).await.unwrap();
    assert_eq!(r.window, ReportWindow::Week);
    assert_eq!(r.now, NOW);
    assert_eq!(r.velocity_per_day, 24.0);
    // x, blocked, a, b, c, below.
    assert_eq!(r.queue.remaining, 6);
    assert_eq!(r.queue.eta_days, Some(6.0 / 24.0));
    assert_eq!(r.frozen, 0);
    let by_id = |id: &str| r.released.iter().find(|p| p.id == id).unwrap().clone();
    // First: x, blocked, a, b.
    assert_eq!(by_id(&first).ahead, 4);
    assert_eq!(by_id(&first).eta_days, Some(4.0 / 24.0));
    // Second: those and c.
    assert_eq!(by_id(&second).ahead, 5);
    assert_eq!(by_id(&second).eta_days, Some(5.0 / 24.0));
    assert_eq!(by_id(&drafts).ahead, 0);
    assert_eq!(by_id(&drafts).eta_days, None);
    assert_eq!(by_id(&first).size.open, 2);
    // By `ahead`.
    assert_eq!(
        r.released.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
        vec![drafts.clone(), first.clone(), second.clone()]
    );
    // With none planned, planned out is the queue's.
    assert!(r.planned.is_empty());
    assert_eq!(r.planned_out_days, r.queue.eta_days);
    // No body: the roadmap is one read of many phases.
    let json = serde_json::to_value(&r).unwrap();
    assert!(json["released"][0].get("body").is_none());
    assert!(json["released"][0].get("released_at").is_some());
}

#[tokio::test]
async fn a_planned_phases_eta_is_cumulative_and_follows_the_roadmap() {
    let f = fixture().await;
    let s = &f.store;
    let mut clock = Clock::new(s).await;
    one_done(s).await;
    create(s, P, "q").await;
    let a = planned(s, "A").await;
    in_phase(s, &a, "1").await;
    in_phase(s, &a, "2").await;
    // A frozen draft is not counted; it is in the project's frozen count.
    draft_in_phase(s, &a, "3").await;
    let b = planned(s, "B").await;
    in_phase(s, &b, "4").await;
    let empty = planned(s, "Empty").await;
    clock.at(s, "2026-11-08T11:00:00Z").await;

    let r = s.roadmap(P, ReportWindow::Week, now()).await.unwrap();
    assert_eq!(r.velocity_per_day, 24.0);
    assert_eq!(r.queue.remaining, 1);
    assert_eq!(r.frozen, 4);
    assert_eq!(
        r.planned
            .iter()
            .map(|p| (p.id.clone(), p.ahead, p.eta_days))
            .collect::<Vec<_>>(),
        vec![
            (a.clone(), 3, Some(3.0 / 24.0)),
            (b.clone(), 4, Some(4.0 / 24.0)),
            (empty.clone(), 4, Some(4.0 / 24.0)),
        ]
    );
    assert_eq!(r.planned_out_days, Some(4.0 / 24.0));
    assert_eq!(r.planned[0].size.frozen, 2);
    assert_eq!(r.planned[0].size.drafts, 1);

    // Reordering moves the ETAs with it.
    s.move_phase(&b, Place::Top, None, &mcp()).await.unwrap();
    clock.at(s, "2026-11-08T11:00:00Z").await;
    let r = s.roadmap(P, ReportWindow::Week, now()).await.unwrap();
    assert_eq!(r.planned[0].id, b);
    assert_eq!(r.planned[0].ahead, 2);
    assert_eq!(r.planned[1].ahead, 4);
    assert_sound(s, P).await;
}

#[tokio::test]
async fn a_velocity_of_zero_is_unknown_and_the_order_holds() {
    let f = fixture().await;
    let s = &f.store;
    create(s, P, "q").await;
    let late = planned(s, "Released late").await;
    let late_t = in_phase(s, &late, "t").await;
    s.release_phase(&late, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    let early = planned(s, "Released early").await;
    in_phase(s, &early, "u").await;
    s.release_phase(&early, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    mv(s, P, &late_t, Place::Bottom).await;
    let a = planned(s, "A").await;
    in_phase(s, &a, "v").await;

    let r = s.roadmap(P, ReportWindow::Day, now()).await.unwrap();
    assert_eq!(r.window, ReportWindow::Day);
    assert_eq!(r.velocity_per_day, 0.0);
    assert_eq!(r.queue.eta_days, None);
    assert_eq!(r.planned_out_days, None);
    assert_eq!(
        r.released
            .iter()
            .map(|p| (p.id.clone(), p.ahead, p.eta_days))
            .collect::<Vec<_>>(),
        vec![(early.clone(), 2, None), (late.clone(), 3, None)]
    );
    assert_eq!(r.planned[0].ahead, 4);
    assert_eq!(r.planned[0].eta_days, None);
    // Nothing remaining and nothing frozen is 0, not unknown.
    let empty = s
        .roadmap("nothing", ReportWindow::Week, now())
        .await
        .unwrap();
    assert_eq!(empty.queue.eta_days, Some(0.0));
}

#[tokio::test]
async fn complete_and_archived_are_lists_newest_first() {
    let f = fixture().await;
    let s = &f.store;
    let older = planned(s, "Older").await;
    let t = in_phase(s, &older, "t").await;
    s.release_phase(&older, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    set_status(s, &t, ItemStatus::Done).await;
    let newer = planned(s, "Newer").await;
    let u = in_phase(s, &newer, "u").await;
    s.release_phase(&newer, Place::Bottom, None, &mcp())
        .await
        .unwrap();
    set_status(s, &u, ItemStatus::Cancelled).await;
    let first_gone = archived(s, "Gone first").await;
    let then_gone = archived(s, "Gone then").await;
    for (id, at) in [
        (&older, "2026-11-01T00:00:00Z"),
        (&newer, "2026-11-02T00:00:00Z"),
        (&first_gone, "2026-11-03T00:00:00Z"),
        (&then_gone, "2026-11-04T00:00:00Z"),
    ] {
        sqlx::query("UPDATE phases SET released_at = CASE WHEN state = 'released' THEN ? END, updated_at = ? WHERE id = ?")
            .bind(at)
            .bind(at)
            .bind(id)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    let r = s.roadmap(P, ReportWindow::Week, now()).await.unwrap();
    assert!(r.released.is_empty());
    assert_eq!(
        r.complete.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
        vec![newer.clone(), older.clone()]
    );
    assert_eq!(
        r.archived.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
        vec![then_gone.clone(), first_gone.clone()]
    );
    for p in r.complete.iter().chain(r.archived.iter()) {
        assert_eq!((p.ahead, p.eta_days), (0, None), "{}", p.id);
    }
    assert!(r.complete[0].size.complete);
    // Reopening makes it released and incomplete again.
    set_status(s, &u, ItemStatus::Pending).await;
    let r = s.roadmap(P, ReportWindow::Week, now()).await.unwrap();
    assert_eq!(r.released.len(), 1);
    assert_eq!(r.released[0].id, newer);
    assert_eq!(r.complete.len(), 1);
    assert_sound(s, P).await;
}

#[tokio::test]
async fn an_unknown_project_answers_empty_and_a_bad_name_is_refused() {
    let f = fixture().await;
    let s = &f.store;
    let r = s
        .roadmap("nobody", ReportWindow::Week, now())
        .await
        .unwrap();
    assert_eq!(r.project, "nobody");
    assert_eq!((r.queue.remaining, r.frozen), (0, 0));
    assert_eq!(r.velocity_per_day, 0.0);
    assert_eq!(r.queue.eta_days, Some(0.0));
    assert_eq!(r.planned_out_days, Some(0.0));
    assert!(r.released.is_empty() && r.planned.is_empty());
    assert!(r.complete.is_empty() && r.archived.is_empty());
    assert!(s
        .roadmap("no/way", ReportWindow::Week, now())
        .await
        .is_err());
    // A project name is refused on a phase create too, as a ticket's is.
    assert!(s.create_phase(plan("no/way", "x"), &mcp()).await.is_err());
    assert!(s.create_phase(plan(P, "  "), &mcp()).await.is_err());
}

// ---- 19. Ids --------------------------------------------------------------------

#[tokio::test]
async fn phase_ids_are_per_project_and_never_reused() {
    let f = fixture().await;
    let s = &f.store;
    assert_eq!(planned(s, "One").await, "p-p0001");
    assert_eq!(planned(s, "Two").await, "p-p0002");
    let other = s.create_phase(plan("q", "Theirs"), &mcp()).await.unwrap();
    assert_eq!(other.phase.id, "q-p0001");
    // Archiving frees nothing; nor does a refused create.
    s.archive_phase("p-p0002", None, &mcp()).await.unwrap();
    assert!(s.create_phase(plan(P, " "), &mcp()).await.is_err());
    assert_eq!(planned(s, "Three").await, "p-p0003");
    assert_eq!(
        roadmap_order(s, P).await,
        vec!["p-p0001".to_string(), "p-p0003".to_string()]
    );
    // A named place on the roadmap.
    let rec = s
        .create_phase(
            NewPhase {
                place: Place::Before("p-p0003".into()),
                note: Some("Before it.".into()),
                ..plan(P, "Four")
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.events.last().unwrap().body, "Before it.");
    assert_eq!(
        roadmap_order(s, P).await,
        ids(&["p-p0001", "p-p0004", "p-p0003"])
    );
    assert_sound(s, P).await;
}

#[tokio::test]
async fn concurrent_creates_mint_distinct_ids_and_keep_the_roadmap_sound() {
    let f = fixture().await;
    let mut tasks = Vec::new();
    for n in 0..8 {
        let store = f.store.clone();
        tasks.push(tokio::spawn(async move {
            store
                .create_phase(plan(P, &format!("phase {n}")), &mcp())
                .await
                .unwrap()
                .phase
                .id
        }));
    }
    let mut made = Vec::new();
    for task in tasks {
        made.push(task.await.unwrap());
    }
    made.sort();
    made.dedup();
    assert_eq!(made.len(), 8);
    assert_eq!(roadmap_order(&f.store, P).await.len(), 8);
    assert_sound(&f.store, P).await;
}

// ---- Integrity ------------------------------------------------------------------

/// Corrupt a healthy roadmap with one statement, and check names the fault.
async fn finds(sql: &str, binds: &[&str], want: &str) {
    let f = fixture().await;
    let s = &f.store;
    let q = create(s, P, "q").await;
    let ph = planned(s, "Phase").await;
    let a = in_phase(s, &ph, "a").await;
    let b = in_phase(s, &ph, "b").await;
    let second = planned(s, "Second").await;
    let rel = released(s, "Released").await;
    assert_sound(s, P).await;
    let names = [
        ("{q}", q.as_str()),
        ("{ph}", ph.as_str()),
        ("{a}", a.as_str()),
        ("{b}", b.as_str()),
        ("{second}", second.as_str()),
        ("{rel}", rel.as_str()),
    ];
    let named = |v: &str| {
        names
            .iter()
            .find(|(k, _)| *k == v)
            .map_or(v.to_string(), |(_, id)| id.to_string())
    };
    let mut query = sqlx::query(sql);
    for b in binds {
        query = query.bind(named(b));
    }
    query.execute(&s.pool).await.unwrap();
    let report = s.check(P).await.unwrap();
    assert!(!report.ok, "{sql} went unnoticed");
    assert!(
        report.problems.iter().any(|p| p.contains(want)),
        "{want:?} not in {:?} after {sql}",
        report.problems
    );
}

#[tokio::test]
async fn the_integrity_check_names_each_fault() {
    // A frozen ticket not pending, with no phase, or in a phase not planned.
    finds(
        "UPDATE items SET status = 'in_progress' WHERE id = ?",
        &["{a}"],
        "is frozen but in_progress",
    )
    .await;
    finds(
        "UPDATE items SET phase_id = NULL WHERE id = ?",
        &["{a}"],
        "is frozen with no phase",
    )
    .await;
    finds(
        "UPDATE items SET phase_id = ? WHERE id = ?",
        &["{rel}", "{a}"],
        "which is released",
    )
    .await;
    // A phase that does not exist, or a request with one.
    finds(
        "UPDATE items SET phase_id = 'p-p9999' WHERE id = ?",
        &["{q}"],
        "which does not exist",
    )
    .await;
    finds(
        "UPDATE items SET type = 'request', phase_id = ? WHERE id = ?",
        &["{rel}", "{q}"],
        "is a request with phase",
    )
    .await;
    // A phase's list: a stale head or tail, a frozen ticket not on it.
    finds(
        "UPDATE phases SET head_id = ? WHERE id = ?",
        &["{b}", "{ph}"],
        "not reached by the walk",
    )
    .await;
    finds(
        "UPDATE phases SET tail_id = ? WHERE id = ?",
        &["{a}", "{ph}"],
        "the walk ends at",
    )
    .await;
    finds(
        "UPDATE phases SET head_id = ? WHERE id = ?",
        &["{q}", "{ph}"],
        "which is not frozen in it",
    )
    .await;
    // A cycle in a phase's list.
    finds(
        "UPDATE items SET next_id = ? WHERE id = ?",
        &["{a}", "{b}"],
        "cycle",
    )
    .await;
    // A released phase holding an end or a roadmap link.
    finds(
        "UPDATE phases SET head_id = ? WHERE id = ?",
        &["{a}", "{rel}"],
        "is released but has head",
    )
    .await;
    finds(
        "UPDATE phases SET next_id = ? WHERE id = ?",
        &["{ph}", "{rel}"],
        "is linked on the roadmap",
    )
    .await;
    // The roadmap: a phase missed, a stale end, a walk that disagrees backward.
    finds(
        "UPDATE projects SET roadmap_head_id = ? WHERE name = 'p'",
        &["{second}"],
        "planned but not reached",
    )
    .await;
    finds(
        "UPDATE projects SET roadmap_tail_id = ? WHERE name = 'p'",
        &["{ph}"],
        "its tail is",
    )
    .await;
    finds(
        "UPDATE phases SET prev_id = NULL WHERE id = ?",
        &["{second}"],
        "backward",
    )
    .await;
    finds(
        "UPDATE projects SET roadmap_head_id = ? WHERE name = 'p'",
        &["{rel}"],
        "which is released",
    )
    .await;
}

#[tokio::test]
async fn the_integrity_check_finds_a_phase_of_another_project() {
    let f = fixture().await;
    let s = &f.store;
    let t = create(s, P, "t").await;
    let theirs = s
        .create_phase(plan("other", "Theirs"), &mcp())
        .await
        .unwrap()
        .phase
        .id;
    sqlx::query("UPDATE items SET phase_id = ? WHERE id = ?")
        .bind(&theirs)
        .bind(&t)
        .execute(&s.pool)
        .await
        .unwrap();
    let report = s.check(P).await.unwrap();
    assert!(
        report
            .problems
            .iter()
            .any(|p| p.contains("of project other")),
        "{:?}",
        report.problems
    );
}
