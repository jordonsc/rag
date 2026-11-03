//! Item spans (spec:velocity m01, VL-01 to VL-03): the schema, the hook in
//! `append_event`, and the one-time backfill.

use std::path::Path;

use sqlx::SqlitePool;

use super::*;
use crate::tracker::spans::{self, Backfill};

/// One span, as a test reads it.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
struct SpanRow {
    track: String,
    state: String,
    started_at: String,
    ended_at: Option<String>,
    started_event: i64,
    ended_event: Option<i64>,
}

const SPAN_COLS: &str = "track, state, started_at, ended_at, started_event, ended_event";

async fn spans_of(pool: &SqlitePool, id: &str) -> Vec<SpanRow> {
    sqlx::query_as(&format!(
        "SELECT {SPAN_COLS} FROM item_spans WHERE item_id = ? ORDER BY span_id"
    ))
    .bind(id)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Every span in the database, in order, with its ticket.
async fn all_spans(pool: &SqlitePool) -> Vec<(String, SpanRow)> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT item_id FROM item_spans ORDER BY span_id")
        .fetch_all(pool)
        .await
        .unwrap();
    let rows: Vec<SpanRow> = sqlx::query_as(&format!(
        "SELECT {SPAN_COLS} FROM item_spans ORDER BY span_id"
    ))
    .fetch_all(pool)
    .await
    .unwrap();
    ids.into_iter().zip(rows).collect()
}

fn open(track: &str, state: &str, at: &str, event: i64) -> SpanRow {
    SpanRow {
        track: track.into(),
        state: state.into(),
        started_at: at.into(),
        ended_at: None,
        started_event: event,
        ended_event: None,
    }
}

fn closed(track: &str, state: &str, from: (&str, i64), to: (&str, i64)) -> SpanRow {
    SpanRow {
        ended_at: Some(to.0.into()),
        ended_event: Some(to.1),
        ..open(track, state, from.0, from.1)
    }
}

// ---- The schema (VL-01) -----------------------------------------------------

/// The comment the span schema starts at in `SCHEMA_SQL`: everything before it
/// is the schema as it was before spec:velocity.
const SPANS_DDL: &str = "-- spec:velocity (D21, D24)";

fn pre_span_schema() -> &'static str {
    let at = SCHEMA_SQL
        .find(SPANS_DDL)
        .expect("the span schema moved: update this test");
    let old = &SCHEMA_SQL[..at];
    assert!(!old.contains("item_spans") && !old.contains("idx_events_project_ts"));
    old
}

const SPAN_SCHEMA_NAMES: &[&str] = &[
    "item_spans",
    "idx_item_spans_project_started",
    "idx_item_spans_project_ended",
    "idx_item_spans_open",
    "idx_item_spans_item",
    "idx_events_project_ts",
];

async fn assert_span_schema(pool: &SqlitePool) {
    let names: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
            .fetch_all(pool)
            .await
            .unwrap();
    for n in SPAN_SCHEMA_NAMES {
        assert!(names.iter().any(|have| have == n), "no {n} in {names:?}");
    }
    let cols = |index: &'static str| async move {
        sqlx::query_scalar::<_, String>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
            .bind(index)
            .fetch_all(pool)
            .await
            .unwrap()
    };
    assert_eq!(cols("idx_events_project_ts").await, ["project", "ts"]);
    assert_eq!(
        cols("idx_item_spans_project_started").await,
        ["project", "started_at"]
    );
    assert_eq!(
        cols("idx_item_spans_project_ended").await,
        ["project", "ended_at"]
    );
    assert_eq!(cols("idx_item_spans_open").await, ["item_id", "track"]);
    let open_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'idx_item_spans_open'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(
        open_sql.contains("UNIQUE") && open_sql.contains("WHERE ended_at IS NULL"),
        "{open_sql}"
    );
}

#[tokio::test]
async fn a_new_database_has_the_span_table_and_both_tables_indexes() {
    let f = fixture().await;
    assert_span_schema(&f.store.pool).await;
}

async fn raw_pool(path: &Path) -> SqlitePool {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    sqlx::SqlitePool::connect_with(opts).await.unwrap()
}

#[tokio::test]
async fn an_older_database_gains_the_span_table_and_indexes_and_keeps_its_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    {
        let pool = raw_pool(&path).await;
        sqlx::query(pre_span_schema()).execute(&pool).await.unwrap();
        for sql in [
            "INSERT INTO projects (name, head_id, tail_id, item_seq, created_at) \
             VALUES ('old', 'old-t0001', 'old-t0001', 1, '2026-10-27T00:00:00Z')",
            "INSERT INTO items (id, project, seq, type, title, status, approval, created_at, \
             updated_at) VALUES ('old-t0001', 'old', 1, 'dev', 'from before', 'pending', \
             'unapproved', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')",
            "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, \
             surface, kind, body, fields) VALUES ('old', 'item', 'old-t0001', \
             '2026-10-27T00:00:00Z', 'dev@example.com', 'Claude Test', 'mcp', 'create', \
             'Created dev ticket.', '{\"status\":\"pending\"}')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(!names
            .iter()
            .any(|n| SPAN_SCHEMA_NAMES.contains(&n.as_str())));
        pool.close().await;
    }
    let store = TrackerStore::open(&path, dir.path().join("att"))
        .await
        .unwrap();
    assert_span_schema(&store.pool).await;
    let old = item(&store, "old-t0001").await;
    assert_eq!(old.item.title, "from before");
    assert_eq!(old.events.len(), 1);
    assert_eq!(sound(&store, "old").await, ids(&["old-t0001"]));
    // The backfill gave the ticket its span, from its create.
    assert_eq!(
        spans_of(&store.pool, "old-t0001").await,
        [open(
            "status",
            "pending",
            "2026-10-27T00:00:00Z",
            old.events[0].event_id
        )]
    );
    assert_spans_match_rows(&store).await;
}

// ---- The hook (VL-02) -------------------------------------------------------

#[tokio::test]
async fn a_create_opens_one_pending_status_span_and_a_draft_create_a_draft_span_too() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let ev = item(s, &a).await.events;
    assert_eq!(
        spans_of(&s.pool, &a).await,
        [open("status", "pending", &ev[0].ts, ev[0].event_id)]
    );
    let d = s
        .create_item(
            NewItem {
                draft: true,
                ..new_item("p", "a draft")
            },
            &web(),
        )
        .await
        .unwrap();
    let e = &d.events[0];
    assert_eq!(
        spans_of(&s.pool, &d.item.id).await,
        [
            open("status", "pending", &e.ts, e.event_id),
            open("draft", "draft", &e.ts, e.event_id)
        ]
    );
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn each_status_change_closes_the_open_span_and_opens_the_next_at_its_event() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    for to in [ItemStatus::InProgress, ItemStatus::Review, ItemStatus::Done] {
        set_status(s, &a, to).await;
    }
    let ev = item(s, &a).await.events;
    assert_eq!(ev.len(), 4);
    let at = |i: usize| (ev[i].ts.as_str(), ev[i].event_id);
    assert_eq!(
        spans_of(&s.pool, &a).await,
        [
            closed("status", "pending", at(0), at(1)),
            closed("status", "in_progress", at(1), at(2)),
            closed("status", "review", at(2), at(3)),
            open("status", "done", at(3).0, at(3).1),
        ]
    );
    // A reopen closes done and opens pending.
    set_status(s, &a, ItemStatus::Pending).await;
    let ev = item(s, &a).await.events;
    let sp = spans_of(&s.pool, &a).await;
    assert_eq!(sp.len(), 5);
    assert_eq!(
        sp[3],
        closed("status", "done", at(3), (&ev[4].ts, ev[4].event_id))
    );
    assert_eq!(sp[4], open("status", "pending", &ev[4].ts, ev[4].event_id));
    // Cancel opens cancelled.
    set_status(s, &a, ItemStatus::Cancelled).await;
    let ev = item(s, &a).await.events;
    let last = spans_of(&s.pool, &a).await.pop().unwrap();
    assert_eq!(last, open("status", "cancelled", &ev[5].ts, ev[5].event_id));
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn block_and_unblock_open_and_close_a_blocked_span_including_a_dependencys_unblock() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let blocked = |id: &str| {
        let pool = s.pool.clone();
        let id = id.to_string();
        async move {
            spans_of(&pool, &id)
                .await
                .into_iter()
                .filter(|sp| sp.track == "blocked")
                .collect::<Vec<_>>()
        }
    };
    // By hand: block, then unblock.
    s.update_item(
        &a,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    // A change of reason is not a change of track: the span stays open.
    s.update_item(
        &a,
        ItemUpdate {
            block_reason: Some(BlockReason::Review),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    s.update_item(
        &a,
        ItemUpdate {
            blocked: Some(false),
            ..Default::default()
        },
        &web(),
    )
    .await
    .unwrap();
    let ev = item(s, &a).await.events;
    assert_eq!(
        blocked(&a).await,
        [closed(
            "blocked",
            "blocked",
            (&ev[1].ts, ev[1].event_id),
            (&ev[3].ts, ev[3].event_id)
        )]
    );
    // By a dependency: b waits on a, and a's done unblocks it.
    s.update_item(&b, wait_on(&[&a]), &mcp()).await.unwrap();
    assert_eq!(blocked(&b).await.len(), 1);
    assert!(blocked(&b).await[0].ended_at.is_none());
    finish(s, &a).await;
    let ev = item(s, &b).await.events;
    let unblock = ev.last().unwrap();
    assert_eq!(unblock.fields["unblocked_by"], json!(a));
    assert_eq!(
        blocked(&b).await,
        [closed(
            "blocked",
            "blocked",
            (&ev[1].ts, ev[1].event_id),
            (&unblock.ts, unblock.event_id)
        )]
    );
    // Leaving the queue clears a block, and its span with it.
    s.update_item(
        &b,
        ItemUpdate {
            block_reason: Some(BlockReason::Review),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    set_status(s, &b, ItemStatus::Done).await;
    let ev = item(s, &b).await.events;
    let done = ev.last().unwrap();
    let spans = blocked(&b).await;
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[1].ended_event, Some(done.event_id));
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn publishing_closes_the_draft_span() {
    let f = fixture().await;
    let s = &f.store;
    let d = s
        .create_item(
            NewItem {
                draft: true,
                ..new_item("p", "a draft")
            },
            &web(),
        )
        .await
        .unwrap();
    let id = d.item.id;
    // An edit while a draft touches nothing.
    s.update_item(
        &id,
        ItemUpdate {
            title: Some("still a draft".into()),
            ..Default::default()
        },
        &web(),
    )
    .await
    .unwrap();
    s.update_item(
        &id,
        ItemUpdate {
            draft: Some(false),
            ..Default::default()
        },
        &web(),
    )
    .await
    .unwrap();
    let ev = item(s, &id).await.events;
    let at = |i: usize| (ev[i].ts.as_str(), ev[i].event_id);
    assert_eq!(
        spans_of(&s.pool, &id).await,
        [
            open("status", "pending", at(0).0, at(0).1),
            closed("draft", "draft", at(0), at(2)),
        ]
    );
    // Made a draft again: a new draft span.
    s.update_item(
        &id,
        ItemUpdate {
            draft: Some(true),
            ..Default::default()
        },
        &web(),
    )
    .await
    .unwrap();
    let ev = item(s, &id).await.events;
    assert_eq!(
        spans_of(&s.pool, &id).await.pop().unwrap(),
        open("draft", "draft", &ev[3].ts, ev[3].event_id)
    );
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn a_note_a_move_an_edit_a_link_and_the_rest_add_no_span() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    set_status(s, &a, ItemStatus::InProgress).await;
    let before = all_spans(&s.pool).await;
    let events_before = item(s, &a).await.events.len();
    s.update_item(
        &a,
        ItemUpdate {
            note: Some("a note".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    mv(s, "p", &b, Place::Top).await;
    s.update_item(
        &a,
        ItemUpdate {
            title: Some("renamed".into()),
            body: Some("a body".into()),
            labels: Some(labels(&["Physics"])),
            approval: Some(Approval::Agent),
            assignee: Some("dev-1".into()),
            parallel: Some(true),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    s.update_item(
        &a,
        ItemUpdate {
            add_links: vec![Link {
                kind: LinkKind::Ledger,
                target: "rag-l0081".into(),
            }],
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    // The same status again is no change.
    s.update_item(&a, status(ItemStatus::InProgress, "still"), &mcp())
        .await
        .unwrap();
    assert!(item(s, &a).await.events.len() >= events_before + 4);
    assert_eq!(all_spans(&s.pool).await, before, "the spans changed");
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn the_unique_index_refuses_a_second_open_span_of_a_track() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let insert = |track: &'static str, ended: Option<&'static str>| {
        let pool = s.pool.clone();
        let a = a.clone();
        async move {
            sqlx::query(
                "INSERT INTO item_spans (project, item_id, track, state, started_at, ended_at, \
                 started_event, ended_event) VALUES ('p', ?, ?, ?, '2026-01-01T00:00:00Z', ?, 1, \
                 ?)",
            )
            .bind(&a)
            .bind(track)
            .bind(if track == "status" { "pending" } else { track })
            .bind(ended)
            .bind(ended.map(|_| 1))
            .execute(&pool)
            .await
        }
    };
    let e = insert("status", None).await.unwrap_err();
    assert!(e.to_string().contains("UNIQUE"), "{e}");
    // A closed one beside it is fine, and so is the first open one of another track.
    insert("status", Some("2026-01-01T00:00:00Z"))
        .await
        .unwrap();
    insert("blocked", None).await.unwrap();
    let e = insert("blocked", None).await.unwrap_err();
    assert!(e.to_string().contains("UNIQUE"), "{e}");
}

// ---- The backfill (VL-03) ---------------------------------------------------

/// The timestamps the pre-span database's events carry.
const T: [&str; 9] = [
    "2026-10-01T10:00:00Z",
    "2026-10-01T10:05:00Z",
    "2026-10-01T10:10:00Z",
    "2026-10-01T10:30:00Z",
    "2026-10-01T11:00:00Z",
    "2026-10-01T11:30:00Z",
    "2026-10-01T12:00:00Z",
    "2026-10-01T13:00:00Z",
    "2026-10-01T13:30:00Z",
];

/// A database as the pre-span code wrote it, rows and events inserted directly
/// (as the rag-t0024 migration test builds its old one), in project `p`:
///
/// * `p-t0001`: created, then in progress, review and done;
/// * `p-t0002`: created a draft, published, then blocked (it is still pending);
/// * `p-t0003`: created; its row says in progress, set with no event, so the
///   replay disagrees with it;
///
/// and one document event the backfill must pass over. Returns the event ids in
/// the order of [`T`].
async fn pre_span_db(path: &Path) -> Vec<i64> {
    let pool = raw_pool(path).await;
    sqlx::query(pre_span_schema()).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO projects (name, head_id, tail_id, item_seq, created_at) \
         VALUES ('p', 'p-t0002', 'p-t0003', 3, '2026-10-01T10:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (seq, status, blocked, reason, prev, next) in [
        (1, "done", false, None, None, None),
        (2, "pending", true, Some("redesign"), None, Some("p-t0003")),
        (3, "in_progress", false, None, Some("p-t0002"), None),
    ] {
        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, status, blocked, block_reason, \
             approval, prev_id, next_id, created_at, updated_at, done_at) VALUES \
             (?, 'p', ?, 'dev', 'x', ?, ?, ?, 'unapproved', ?, ?, ?, ?, ?)",
        )
        .bind(format!("p-t{seq:04}"))
        .bind(seq)
        .bind(status)
        .bind(blocked)
        .bind(reason)
        .bind(prev)
        .bind(next)
        .bind(T[0])
        .bind(T[7])
        .bind((status == "done").then_some(T[7]))
        .execute(&pool)
        .await
        .unwrap();
    }
    let mut ids = Vec::new();
    for (i, (target_kind, kind, target_id, fields, before)) in [
        (
            "item",
            "create",
            "p-t0001",
            json!({"status": "pending"}),
            None,
        ),
        (
            "item",
            "create",
            "p-t0002",
            json!({"status": "pending", "draft": true}),
            None,
        ),
        (
            "item",
            "create",
            "p-t0003",
            json!({"status": "pending"}),
            None,
        ),
        (
            "item",
            "edit",
            "p-t0002",
            json!({"draft": false, "type": "dev"}),
            Some(json!({"draft": true})),
        ),
        (
            "item",
            "status",
            "p-t0001",
            json!({"status": "in_progress"}),
            Some(json!({"status": "pending"})),
        ),
        (
            "item",
            "block",
            "p-t0002",
            json!({"blocked": true, "block_reason": "redesign"}),
            Some(json!({"blocked": false, "block_reason": null})),
        ),
        (
            "item",
            "status",
            "p-t0001",
            json!({"status": "review"}),
            Some(json!({"status": "in_progress"})),
        ),
        (
            "item",
            "status",
            "p-t0001",
            json!({"status": "done", "done_at": T[7]}),
            Some(json!({"status": "review", "done_at": null})),
        ),
        (
            "document",
            "create",
            "p-d0001",
            json!({"status": "done"}),
            None,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let event_id: i64 = sqlx::query_scalar(
            "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, \
             surface, kind, body, fields, fields_before) \
             VALUES ('p', ?, ?, ?, 'dev@example.com', 'Claude Test', 'mcp', ?, 'x', ?, ?) \
             RETURNING event_id",
        )
        .bind(target_kind)
        .bind(target_id)
        .bind(T[i])
        .bind(kind)
        .bind(fields.to_string())
        .bind(before.map(|b| b.to_string()))
        .fetch_one(&pool)
        .await
        .unwrap();
        ids.push(event_id);
    }
    pool.close().await;
    ids
}

#[tokio::test]
async fn the_backfill_replays_a_pre_span_database_into_spans_that_match_its_rows() {
    let dir = tempfile::tempdir().unwrap();
    let (direct, opened) = (dir.path().join("direct.db"), dir.path().join("opened.db"));
    let e = pre_span_db(&direct).await;
    assert_eq!(pre_span_db(&opened).await, e);
    let at = |i: usize| (T[i], e[i]);

    // The backfill alone, for what it says it did: three tickets, nine spans,
    // and p-t0003 corrected to its row.
    {
        let pool = raw_pool(&direct).await;
        sqlx::query(SCHEMA_SQL).execute(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let done = spans::backfill(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            done,
            Some(Backfill {
                tickets: 3,
                spans: 9,
                corrected: 1
            })
        );
        // Nothing more to do once there are spans.
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(spans::backfill(&mut tx).await.unwrap(), None);
        tx.commit().await.unwrap();
        pool.close().await;
    }

    // Opening the other copy runs the same backfill, once.
    let store = TrackerStore::open(&opened, dir.path().join("att"))
        .await
        .unwrap();
    let p = &store.pool;
    assert_eq!(
        spans_of(p, "p-t0001").await,
        [
            closed("status", "pending", at(0), at(4)),
            closed("status", "in_progress", at(4), at(6)),
            closed("status", "review", at(6), at(7)),
            open("status", "done", T[7], e[7]),
        ]
    );
    assert_eq!(
        spans_of(p, "p-t0002").await,
        [
            closed("draft", "draft", at(1), at(3)),
            open("status", "pending", T[1], e[1]),
            open("blocked", "blocked", T[5], e[5]),
        ]
    );
    // Corrected: its replayed pending is closed at its last event and the row's
    // status opened there.
    assert_eq!(
        spans_of(p, "p-t0003").await,
        [
            closed("status", "pending", at(2), at(2)),
            open("status", "in_progress", T[2], e[2]),
        ]
    );
    assert_spans_match_rows(&store).await;
    let built = all_spans(p).await;
    {
        let pool = raw_pool(&direct).await;
        assert_eq!(all_spans(&pool).await, built, "the two copies differ");
        pool.close().await;
    }
    store.pool.close().await;

    // A second open writes nothing.
    let store = TrackerStore::open(&opened, dir.path().join("att"))
        .await
        .unwrap();
    assert_eq!(all_spans(&store.pool).await, built);
    // And the hook carries on from the backfilled spans.
    set_status(&store, "p-t0003", ItemStatus::Review).await;
    let sp = spans_of(&store.pool, "p-t0003").await;
    assert_eq!(sp.len(), 3);
    assert_eq!(sp[1].ended_event, Some(sp[2].started_event));
    assert_spans_match_rows(&store).await;
}

#[tokio::test]
async fn a_ticket_with_no_events_gets_its_spans_from_its_row() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    {
        let pool = raw_pool(&path).await;
        sqlx::query(SCHEMA_SQL).execute(&pool).await.unwrap();
        for sql in [
            "INSERT INTO projects (name, head_id, tail_id, item_seq, created_at) \
             VALUES ('p', 'p-t0001', 'p-t0001', 1, '2026-10-01T10:00:00Z')",
            "INSERT INTO items (id, project, seq, type, title, status, blocked, block_reason, \
             draft, approval, created_at, updated_at) VALUES ('p-t0001', 'p', 1, 'dev', 'x', \
             'review', 1, 'redesign', 1, 'unapproved', '2026-10-01T10:00:00Z', \
             '2026-10-02T10:00:00Z')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(
            spans::backfill(&mut tx).await.unwrap(),
            Some(Backfill {
                tickets: 1,
                spans: 3,
                corrected: 1
            })
        );
        tx.commit().await.unwrap();
        pool.close().await;
    }
    let store = TrackerStore::open(&path, dir.path().join("att"))
        .await
        .unwrap();
    let at = "2026-10-02T10:00:00Z";
    assert_eq!(
        spans_of(&store.pool, "p-t0001").await,
        [
            open("status", "review", at, 0),
            open("blocked", "blocked", at, 0),
            open("draft", "draft", at, 0),
        ]
    );
    assert_spans_match_rows(&store).await;
}

#[tokio::test]
async fn a_database_with_no_tickets_is_left_without_spans() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    for pass in 0..2 {
        let store = TrackerStore::open(&path, dir.path().join("att"))
            .await
            .unwrap();
        doc(&store, &format!("notes/{pass}.md"), "a").await;
        assert!(all_spans(&store.pool).await.is_empty());
        let mut tx = store.pool.begin().await.unwrap();
        assert_eq!(spans::backfill(&mut tx).await.unwrap(), None);
        tx.commit().await.unwrap();
        store.pool.close().await;
    }
}
