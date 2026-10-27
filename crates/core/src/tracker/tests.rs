//! Tests for the tracker store, against a temporary database per test. After
//! every list operation the integrity check must pass (m01 § Tests).

use std::str::FromStr;

use serde_json::json;

use super::*;

struct Fixture {
    _dir: tempfile::TempDir,
    store: TrackerStore,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
        .await
        .unwrap();
    Fixture { _dir: dir, store }
}

fn mcp() -> Actor {
    Actor::new("dev@example.com", Some("Claude Test"), Surface::Mcp)
}

fn web() -> Actor {
    Actor::new("owner@example.com", None, Surface::Web)
}

fn new_item(project: &str, title: &str) -> NewItem {
    NewItem {
        project: project.into(),
        item_type: ItemType::Dev,
        title: title.into(),
        body: String::new(),
        assignee: None,
        approval: Approval::Unapproved,
        links: Vec::new(),
        intensity: None,
        release: false,
        parallel: false,
        labels: Vec::new(),
        place: Place::Bottom,
        note: None,
    }
}

fn new_gate(project: &str, intensity: Intensity) -> NewItem {
    NewItem {
        item_type: ItemType::Gate,
        intensity: Some(intensity),
        ..new_item(project, "Gate")
    }
}

/// Assert the list is sound and return its order.
async fn sound(s: &TrackerStore, project: &str) -> Vec<String> {
    let r = s.check(project).await.unwrap();
    assert!(r.ok, "integrity check failed: {:?}", r.problems);
    r.order
}

async fn create(s: &TrackerStore, project: &str, title: &str) -> String {
    let id = s
        .create_item(new_item(project, title), &mcp())
        .await
        .unwrap()
        .item
        .id;
    sound(s, project).await;
    id
}

fn status(s: ItemStatus, note: &str) -> ItemUpdate {
    ItemUpdate {
        status: Some(s),
        note: Some(note.into()),
        ..Default::default()
    }
}

async fn set_status(s: &TrackerStore, id: &str, to: ItemStatus) {
    s.update_item(id, status(to, "test"), &mcp()).await.unwrap();
}

async fn finish(s: &TrackerStore, id: &str) {
    set_status(s, id, ItemStatus::InProgress).await;
    set_status(s, id, ItemStatus::Done).await;
}

async fn mv(s: &TrackerStore, project: &str, id: &str, place: Place) {
    s.move_item(id, place, None, &mcp()).await.unwrap();
    sound(s, project).await;
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ---- The list ---------------------------------------------------------------

#[tokio::test]
async fn ids_are_minted_per_project_and_join_the_tail() {
    let f = fixture().await;
    let a = create(&f.store, "ubu", "a").await;
    let b = create(&f.store, "ubu", "b").await;
    let c = create(&f.store, "rag", "c").await;
    assert_eq!(a, "ubu-t0001");
    assert_eq!(b, "ubu-t0002");
    assert_eq!(c, "rag-t0001");
    assert_eq!(
        sound(&f.store, "ubu").await,
        ids(&["ubu-t0001", "ubu-t0002"])
    );
}

#[tokio::test]
async fn the_list_moves_unlinks_and_relinks() {
    let f = fixture().await;
    let s = &f.store;
    let p = "ubu";
    let mut v = Vec::new();
    for n in 1..=5 {
        v.push(create(s, p, &format!("item {n}")).await);
    }
    let [i1, i2, i3, i4, i5] = [&v[0], &v[1], &v[2], &v[3], &v[4]].map(String::clone);
    assert_eq!(
        sound(s, p).await,
        vec![i1.clone(), i2.clone(), i3.clone(), i4.clone(), i5.clone()]
    );

    // The last before the first.
    mv(s, p, &i5, Place::Before(i1.clone())).await;
    assert_eq!(
        sound(s, p).await,
        vec![i5.clone(), i1.clone(), i2.clone(), i3.clone(), i4.clone()]
    );
    // The third to the bottom.
    mv(s, p, &i3, Place::Bottom).await;
    assert_eq!(
        sound(s, p).await,
        vec![i5.clone(), i1.clone(), i2.clone(), i4.clone(), i3.clone()]
    );
    // The second after the fourth.
    mv(s, p, &i2, Place::After(i4.clone())).await;
    assert_eq!(
        sound(s, p).await,
        vec![i5.clone(), i1.clone(), i4.clone(), i2.clone(), i3.clone()]
    );
    // To the top.
    mv(s, p, &i3, Place::Top).await;
    assert_eq!(
        sound(s, p).await,
        vec![i3.clone(), i5.clone(), i1.clone(), i4.clone(), i2.clone()]
    );

    // Done unlinks.
    finish(s, &i1).await;
    assert_eq!(
        sound(s, p).await,
        vec![i3.clone(), i5.clone(), i4.clone(), i2.clone()]
    );
    let rec = s.get_item(&i1, false).await.unwrap().unwrap().item;
    assert!(rec.done_at.is_some() && !rec.queued && rec.prev_id.is_none() && rec.next_id.is_none());

    // Reopen puts it at the top.
    set_status(s, &i1, ItemStatus::Pending).await;
    assert_eq!(
        sound(s, p).await,
        vec![i1.clone(), i3.clone(), i5.clone(), i4.clone(), i2.clone()]
    );
    assert!(s
        .get_item(&i1, false)
        .await
        .unwrap()
        .unwrap()
        .item
        .done_at
        .is_none());

    // Cancel unlinks.
    set_status(s, &i4, ItemStatus::Cancelled).await;
    assert_eq!(
        sound(s, p).await,
        vec![i1.clone(), i3.clone(), i5.clone(), i2.clone()]
    );

    // A blocked item stays in the walk; unblocked, it is where it was.
    s.update_item(
        &i5,
        ItemUpdate {
            blocked: Some(true),
            block_reason: Some(BlockReason::Review),
            note: Some("waiting on the owner's review".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert_eq!(
        sound(s, p).await,
        vec![i1.clone(), i3.clone(), i5.clone(), i2.clone()]
    );
    let view = s.queue_view(p).await.unwrap();
    assert_eq!(
        view.queue.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![i1.clone(), i3.clone(), i2.clone()]
    );
    assert_eq!(view.blocked[0].id, i5);
    assert_eq!(view.blocked[0].block_reason, Some(BlockReason::Review));
    assert_eq!(
        view.blocked[0].block_note.as_deref(),
        Some("waiting on the owner's review")
    );
    // Moving another item around it does not disturb it.
    mv(s, p, &i2, Place::Top).await;
    s.update_item(
        &i5,
        ItemUpdate {
            blocked: Some(false),
            note: Some("reviewed".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    assert_eq!(
        sound(s, p).await,
        vec![i2.clone(), i1.clone(), i3.clone(), i5.clone()]
    );
    let item = s.get_item(&i5, false).await.unwrap().unwrap().item;
    assert!(!item.blocked && item.block_reason.is_none() && item.block_note.is_none());
}

#[tokio::test]
async fn create_takes_a_named_place() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let top = s
        .create_item(
            NewItem {
                place: Place::Top,
                ..new_item("p", "top")
            },
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    let mid = s
        .create_item(
            NewItem {
                place: Place::After(a.clone()),
                ..new_item("p", "mid")
            },
            &mcp(),
        )
        .await
        .unwrap()
        .item
        .id;
    assert_eq!(sound(s, "p").await, vec![top, a, mid, b]);
}

#[tokio::test]
async fn a_failed_item_stays_queued_and_a_reopen_keeps_its_place() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    set_status(s, &b, ItemStatus::InProgress).await;
    set_status(s, &b, ItemStatus::Failed).await;
    assert_eq!(sound(s, "p").await, vec![a.clone(), b.clone()]);
    set_status(s, &b, ItemStatus::Pending).await;
    assert_eq!(sound(s, "p").await, vec![a, b]);
}

#[tokio::test]
async fn done_clears_a_block() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    set_status(s, &a, ItemStatus::InProgress).await;
    s.update_item(
        &a,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            note: Some("needs sign-off".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    set_status(s, &a, ItemStatus::Done).await;
    let item = s.get_item(&a, true).await.unwrap().unwrap();
    assert!(!item.item.blocked);
    assert_eq!(
        item.events.last().unwrap().fields["blocked"],
        serde_json::json!(false)
    );
    sound(s, "p").await;
}

// ---- Refusals ---------------------------------------------------------------

#[tokio::test]
async fn moves_are_refused_relative_to_self_other_projects_and_unqueued_items() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let other = create(s, "q", "other").await;
    let done = create(s, "p", "done").await;
    finish(s, &done).await;
    let before = sound(s, "p").await;

    for place in [Place::Before(a.clone()), Place::After(a.clone())] {
        let e = s.move_item(&a, place, None, &mcp()).await.unwrap_err();
        assert!(matches!(e, TrackerError::Refused(_)), "{e}");
    }
    let e = s
        .move_item(&a, Place::Before(other.clone()), None, &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("project q"), "{e}");
    let e = s
        .move_item(&a, Place::After(done.clone()), None, &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("not in the queue"), "{e}");
    let e = s
        .move_item(&done, Place::Top, None, &mcp())
        .await
        .unwrap_err();
    assert!(matches!(e, TrackerError::Refused(_)), "{e}");
    let e = s
        .move_item(&a, Place::After("p-t9999".into()), None, &mcp())
        .await
        .unwrap_err();
    assert!(matches!(e, TrackerError::Refused(_)), "{e}");

    // A refused move changed nothing and wrote no event.
    assert_eq!(sound(s, "p").await, before);
    assert_eq!(s.get_item(&a, true).await.unwrap().unwrap().events.len(), 1);
    let _ = b;
}

#[tokio::test]
async fn unknown_enum_values_are_refused_at_the_boundary() {
    assert!(ItemType::from_str("epic").is_err());
    assert!(ItemStatus::from_str("blocked").is_err());
    assert!(Approval::from_str("approved").is_err());
    assert!(Intensity::from_str("huge").is_err());
    assert!(Surface::from_str("cli").is_err());
    assert!(BlockReason::from_str("bored").is_err());
    assert!(SpecState::from_str("active").is_err());
    let e = ItemStatus::from_str("blocked").unwrap_err().to_string();
    assert!(
        e.contains("pending|in_progress|done|failed|cancelled"),
        "{e}"
    );
    // Every value round-trips.
    for t in ItemType::ALL {
        assert_eq!(ItemType::from_str(t.as_str()).unwrap(), *t);
    }
    for k in EventKind::ALL {
        assert_eq!(EventKind::from_str(k.as_str()).unwrap(), *k);
    }
}

/// D7 as amended by the owner, 2026-10-27: a note is optional on every change,
/// and the event's body is then generated from the change.
#[tokio::test]
async fn a_change_without_a_note_gets_a_generated_body() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let cases = [
        (
            ItemUpdate {
                status: Some(ItemStatus::InProgress),
                note: Some("  ".into()),
                ..Default::default()
            },
            EventKind::Status,
            "Status: pending → in_progress.",
        ),
        (
            ItemUpdate {
                blocked: Some(true),
                block_reason: Some(BlockReason::Redesign),
                ..Default::default()
            },
            EventKind::Block,
            "Blocked (redesign).",
        ),
        (
            ItemUpdate {
                blocked: Some(false),
                ..Default::default()
            },
            EventKind::Unblock,
            "Unblocked.",
        ),
        (
            ItemUpdate {
                approval: Some(Approval::Agent),
                assignee: Some("dev-1".into()),
                ..Default::default()
            },
            EventKind::Approve,
            "Approval: unapproved → agent. Set assignee.",
        ),
        (
            ItemUpdate {
                approval: Some(Approval::Ratified),
                ..Default::default()
            },
            EventKind::Approve,
            "Approval: agent → ratified.",
        ),
        (
            ItemUpdate {
                block_reason: Some(BlockReason::Review),
                ..Default::default()
            },
            EventKind::Block,
            "Blocked (review).",
        ),
        (
            status(ItemStatus::Done, ""),
            EventKind::Status,
            "Status: in_progress → done. Unblocked.",
        ),
        (
            status(ItemStatus::Pending, ""),
            EventKind::Status,
            "Status: done → pending.",
        ),
        (
            status(ItemStatus::Cancelled, ""),
            EventKind::Status,
            "Status: pending → cancelled.",
        ),
    ];
    for (upd, kind, body) in cases {
        let rec = s.update_item(&a, upd, &mcp()).await.unwrap();
        let last = rec.events.last().unwrap();
        assert_eq!(last.kind, kind, "{body}");
        assert_eq!(last.body, body);
    }
    let rec = s.get_item(&a, true).await.unwrap().unwrap();
    assert_eq!(rec.item.status, ItemStatus::Cancelled);
    assert_eq!(rec.item.approval, Approval::Ratified);
    assert!(!rec.item.blocked);
    assert_eq!(rec.events.len(), 10, "one event per write");

    // A block without a note keeps no block note; one with a note keeps it.
    let b = create(s, "p", "b").await;
    let r = s
        .update_item(
            &b,
            ItemUpdate {
                block_reason: Some(BlockReason::Redesign),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert!(r.item.blocked);
    assert_eq!(r.item.block_note, None);
    let r = s
        .update_item(
            &b,
            ItemUpdate {
                block_reason: Some(BlockReason::Review),
                note: Some("needs a look".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(r.item.block_note.as_deref(), Some("needs a look"));
    assert_eq!(r.events.last().unwrap().body, "needs a look");
}

/// The one write that still needs a note: a bare note (Add note), which records
/// nothing but the note.
#[tokio::test]
async fn a_bare_note_must_not_be_blank() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    for note in [None, Some(""), Some("   ")] {
        let e = s
            .update_item(
                &a,
                ItemUpdate {
                    note: note.map(str::to_string),
                    ..Default::default()
                },
                &mcp(),
            )
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no note given"), "{e}");
    }
    let rec = s
        .update_item(
            &a,
            ItemUpdate {
                note: Some("  checked the logs  ".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    let last = rec.events.last().unwrap();
    assert_eq!(last.kind, EventKind::Note);
    assert_eq!(last.body, "checked the logs");
    assert_eq!(rec.events.len(), 2, "a refused note writes no event");
}

#[tokio::test]
async fn gate_fields_only_on_gates() {
    let f = fixture().await;
    let s = &f.store;
    let e = s
        .create_item(
            NewItem {
                intensity: Some(Intensity::Quick),
                ..new_item("p", "x")
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("gate fields"), "{e}");
    let e = s
        .create_item(
            NewItem {
                release: true,
                ..new_item("p", "x")
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("gate fields"), "{e}");
    let e = s
        .create_item(
            NewItem {
                intensity: None,
                ..new_gate("p", Intensity::Full)
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("intensity"), "{e}");

    let a = create(s, "p", "a").await;
    let e = s
        .update_item(
            &a,
            ItemUpdate {
                release: Some(true),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("gate fields"), "{e}");

    let g = s
        .create_item(
            NewItem {
                release: true,
                ..new_gate("p", Intensity::Standard)
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(g.item.intensity, Some(Intensity::Standard));
    assert!(g.item.release);
    let g = s
        .update_item(
            &g.item.id,
            ItemUpdate {
                intensity: Some(Intensity::Full),
                release: Some(false),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(g.item.intensity, Some(Intensity::Full));
    assert!(!g.item.release);
    sound(s, "p").await;
}

#[tokio::test]
async fn disallowed_transitions_are_refused() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    // failed -> done: a failed item is reopened (or cancelled), never finished.
    set_status(s, &b, ItemStatus::Failed).await;
    let e = s
        .update_item(&b, status(ItemStatus::Done, "x"), &mcp())
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("cannot go from failed to done"),
        "{e}"
    );
    finish(s, &a).await;
    // done -> in_progress.
    let e = s
        .update_item(&a, status(ItemStatus::InProgress, "x"), &mcp())
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("cannot go from done to in_progress"),
        "{e}"
    );
    // done -> cancelled (done is not queued).
    assert!(s
        .update_item(&a, status(ItemStatus::Cancelled, "x"), &mcp())
        .await
        .is_err());
    // The table, exhaustively.
    use ItemStatus::*;
    let allowed = [
        (Pending, InProgress),
        (InProgress, Pending),
        (InProgress, Done),
        (InProgress, Failed),
        (Pending, Done),
        (Pending, Failed),
        (Pending, Cancelled),
        (InProgress, Cancelled),
        (Failed, Cancelled),
        (Done, Pending),
        (Failed, Pending),
        (Cancelled, Pending),
        // rag-t0017: deferred.
        (Pending, Deferred),
        (InProgress, Deferred),
        (Failed, Deferred),
        (Deferred, Pending),
        (Deferred, InProgress),
        (Deferred, Cancelled),
        (Deferred, Done),
        // rag-t0024: review.
        (Pending, Review),
        (InProgress, Review),
        (Failed, Review),
        (Review, Done),
        (Review, InProgress),
        (Review, Pending),
        (Review, Cancelled),
    ];
    for from in ItemStatus::ALL {
        for to in ItemStatus::ALL {
            assert_eq!(
                transition_allowed(*from, *to),
                allowed.contains(&(*from, *to)),
                "{from} -> {to}"
            );
        }
    }
    sound(s, "p").await;
}

#[tokio::test]
async fn pending_goes_straight_to_done_or_failed() {
    // TM-06 (the manager's change to TR-03): quick work is recorded done without
    // first being marked in progress, and a pending item can be marked failed.
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    // A block is cleared by going done, as from in_progress.
    s.update_item(
        &a,
        ItemUpdate {
            block_reason: Some(BlockReason::Review),
            note: Some("look first".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let done = s
        .update_item(
            &a,
            status(ItemStatus::Done, "quick fix, done in passing"),
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(done.item.status, ItemStatus::Done);
    assert!(done.item.done_at.is_some());
    assert!(!done.item.queued && !done.item.blocked);
    let last = done.events.last().unwrap();
    assert_eq!(last.kind, EventKind::Status);
    assert_eq!(last.fields["status"], "done");
    assert_eq!(sound(s, "p").await, vec![b.clone(), c.clone()]);
    // pending -> failed keeps its place.
    let failed = s
        .update_item(&b, status(ItemStatus::Failed, "could not start"), &mcp())
        .await
        .unwrap();
    assert_eq!(failed.item.status, ItemStatus::Failed);
    assert!(failed.item.queued && failed.item.done_at.is_none());
    assert_eq!(sound(s, "p").await, vec![b.clone(), c.clone()]);
    // A note is optional (D7, amended 2026-10-27).
    let done = s
        .update_item(&c, status(ItemStatus::Done, " "), &mcp())
        .await
        .unwrap();
    assert_eq!(done.events.last().unwrap().body, "Status: pending → done.");
}

#[tokio::test]
async fn deferred_keeps_its_place_and_resumes_in_place() {
    // rag-t0017: deferred is queued, so it stays in the list; resuming it
    // (deferred -> pending) puts it back where it was, not at the top.
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    let rec = s
        .update_item(&b, status(ItemStatus::Deferred, ""), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.status, ItemStatus::Deferred);
    assert!(rec.item.queued);
    assert_eq!(
        rec.events.last().unwrap().body,
        "Status: pending → deferred."
    );
    assert_eq!(rec.events.last().unwrap().kind, EventKind::Status);
    assert_eq!(sound(s, "p").await, ids(&[&a, &b, &c]));
    // The queue view puts it under deferred, out of the queue and blocked.
    let view = s.queue_view("p").await.unwrap();
    let v = |items: &[Item]| items.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
    assert_eq!(v(&view.queue), ids(&[&a, &c]));
    assert!(view.blocked.is_empty());
    assert_eq!(v(&view.deferred), ids(&[&b]));
    // It can still be an anchor, and moved.
    mv(s, "p", &c, Place::Before(b.clone())).await;
    assert_eq!(sound(s, "p").await, ids(&[&a, &c, &b]));
    mv(s, "p", &b, Place::Top).await;
    assert_eq!(sound(s, "p").await, ids(&[&b, &a, &c]));
    // Resume: back to pending in the same place, done_at untouched.
    let rec = s
        .update_item(&b, status(ItemStatus::Pending, ""), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.status, ItemStatus::Pending);
    assert!(rec.item.done_at.is_none() && rec.item.acknowledged_at.is_none());
    assert_eq!(sound(s, "p").await, ids(&[&b, &a, &c]));
    // in_progress and failed defer too; deferred goes on to in_progress or done.
    set_status(s, &a, ItemStatus::InProgress).await;
    set_status(s, &a, ItemStatus::Deferred).await;
    set_status(s, &a, ItemStatus::InProgress).await;
    set_status(s, &c, ItemStatus::Failed).await;
    set_status(s, &c, ItemStatus::Deferred).await;
    set_status(s, &c, ItemStatus::Done).await;
    assert_eq!(sound(s, "p").await, ids(&[&b, &a]));
    // Negative: deferred -> failed is refused, and done -> deferred (not queued).
    set_status(s, &b, ItemStatus::Deferred).await;
    let e = s
        .update_item(&b, status(ItemStatus::Failed, ""), &mcp())
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("cannot go from deferred to failed"),
        "{e}"
    );
    let e = s
        .update_item(&c, status(ItemStatus::Deferred, ""), &mcp())
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("cannot go from done to deferred"),
        "{e}"
    );
    // Cancelling a deferred item takes it out of the list.
    set_status(s, &b, ItemStatus::Cancelled).await;
    assert_eq!(sound(s, "p").await, ids(&[&a]));
}

#[tokio::test]
async fn a_deferred_item_may_also_be_blocked_and_is_shown_as_deferred() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    // b blocked then deferred; c deferred then blocked; a blocked only.
    for (id, reason) in [(&b, BlockReason::Review), (&a, BlockReason::Redesign)] {
        s.update_item(
            id,
            ItemUpdate {
                block_reason: Some(reason),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    }
    set_status(s, &b, ItemStatus::Deferred).await;
    set_status(s, &c, ItemStatus::Deferred).await;
    let rec = s
        .update_item(
            &c,
            ItemUpdate {
                block_reason: Some(BlockReason::Redesign),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert!(rec.item.blocked && rec.item.status == ItemStatus::Deferred);
    let view = s.queue_view("p").await.unwrap();
    let v = |items: &[Item]| items.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
    assert!(view.queue.is_empty());
    assert_eq!(v(&view.blocked), ids(&[&a]));
    assert_eq!(v(&view.deferred), ids(&[&b, &c]));
    // Resuming keeps the block: it then shows under blocked, in list order.
    set_status(s, &b, ItemStatus::Pending).await;
    let view = s.queue_view("p").await.unwrap();
    assert_eq!(v(&view.blocked), ids(&[&a, &b]));
    assert_eq!(v(&view.deferred), ids(&[&c]));
    let p = &s.list_projects().await.unwrap()[0];
    assert_eq!((p.queued, p.blocked, p.deferred), (3, 2, 1));
    assert_eq!(
        s.list_items("p", Some(ItemStatus::Deferred), None)
            .await
            .unwrap()
            .iter()
            .map(|i| i.id.clone())
            .collect::<Vec<_>>(),
        ids(&[&c])
    );
    sound(s, "p").await;
}

#[tokio::test]
async fn review_keeps_its_place_and_is_confirmed_or_sent_back() {
    // rag-t0024: review is queued, so it stays in the list; confirming it
    // finishes it, sending it back puts it back in place.
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    let d = create(s, "p", "d").await;
    set_status(s, &b, ItemStatus::InProgress).await;
    let rec = s
        .update_item(&b, status(ItemStatus::Review, ""), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.status, ItemStatus::Review);
    assert!(rec.item.queued && !rec.item.blocked);
    let last = rec.events.last().unwrap();
    assert_eq!(last.body, "Status: in_progress → review.");
    assert_eq!(last.kind, EventKind::Status);
    assert_eq!(sound(s, "p").await, ids(&[&a, &b, &c, &d]));
    // pending and failed go to review too; d is deferred.
    set_status(s, &c, ItemStatus::Failed).await;
    set_status(s, &c, ItemStatus::Review).await;
    set_status(s, &d, ItemStatus::Deferred).await;
    // The queue view: review first, out of the queue, blocked and deferred.
    let view = s.queue_view("p").await.unwrap();
    let v = |items: &[Item]| items.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
    assert_eq!(v(&view.review), ids(&[&b, &c]));
    assert_eq!(v(&view.queue), ids(&[&a]));
    assert!(view.blocked.is_empty());
    assert_eq!(v(&view.deferred), ids(&[&d]));
    // A review item may be blocked as well, and still shows under review.
    s.update_item(
        &c,
        ItemUpdate {
            block_reason: Some(BlockReason::Redesign),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let view = s.queue_view("p").await.unwrap();
    assert_eq!(v(&view.review), ids(&[&b, &c]));
    assert!(view.blocked.is_empty());
    let p = &s.list_projects().await.unwrap()[0];
    assert_eq!((p.queued, p.blocked, p.deferred, p.review), (4, 0, 1, 2));
    assert_eq!(
        v(&s.list_items("p", Some(ItemStatus::Review), None)
            .await
            .unwrap()),
        ids(&[&b, &c])
    );
    // It can be an anchor, and moved.
    mv(s, "p", &a, Place::After(b.clone())).await;
    assert_eq!(sound(s, "p").await, ids(&[&b, &a, &c, &d]));
    // Send back: in place, to in_progress or pending.
    set_status(s, &b, ItemStatus::InProgress).await;
    assert_eq!(sound(s, "p").await, ids(&[&b, &a, &c, &d]));
    set_status(s, &b, ItemStatus::Review).await;
    set_status(s, &b, ItemStatus::Pending).await;
    assert_eq!(sound(s, "p").await, ids(&[&b, &a, &c, &d]));
    // Confirm: done, out of the list, the block cleared.
    let rec = s
        .update_item(&c, status(ItemStatus::Done, ""), &web())
        .await
        .unwrap();
    assert_eq!(rec.item.status, ItemStatus::Done);
    assert!(rec.item.done_at.is_some() && !rec.item.blocked);
    assert_eq!(sound(s, "p").await, ids(&[&b, &a, &d]));
    // Negative: review -> failed and review -> deferred are refused, and
    // deferred, done or cancelled -> review.
    set_status(s, &a, ItemStatus::Review).await;
    for to in [ItemStatus::Failed, ItemStatus::Deferred] {
        let e = s.update_item(&a, status(to, ""), &mcp()).await.unwrap_err();
        assert!(
            e.to_string()
                .contains(&format!("cannot go from review to {to}")),
            "{e}"
        );
    }
    for from in [&d, &c] {
        let e = s
            .update_item(from, status(ItemStatus::Review, ""), &mcp())
            .await
            .unwrap_err();
        assert!(e.to_string().contains("to review"), "{e}");
    }
    // Cancelling a review item takes it out of the list.
    set_status(s, &a, ItemStatus::Cancelled).await;
    assert_eq!(sound(s, "p").await, ids(&[&b, &d]));
}

#[tokio::test]
async fn the_retired_block_reason_approval_is_refused_pointing_at_review() {
    // rag-t0024: approval is no longer a block reason, and saying it gets a
    // message naming what replaced it, both parsed and deserialised.
    let e = BlockReason::from_str("approval").unwrap_err().to_string();
    assert!(e.contains("status review"), "{e}");
    let e = serde_json::from_value::<BlockReason>(json!("approval"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("status review"), "{e}");
    assert!(!BlockReason::ALL.iter().any(|r| r.as_str() == "approval"));
    // The other reasons still parse, and an unknown one keeps serde's message.
    for r in ["redesign", "review", "dependency"] {
        assert_eq!(BlockReason::from_str(r).unwrap().as_str(), r);
        assert_eq!(
            serde_json::from_value::<BlockReason>(json!(r))
                .unwrap()
                .as_str(),
            r
        );
    }
    let e = serde_json::from_value::<BlockReason>(json!("bored"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("unknown variant"), "{e}");
    let e = BlockReason::from_str("bored").unwrap_err().to_string();
    assert!(e.contains("redesign|review|dependency"), "{e}");
}

/// rag-t0024: a database from before the review status, holding items blocked
/// with the retired reason approval, opens with each of them in review,
/// unblocked and in place, once; other reasons are untouched.
#[tokio::test]
async fn an_older_database_moves_approval_blocks_to_review_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::query(SCHEMA_SQL).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO projects (name, head_id, tail_id, item_seq, created_at) \
             VALUES ('old', 'old-t0001', 'old-t0004', 4, '2026-10-27T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // 1 pending blocked approval with a note, 2 in progress blocked
        // redesign, 3 deferred blocked approval without a note, 4 plain.
        for (seq, status, reason, note, prev, next) in [
            (
                1,
                "pending",
                Some("approval"),
                Some("owner's pick"),
                None,
                Some(2),
            ),
            (2, "in_progress", Some("redesign"), None, Some(1), Some(3)),
            (3, "deferred", Some("approval"), None, Some(2), Some(4)),
            (4, "pending", None, None, Some(3), None),
        ] {
            let id = |n: Option<i32>| n.map(|n| format!("old-t{n:04}"));
            sqlx::query(
                "INSERT INTO items (id, project, seq, type, title, status, blocked, block_reason, \
                 block_note, approval, prev_id, next_id, created_at, updated_at) VALUES \
                 (?, 'old', ?, 'dev', 'x', ?, ?, ?, ?, 'unapproved', ?, ?, \
                 '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')",
            )
            .bind(id(Some(seq)))
            .bind(seq)
            .bind(status)
            .bind(reason.is_some())
            .bind(reason)
            .bind(note)
            .bind(id(prev))
            .bind(id(next))
            .execute(&pool)
            .await
            .unwrap();
        }
        pool.close().await;
    }
    for _pass in 0..2 {
        let store = TrackerStore::open(&path, dir.path().join("att"))
            .await
            .unwrap();
        assert_eq!(
            sound(&store, "old").await,
            ids(&["old-t0001", "old-t0002", "old-t0003", "old-t0004"])
        );
        let one = item(&store, "old-t0001").await;
        assert_eq!(one.item.status, ItemStatus::Review);
        assert!(!one.item.blocked && one.item.block_reason.is_none());
        assert_eq!(one.item.block_note, None);
        // Exactly one event, however often the database is opened.
        assert_eq!(one.events.len(), 1);
        let e = &one.events[0];
        assert_eq!(e.kind, EventKind::Status);
        assert_eq!(
            e.body,
            format!("{MIGRATED_TO_REVIEW} The block note was: owner's pick")
        );
        assert_eq!(
            (e.author_email.as_str(), e.agent.as_str(), e.surface),
            (MIGRATION_ACTOR.0, MIGRATION_ACTOR.1, Surface::Mcp)
        );
        assert_eq!(e.fields, json!({ "status": "review", "blocked": false }));
        let three = item(&store, "old-t0003").await;
        assert_eq!(three.item.status, ItemStatus::Review);
        assert!(!three.item.blocked);
        assert_eq!(three.events.len(), 1);
        assert_eq!(three.events[0].body, MIGRATED_TO_REVIEW);
        // Another reason is untouched, and so is an unblocked item.
        let two = item(&store, "old-t0002").await;
        assert_eq!(two.item.status, ItemStatus::InProgress);
        assert_eq!(two.item.block_reason, Some(BlockReason::Redesign));
        assert!(two.events.is_empty());
        let four = item(&store, "old-t0004").await;
        assert_eq!(four.item.status, ItemStatus::Pending);
        assert!(four.events.is_empty());
        let view = store.queue_view("old").await.unwrap();
        let v = |items: &[Item]| items.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
        assert_eq!(v(&view.review), ids(&["old-t0001", "old-t0003"]));
        assert_eq!(v(&view.blocked), ids(&["old-t0002"]));
        assert_eq!(v(&view.queue), ids(&["old-t0004"]));
        store.pool.close().await;
    }
}

#[test]
fn the_queued_sql_list_agrees_with_queued_status() {
    for st in ItemStatus::ALL {
        assert_eq!(
            super::items::QUEUED_IN.contains(&format!("'{}'", st.as_str())),
            queued_status(*st),
            "{st}"
        );
    }
}

#[tokio::test]
async fn ratified_follows_only_an_agent_approval() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let e = s
        .update_item(
            &a,
            ItemUpdate {
                approval: Some(Approval::Ratified),
                note: Some("ok".into()),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("not agent"), "{e}");
    s.update_item(
        &a,
        ItemUpdate {
            approval: Some(Approval::Agent),
            note: Some("manager approved".into()),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let r = s
        .update_item(
            &a,
            ItemUpdate {
                approval: Some(Approval::Ratified),
                note: Some("owner agrees".into()),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    assert_eq!(r.item.approval, Approval::Ratified);
    let last = r.events.last().unwrap();
    assert_eq!(last.kind, EventKind::Approve);
    assert_eq!(last.surface, Surface::Web);
    assert_eq!(
        last.agent, "Unknown",
        "an absent agent is recorded as Unknown"
    );
}

#[tokio::test]
async fn project_names_are_validated_and_reserved_names_refused() {
    let f = fixture().await;
    for bad in [
        "items",
        "docs",
        "attachments",
        "projects",
        "",
        "-x",
        "a b",
        "a/b",
    ] {
        assert!(
            f.store
                .create_item(new_item(bad, "x"), &mcp())
                .await
                .is_err(),
            "{bad:?}"
        );
    }
    assert!(f
        .store
        .create_item(new_item("my-repo.v2_x", "x"), &mcp())
        .await
        .is_ok());
}

#[tokio::test]
async fn writes_need_an_author_email() {
    let f = fixture().await;
    let e = f
        .store
        .create_item(
            new_item("p", "x"),
            &Actor::new(" ", Some("a"), Surface::Mcp),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("author_email"), "{e}");
}

#[tokio::test]
async fn links_are_validated() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let link = |kind, target: &str| Link {
        kind,
        target: target.into(),
    };
    for bad in [
        link(LinkKind::Spec, "nope"),
        link(LinkKind::Milestone, "nope"),
        link(LinkKind::Milestone, "nope/m01"),
        link(LinkKind::Concept, "nope"),
        link(LinkKind::Item, "p-t0999"),
        link(LinkKind::Item, &a),
        link(LinkKind::Ledger, "has space"),
    ] {
        let upd = ItemUpdate {
            add_links: vec![bad.clone()],
            ..Default::default()
        };
        assert!(s.update_item(&a, upd, &mcp()).await.is_err(), "{bad:?}");
    }
    let b = create(s, "q", "b").await;
    let r = s
        .update_item(
            &a,
            ItemUpdate {
                add_links: vec![link(LinkKind::Ledger, "ubu-1592"), link(LinkKind::Item, &b)],
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(r.item.links.len(), 2);
    assert_eq!(r.events.last().unwrap().kind, EventKind::Link);
    let r = s
        .update_item(
            &a,
            ItemUpdate {
                remove_links: vec![link(LinkKind::Ledger, "ubu-1592")],
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(r.item.links, vec![link(LinkKind::Item, &b)]);
}

// ---- The queue view and acknowledge ------------------------------------------

/// Done reads in the order the items finished, oldest first and the newest
/// last, just above the queue (rag-t0029): `done_at` decides, not the id, and
/// the id breaks a tie within one second.
#[tokio::test]
async fn the_queue_views_done_is_oldest_first_by_done_at() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    for id in [&a, &b, &c] {
        finish(s, id).await;
    }
    // b finished first, then c, then a: the reverse of their ids for a and c.
    for (id, at) in [
        (&b, "2026-10-27T09:00:00Z"),
        (&c, "2026-10-27T10:00:00Z"),
        (&a, "2026-10-27T11:00:00Z"),
    ] {
        sqlx::query("UPDATE items SET done_at = ? WHERE id = ?")
            .bind(at)
            .bind(id)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    let view = s.queue_view("p").await.unwrap();
    assert_eq!(
        view.done.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![b.clone(), c.clone(), a.clone()]
    );
    // The same second: the lower id first.
    sqlx::query("UPDATE items SET done_at = '2026-10-27T09:00:00Z' WHERE id = ?")
        .bind(&a)
        .execute(&s.pool)
        .await
        .unwrap();
    let view = s.queue_view("p").await.unwrap();
    assert_eq!(
        view.done.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![a.clone(), b.clone(), c.clone()]
    );
}

#[tokio::test]
async fn the_queue_view_and_acknowledge_all_done() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let g = s
        .create_item(new_gate("p", Intensity::Standard), &mcp())
        .await
        .unwrap()
        .item
        .id;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    finish(s, &a).await;
    finish(s, &c).await;
    let view = s.queue_view("p").await.unwrap();
    assert!(view.exists);
    assert_eq!(
        view.done.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![a.clone(), c.clone()],
        "oldest first, newest last (rag-t0029)"
    );
    assert_eq!(
        view.queue.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        vec![g.clone(), b.clone()]
    );
    assert!(view.blocked.is_empty());

    let acked = s.acknowledge_done("p", &web()).await.unwrap();
    assert_eq!(acked, vec![a.clone(), c.clone()]);
    let view = s.queue_view("p").await.unwrap();
    assert!(view.done.is_empty());
    let a_rec = s.get_item(&a, true).await.unwrap().unwrap();
    assert!(a_rec.item.acknowledged_at.is_some());
    assert_eq!(a_rec.events.last().unwrap().kind, EventKind::Acknowledge);
    // Nothing left to acknowledge.
    assert!(s.acknowledge_done("p", &web()).await.unwrap().is_empty());

    let unknown = s.queue_view("nobody").await.unwrap();
    assert!(!unknown.exists && unknown.queue.is_empty());

    let projects = s.list_projects().await.unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].queued, 2);
    assert_eq!(
        s.list_items("p", Some(ItemStatus::Done), None)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(s.list_items("p", None, None).await.unwrap().len(), 4);
}

// ---- Events -----------------------------------------------------------------

/// Every write appends exactly one event, with its surface and agent, and the
/// history explains every field's current value.
#[tokio::test]
async fn every_write_appends_exactly_one_event_that_explains_it() {
    let f = fixture().await;
    let s = &f.store;
    let other = create(s, "p", "other").await;
    let id = create(s, "p", "a").await;

    let writes: Vec<(ItemUpdate, Actor, EventKind)> = vec![
        (
            status(ItemStatus::InProgress, "started"),
            mcp(),
            EventKind::Status,
        ),
        (
            ItemUpdate {
                assignee: Some("dev-3".into()),
                ..Default::default()
            },
            mcp(),
            EventKind::Assign,
        ),
        (
            ItemUpdate {
                title: Some("A, retitled".into()),
                ..Default::default()
            },
            web(),
            EventKind::Edit,
        ),
        (
            ItemUpdate {
                body: Some("The brief.".into()),
                ..Default::default()
            },
            mcp(),
            EventKind::Edit,
        ),
        (
            ItemUpdate {
                approval: Some(Approval::Owner),
                note: Some("owner said yes in chat".into()),
                ..Default::default()
            },
            mcp(),
            EventKind::Approve,
        ),
        (
            ItemUpdate {
                block_reason: Some(BlockReason::Review),
                note: Some("review".into()),
                ..Default::default()
            },
            mcp(),
            EventKind::Block,
        ),
        (
            ItemUpdate {
                blocked: Some(false),
                note: Some("reviewed".into()),
                ..Default::default()
            },
            web(),
            EventKind::Unblock,
        ),
        (
            ItemUpdate {
                add_links: vec![Link {
                    kind: LinkKind::Ledger,
                    target: "rag-0033".into(),
                }],
                ..Default::default()
            },
            mcp(),
            EventKind::Link,
        ),
        (
            ItemUpdate {
                note: Some("just a note".into()),
                ..Default::default()
            },
            mcp(),
            EventKind::Note,
        ),
    ];
    let mut expected = 1;
    for (upd, actor, kind) in writes {
        let rec = s.update_item(&id, upd, &actor).await.unwrap();
        expected += 1;
        assert_eq!(rec.events.len(), expected);
        let e = rec.events.last().unwrap();
        assert_eq!(e.kind, kind);
        assert_eq!(e.surface, actor.surface);
        assert_eq!(
            e.agent,
            actor.agent.clone().unwrap_or_else(|| "Unknown".into())
        );
    }
    s.move_item(&id, Place::Before(other.clone()), Some("first"), &mcp())
        .await
        .unwrap();
    let rec = s.get_item(&id, true).await.unwrap().unwrap();
    assert_eq!(rec.events.len(), expected + 1);
    assert_eq!(rec.events.last().unwrap().kind, EventKind::Move);
    assert_eq!(rec.events.last().unwrap().body, "first");

    // Replay the history: the last value each event set is the current value.
    let mut replay = serde_json::Map::new();
    for e in &rec.events {
        if let serde_json::Value::Object(m) = &e.fields {
            for (k, v) in m {
                replay.insert(k.clone(), v.clone());
            }
        }
    }
    let item = serde_json::to_value(&rec.item).unwrap();
    for field in ["title", "status", "approval", "assignee", "body", "blocked"] {
        assert_eq!(
            replay[field], item[field],
            "history does not explain {field}"
        );
    }
    assert_eq!(replay["links_added"], serde_json::json!(item["links"]));
}

#[tokio::test]
async fn an_update_that_changes_nothing_and_says_nothing_is_refused() {
    let f = fixture().await;
    let a = create(&f.store, "p", "a").await;
    let e = f
        .store
        .update_item(
            &a,
            ItemUpdate {
                title: Some("a".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("nothing to update"), "{e}");
}

// ---- A property test --------------------------------------------------------

/// xorshift64*: deterministic, dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// 1000 random creates, moves, completions, reopens, cancels, failures and
/// blocks on one project; after each, the integrity check passes and the walk
/// equals a reference `Vec` model.
#[tokio::test]
async fn random_operations_match_a_reference_model() {
    let f = fixture().await;
    let s = &f.store;
    let p = "prop";
    let mut rng = Rng(0x5EED_1234_ABCD_0042);
    let mut model: Vec<String> = Vec::new();
    let mut status: std::collections::HashMap<String, ItemStatus> = Default::default();
    let mut blocked: std::collections::HashSet<String> = Default::default();

    for step in 0..1000 {
        let queued: Vec<String> = model.clone();
        let off: Vec<String> = status
            .iter()
            .filter(|(_, st)| !queued_status(**st))
            .map(|(id, _)| id.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let op = rng.below(14);
        match op {
            // create, at the bottom or at a random place
            0 | 1 => {
                let place = if queued.is_empty() || rng.below(2) == 0 {
                    Place::Bottom
                } else {
                    let anchor = queued[rng.below(queued.len())].clone();
                    match rng.below(4) {
                        0 => Place::Top,
                        1 => Place::Bottom,
                        2 => Place::Before(anchor),
                        _ => Place::After(anchor),
                    }
                };
                let id = s
                    .create_item(
                        NewItem {
                            place: place.clone(),
                            ..new_item(p, "x")
                        },
                        &mcp(),
                    )
                    .await
                    .unwrap()
                    .item
                    .id;
                match place {
                    Place::Top => model.insert(0, id.clone()),
                    Place::Bottom => model.push(id.clone()),
                    Place::Before(a) => {
                        let i = model.iter().position(|x| *x == a).unwrap();
                        model.insert(i, id.clone());
                    }
                    Place::After(a) => {
                        let i = model.iter().position(|x| *x == a).unwrap();
                        model.insert(i + 1, id.clone());
                    }
                }
                status.insert(id, ItemStatus::Pending);
            }
            // move
            2 | 3 if queued.len() >= 2 => {
                let id = queued[rng.below(queued.len())].clone();
                let anchor = queued[rng.below(queued.len())].clone();
                let place = match rng.below(4) {
                    0 => Place::Top,
                    1 => Place::Bottom,
                    2 => Place::Before(anchor.clone()),
                    _ => Place::After(anchor.clone()),
                };
                let res = s.move_item(&id, place.clone(), None, &mcp()).await;
                if anchor == id && matches!(place, Place::Before(_) | Place::After(_)) {
                    assert!(
                        res.is_err(),
                        "step {step}: a move relative to itself must be refused"
                    );
                } else {
                    res.unwrap();
                    model.retain(|x| *x != id);
                    match place {
                        Place::Top => model.insert(0, id),
                        Place::Bottom => model.push(id),
                        Place::Before(a) => {
                            let i = model.iter().position(|x| *x == a).unwrap();
                            model.insert(i, id);
                        }
                        Place::After(a) => {
                            let i = model.iter().position(|x| *x == a).unwrap();
                            model.insert(i + 1, id);
                        }
                    }
                }
            }
            // complete (via in_progress)
            4 if !queued.is_empty() => {
                let id = queued[rng.below(queued.len())].clone();
                if status[&id] != ItemStatus::InProgress {
                    if status[&id] == ItemStatus::Failed {
                        set_status(s, &id, ItemStatus::Pending).await;
                    }
                    set_status(s, &id, ItemStatus::InProgress).await;
                }
                set_status(s, &id, ItemStatus::Done).await;
                model.retain(|x| *x != id);
                blocked.remove(&id);
                status.insert(id, ItemStatus::Done);
            }
            // reopen
            5 if !off.is_empty() => {
                let id = off[rng.below(off.len())].clone();
                set_status(s, &id, ItemStatus::Pending).await;
                model.insert(0, id.clone());
                status.insert(id, ItemStatus::Pending);
            }
            // cancel
            6 if !queued.is_empty() => {
                let id = queued[rng.below(queued.len())].clone();
                set_status(s, &id, ItemStatus::Cancelled).await;
                model.retain(|x| *x != id);
                blocked.remove(&id);
                status.insert(id, ItemStatus::Cancelled);
            }
            // fail
            7 if !queued.is_empty() => {
                let id = queued[rng.below(queued.len())].clone();
                if matches!(status[&id], ItemStatus::Deferred | ItemStatus::Review) {
                    set_status(s, &id, ItemStatus::Pending).await;
                    status.insert(id.clone(), ItemStatus::Pending);
                }
                if status[&id] == ItemStatus::Pending {
                    set_status(s, &id, ItemStatus::InProgress).await;
                }
                if status[&id] != ItemStatus::Failed {
                    set_status(s, &id, ItemStatus::Failed).await;
                }
                status.insert(id, ItemStatus::Failed);
            }
            // block or unblock
            8 | 9 if !queued.is_empty() => {
                let id = queued[rng.below(queued.len())].clone();
                let upd = if blocked.contains(&id) {
                    blocked.remove(&id);
                    ItemUpdate {
                        blocked: Some(false),
                        note: Some("go".into()),
                        ..Default::default()
                    }
                } else {
                    blocked.insert(id.clone());
                    ItemUpdate {
                        block_reason: Some(BlockReason::Redesign),
                        note: Some("wait".into()),
                        ..Default::default()
                    }
                };
                s.update_item(&id, upd, &mcp()).await.unwrap();
            }
            // defer (rag-t0017): stays in place
            10 if !queued.is_empty() => {
                let id = queued[rng.below(queued.len())].clone();
                if status[&id] == ItemStatus::Review {
                    set_status(s, &id, ItemStatus::Pending).await;
                }
                if status[&id] != ItemStatus::Deferred {
                    set_status(s, &id, ItemStatus::Deferred).await;
                    status.insert(id, ItemStatus::Deferred);
                }
            }
            // to review (rag-t0024): stays in place
            12 if !queued.is_empty() => {
                let id = queued[rng.below(queued.len())].clone();
                if status[&id] == ItemStatus::Deferred {
                    set_status(s, &id, ItemStatus::Pending).await;
                }
                if status[&id] != ItemStatus::Review {
                    set_status(s, &id, ItemStatus::Review).await;
                    status.insert(id, ItemStatus::Review);
                }
            }
            // send back: review -> in_progress, in place
            13 => {
                let review: Vec<&String> = queued
                    .iter()
                    .filter(|id| status[*id] == ItemStatus::Review)
                    .collect();
                if review.is_empty() {
                    continue;
                }
                let id = review[rng.below(review.len())].clone();
                set_status(s, &id, ItemStatus::InProgress).await;
                status.insert(id, ItemStatus::InProgress);
            }
            // resume: deferred -> pending, in place
            11 => {
                let deferred: Vec<&String> = queued
                    .iter()
                    .filter(|id| status[*id] == ItemStatus::Deferred)
                    .collect();
                if deferred.is_empty() {
                    continue;
                }
                let id = deferred[rng.below(deferred.len())].clone();
                set_status(s, &id, ItemStatus::Pending).await;
                status.insert(id, ItemStatus::Pending);
            }
            _ => continue,
        }
        let order = sound(s, p).await;
        assert_eq!(order, model, "step {step}, op {op}");
    }
    // The queue view agrees with the model too.
    let view = s.queue_view(p).await.unwrap();
    let mut walk: Vec<String> = Vec::new();
    let (mut q, mut b, mut d) = (view.queue.iter(), view.blocked.iter(), view.deferred.iter());
    let mut r = view.review.iter();
    let (mut deferred_seen, mut review_seen) = (0, 0);
    for id in &model {
        if status[id] == ItemStatus::Review {
            assert_eq!(&r.next().unwrap().id, id);
            review_seen += 1;
        } else if status[id] == ItemStatus::Deferred {
            assert_eq!(&d.next().unwrap().id, id);
            deferred_seen += 1;
        } else if blocked.contains(id) {
            assert_eq!(&b.next().unwrap().id, id);
        } else {
            assert_eq!(&q.next().unwrap().id, id);
        }
        walk.push(id.clone());
    }
    assert!(q.next().is_none() && b.next().is_none() && d.next().is_none());
    assert!(r.next().is_none());
    assert!(deferred_seen > 0, "the walk exercised no deferred item");
    assert!(review_seen > 0, "the walk exercised no review item");
}

// ---- Concurrency ------------------------------------------------------------

/// Two connections (two stores on one file) moving and creating in the same
/// project at once: the list is intact and every item appears once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_keep_the_list_intact() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("tracker.db");
    let s1 = TrackerStore::open(&db, dir.path().join("att"))
        .await
        .unwrap();
    let s2 = TrackerStore::open(&db, dir.path().join("att"))
        .await
        .unwrap();
    for n in 0..6 {
        s1.create_item(new_item("c", &format!("seed {n}")), &mcp())
            .await
            .unwrap();
    }

    async fn churn(s: TrackerStore, seed: u64) -> Vec<String> {
        let mut rng = Rng(seed);
        let mut created = Vec::new();
        for n in 0..40 {
            if n % 3 == 0 {
                created.push(
                    s.create_item(new_item("c", "x"), &mcp())
                        .await
                        .unwrap()
                        .item
                        .id,
                );
            } else {
                let order = s.check("c").await.unwrap().order;
                let id = order[rng.below(order.len())].clone();
                let anchor = order[rng.below(order.len())].clone();
                let place = match rng.below(4) {
                    0 => Place::Top,
                    1 => Place::Bottom,
                    2 => Place::Before(anchor),
                    _ => Place::After(anchor),
                };
                // A move relative to itself is refused; nothing else may fail.
                if let Err(e) = s.move_item(&id, place, None, &mcp()).await {
                    assert!(matches!(e, TrackerError::Refused(_)), "{e}");
                }
            }
        }
        created
    }

    let (a, b) = tokio::join!(
        tokio::spawn(churn(s1.clone(), 0xA11CE)),
        tokio::spawn(churn(s2.clone(), 0xB0B))
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    let report = s1.check("c").await.unwrap();
    assert!(report.ok, "{:?}", report.problems);
    assert_eq!(report.order.len(), 6 + a.len() + b.len());
    let unique: std::collections::HashSet<_> = report.order.iter().collect();
    assert_eq!(unique.len(), report.order.len(), "every item appears once");
    for id in a.iter().chain(b.iter()) {
        assert!(unique.contains(id));
    }
}

// ---- Documents --------------------------------------------------------------

async fn doc(s: &TrackerStore, path: &str, body: &str) -> DocumentView {
    s.create_document(
        NewDocument {
            project: "p".into(),
            path: path.into(),
            title: "A doc".into(),
            body: body.into(),
            message: None,
        },
        &mcp(),
    )
    .await
    .unwrap()
}

fn rep(old: &str, new: &str) -> Replacement {
    Replacement {
        old: old.into(),
        new: new.into(),
    }
}

#[tokio::test]
async fn an_edit_applies_every_replacement_or_none() {
    let f = fixture().await;
    let s = &f.store;
    let d = doc(s, "notes/a.md", "alpha\nbeta\ngamma\n").await;
    assert_eq!(d.document.id, "p-d0001");
    assert_eq!(d.document.revision, 1);
    let id = d.document.id.clone();

    let d = s
        .edit_document(
            &id,
            1,
            Edit::Replace(vec![rep("alpha", "ALPHA"), rep("gamma", "GAMMA")]),
            Some("caps"),
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(d.body, "ALPHA\nbeta\nGAMMA\n");
    assert_eq!(d.document.revision, 2);

    // One `old` twice, or not at all: nothing changes.
    let s2 = s
        .edit_document(&id, 2, Edit::Body("x x\n".into()), None, &mcp())
        .await
        .unwrap();
    assert_eq!(s2.document.revision, 3);
    for bad in [
        vec![rep("x", "y")],
        vec![rep("absent", "y")],
        vec![rep("x x", "z"), rep("nope", "q")],
    ] {
        let e = s
            .edit_document(&id, 3, Edit::Replace(bad), None, &mcp())
            .await
            .unwrap_err();
        assert!(matches!(e, TrackerError::Refused(_)), "{e}");
    }
    let now = s.get_document(&id, None, false).await.unwrap().unwrap();
    assert_eq!(now.body, "x x\n");
    assert_eq!(now.document.revision, 3);
    // An edit that changes nothing is refused.
    assert!(s
        .edit_document(&id, 3, Edit::Body("x x\n".into()), None, &mcp())
        .await
        .is_err());
}

#[tokio::test]
async fn an_edit_on_a_stale_base_is_refused_with_the_current_revision() {
    let f = fixture().await;
    let s = &f.store;
    let id = doc(s, "a.md", "one\n").await.document.id;
    s.edit_document(&id, 1, Edit::Body("two\n".into()), None, &web())
        .await
        .unwrap();
    match s
        .edit_document(&id, 1, Edit::Body("mine\n".into()), None, &mcp())
        .await
        .unwrap_err()
    {
        TrackerError::Stale {
            current_revision,
            message,
        } => {
            assert_eq!(current_revision, 2);
            assert!(message.contains("revision 2"), "{message}");
        }
        other => panic!("expected Stale, got {other}"),
    }
    assert_eq!(
        s.get_document(&id, None, false)
            .await
            .unwrap()
            .unwrap()
            .body,
        "two\n"
    );
    // Restore checks the base too.
    assert!(matches!(
        s.restore_revision(&id, 1, 1, None, &mcp())
            .await
            .unwrap_err(),
        TrackerError::Stale {
            current_revision: 2,
            ..
        }
    ));
}

#[tokio::test]
async fn a_rename_leaves_a_redirect_that_a_get_follows() {
    let f = fixture().await;
    let s = &f.store;
    let id = doc(s, "concepts/old.md", "body\n").await.document.id;
    let r = s
        .rename_document(&id, Some("concepts/new.md"), None, None, &mcp())
        .await
        .unwrap();
    assert_eq!(r.document.path, "concepts/new.md");
    assert_eq!(r.events.last().unwrap().kind, EventKind::Rename);

    let got = s
        .get_document_by_path("p", "concepts/old.md", None, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.document.id, id);
    assert_eq!(got.redirected_from.as_deref(), Some("concepts/old.md"));
    let direct = s
        .get_document_by_path("p", "concepts/new.md", None, false)
        .await
        .unwrap()
        .unwrap();
    assert!(direct.redirected_from.is_none());

    // The old path is never given to another document.
    let e = s
        .create_document(
            NewDocument {
                project: "p".into(),
                path: "concepts/old.md".into(),
                title: "t".into(),
                body: String::new(),
                message: None,
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("never reused"), "{e}");
    let other = doc(s, "other.md", "o\n").await.document.id;
    assert!(s
        .rename_document(&other, Some("concepts/old.md"), None, None, &mcp())
        .await
        .is_err());
    // Nor a path a document holds.
    assert!(s
        .rename_document(&other, Some("concepts/new.md"), None, None, &mcp())
        .await
        .is_err());
    // But the document itself may go back to it.
    let back = s
        .rename_document(&id, Some("concepts/old.md"), None, None, &mcp())
        .await
        .unwrap();
    assert_eq!(back.document.path, "concepts/old.md");
    let fwd = s
        .get_document_by_path("p", "concepts/new.md", None, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fwd.redirected_from.as_deref(), Some("concepts/new.md"));
    // A retitle alone.
    let t = s
        .rename_document(&id, None, Some("Better"), None, &mcp())
        .await
        .unwrap();
    assert_eq!(t.document.title, "Better");
    assert!(s
        .rename_document(&id, None, Some("Better"), None, &mcp())
        .await
        .is_err());
}

#[tokio::test]
async fn invalid_paths_are_refused() {
    let f = fixture().await;
    for bad in [
        "/abs.md",
        "a/../b.md",
        "a//b.md",
        "no-ext",
        "sp ace.md",
        "./a.md",
        "",
    ] {
        let e = f
            .store
            .create_document(
                NewDocument {
                    project: "p".into(),
                    path: bad.into(),
                    title: "t".into(),
                    body: String::new(),
                    message: None,
                },
                &mcp(),
            )
            .await;
        assert!(e.is_err(), "{bad:?}");
    }
}

#[tokio::test]
async fn restore_writes_the_old_body_as_a_new_revision() {
    let f = fixture().await;
    let s = &f.store;
    let id = doc(s, "a.md", "first\n").await.document.id;
    s.edit_document(&id, 1, Edit::Body("second\n".into()), None, &mcp())
        .await
        .unwrap();
    let r = s.restore_revision(&id, 1, 2, None, &web()).await.unwrap();
    assert_eq!(r.document.revision, 3);
    assert_eq!(r.body, "first\n");
    assert_eq!(r.events.last().unwrap().fields["restored_from"], 1);
    let revs = s.list_revisions(&id).await.unwrap();
    assert_eq!(
        revs.iter().map(|r| r.revision).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(revs[2].message, "Restored revision 1.");
    assert_eq!(revs[2].surface, Surface::Web);
    assert_eq!(revs[0].size, 6);
    // An old revision is readable.
    let old = s.get_document(&id, Some(2), false).await.unwrap().unwrap();
    assert_eq!(old.body, "second\n");
    assert_eq!(old.body_revision, 2);
    assert_eq!(old.document.revision, 3);
    // Restoring what is already current is refused.
    assert!(s.restore_revision(&id, 3, 3, None, &web()).await.is_err());
}

#[tokio::test]
async fn the_diff_of_two_revisions_is_correct() {
    let f = fixture().await;
    let s = &f.store;
    let id = doc(s, "a.md", "a\nb\nc\n").await.document.id;
    s.edit_document(
        &id,
        1,
        Edit::Replace(vec![rep("b\n", "B\nb2\n")]),
        None,
        &mcp(),
    )
    .await
    .unwrap();
    let d = s.diff_revisions(&id, None, None).await.unwrap();
    assert_eq!((d.from, d.to), (1, 2));
    assert_eq!(
        d.diff,
        "--- revision 1\n+++ revision 2\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+b2\n c\n"
    );
    let same = s.diff_revisions(&id, Some(2), Some(2)).await.unwrap();
    assert!(same.diff.is_empty());
    assert!(matches!(
        s.diff_revisions(&id, Some(1), Some(9)).await.unwrap_err(),
        TrackerError::NotFound(_)
    ));
}

#[tokio::test]
async fn documents_list_by_kind_and_prefix() {
    let f = fixture().await;
    let s = &f.store;
    doc(s, "notes/a.md", "").await;
    doc(s, "notes/b.md", "").await;
    doc(s, "other.md", "").await;
    assert_eq!(s.list_documents("p", None, None).await.unwrap().len(), 3);
    assert_eq!(
        s.list_documents("p", None, Some("notes/"))
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.list_documents("p", Some(DocKind::Spec), None)
            .await
            .unwrap()
            .len(),
        0
    );
}

// ---- Specs, milestones and concepts -------------------------------------------

fn new_spec(slug: &str, milestones: Vec<NewMilestone>) -> NewSpec {
    NewSpec {
        project: "p".into(),
        slug: slug.into(),
        title: "Tracker".into(),
        state: None,
        approval: Approval::Unapproved,
        body: "# Tracker\n".into(),
        milestones,
        note: None,
    }
}

fn ms(code: &str, title: &str, name: Option<&str>) -> NewMilestone {
    NewMilestone {
        code: code.into(),
        title: title.into(),
        name: name.map(str::to_string),
        state: None,
        approval: Approval::Unapproved,
        body: format!("# {title}\n"),
        note: None,
    }
}

#[tokio::test]
async fn a_spec_with_two_milestones_makes_three_documents() {
    let f = fixture().await;
    let s = &f.store;
    let spec = s
        .create_spec(
            new_spec(
                "tracker",
                vec![
                    ms("m01", "The store and the HTTP API", Some("store-and-api")),
                    ms("m02", "The MCP server", None),
                ],
            ),
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(spec.spec.state, SpecState::Draft);
    assert_eq!(spec.spec.path.as_deref(), Some("specs/tracker/master.md"));
    let paths: Vec<_> = spec
        .spec
        .milestones
        .iter()
        .map(|m| m.path.clone().unwrap())
        .collect();
    assert_eq!(
        paths,
        vec![
            "specs/tracker/m01-store-and-api.md",
            "specs/tracker/m02-the-mcp-server.md"
        ]
    );
    assert_eq!(
        spec.spec
            .milestones
            .iter()
            .map(|m| m.order)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    let docs = s
        .list_documents("p", None, Some("specs/tracker/"))
        .await
        .unwrap();
    assert_eq!(docs.len(), 3);
    let m2 = s
        .get_document_by_path("p", "specs/tracker/m02-the-mcp-server.md", None, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(m2.document.kind, DocKind::Milestone);
    assert_eq!(m2.document.milestone.as_deref(), Some("m02"));
    assert_eq!(m2.body, "# The MCP server\n");
    assert_eq!(spec.events.len(), 1);
    assert_eq!(s.list_specs("p").await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_clash_on_the_second_milestone_path_creates_nothing() {
    let f = fixture().await;
    let s = &f.store;
    doc(s, "specs/audio/m02-music.md", "squatter\n").await;
    let e = s
        .create_spec(
            new_spec(
                "audio",
                vec![ms("m01", "Sound", None), ms("m02", "Music", None)],
            ),
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("taken"), "{e}");
    assert!(s.get_spec("p", "audio", false).await.unwrap().is_none());
    assert_eq!(
        s.list_documents("p", None, Some("specs/audio/"))
            .await
            .unwrap()
            .len(),
        1,
        "only the squatter"
    );
    // A duplicate milestone code, and a duplicate spec, are refused too.
    assert!(s
        .create_spec(
            new_spec("dup", vec![ms("m01", "A", None), ms("m01", "B", None)]),
            &mcp()
        )
        .await
        .is_err());
    s.create_spec(new_spec("one", vec![]), &mcp())
        .await
        .unwrap();
    assert!(s
        .create_spec(new_spec("one", vec![]), &mcp())
        .await
        .is_err());
}

#[tokio::test]
async fn specs_and_milestones_update_with_notes() {
    let f = fixture().await;
    let s = &f.store;
    s.create_spec(new_spec("tracker", vec![ms("m01", "Store", None)]), &mcp())
        .await
        .unwrap();
    let r = s
        .update_spec(
            "p",
            "tracker",
            SpecUpdate {
                state: Some(SpecState::Ready),
                note: Some("questions answered".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(r.spec.state, SpecState::Ready);
    assert_eq!(r.events.last().unwrap().kind, EventKind::Status);
    assert_eq!(r.events.last().unwrap().body, "questions answered");

    let m = s
        .create_milestone("p", "tracker", ms("m02", "Tools", None), &mcp())
        .await
        .unwrap();
    assert_eq!(m.milestone.order, 2);
    assert_eq!(
        m.milestone.path.as_deref(),
        Some("specs/tracker/m02-tools.md")
    );
    let m = s
        .update_milestone(
            "p",
            "tracker",
            "m02",
            MilestoneUpdate {
                state: Some(MilestoneState::Done),
                note: Some("gated".into()),
                order: Some(0),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(m.milestone.state, MilestoneState::Done);
    assert_eq!(m.milestone.order, 0);
    let spec = s.get_spec("p", "tracker", false).await.unwrap().unwrap();
    assert_eq!(
        spec.spec.milestones[0].code, "m02",
        "milestones are in order"
    );
    assert!(s
        .create_milestone("p", "nope", ms("m01", "x", None), &mcp())
        .await
        .is_err());
}

/// D7 as amended 2026-10-27: a spec, milestone or concept state or approval
/// change needs no note; the body is generated from → to. A bare note still
/// must not be blank.
#[tokio::test]
async fn record_changes_without_a_note_get_a_generated_body() {
    let f = fixture().await;
    let s = &f.store;
    s.create_spec(new_spec("tracker", vec![ms("m01", "Store", None)]), &mcp())
        .await
        .unwrap();
    let r = s
        .update_spec(
            "p",
            "tracker",
            SpecUpdate {
                state: Some(SpecState::Ready),
                approval: Some(Approval::Agent),
                title: Some("The tracker".into()),
                note: Some(" ".into()),
            },
            &mcp(),
        )
        .await
        .unwrap();
    let last = r.events.last().unwrap();
    assert_eq!(last.kind, EventKind::Status);
    assert_eq!(
        last.body,
        "State: draft → ready. Approval: unapproved → agent. Set title."
    );
    let r = s
        .update_spec(
            "p",
            "tracker",
            SpecUpdate {
                approval: Some(Approval::Ratified),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    assert_eq!(r.events.last().unwrap().kind, EventKind::Approve);
    assert_eq!(r.events.last().unwrap().body, "Approval: agent → ratified.");

    let m = s
        .update_milestone(
            "p",
            "tracker",
            "m01",
            MilestoneUpdate {
                state: Some(MilestoneState::Done),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(m.milestone.state, MilestoneState::Done);
    assert_eq!(
        m.events.last().unwrap().body,
        format!("State: {} → done.", MilestoneState::NotStarted)
    );

    s.create_concept(
        NewConcept {
            project: "p".into(),
            slug: "power".into(),
            title: "Power".into(),
            state: None,
            approval: Approval::Unapproved,
            body: "musings\n".into(),
            links: vec![],
            note: None,
        },
        &web(),
    )
    .await
    .unwrap();
    let c = s
        .update_concept(
            "p",
            "power",
            ConceptUpdate {
                state: Some(ConceptState::Refined),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    assert_eq!(c.events.last().unwrap().body, "State: open → refined.");

    // A bare note must still say something.
    let e = s
        .update_spec(
            "p",
            "tracker",
            SpecUpdate {
                note: Some("  ".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("no note given"), "{e}");
    let e = s
        .update_concept("p", "power", ConceptUpdate::default(), &web())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("no note given"), "{e}");
}

#[tokio::test]
async fn concepts_are_created_with_their_document_and_link_to_what_they_became() {
    let f = fixture().await;
    let s = &f.store;
    s.create_spec(new_spec("power", vec![]), &mcp())
        .await
        .unwrap();
    let c = s
        .create_concept(
            NewConcept {
                project: "p".into(),
                slug: "power-generation".into(),
                title: "Power generation".into(),
                state: None,
                approval: Approval::Unapproved,
                body: "musings\n".into(),
                links: vec![Link {
                    kind: LinkKind::Ledger,
                    target: "ubu-0001".into(),
                }],
                note: None,
            },
            &web(),
        )
        .await
        .unwrap();
    assert_eq!(
        c.concept.path.as_deref(),
        Some("concepts/power-generation.md")
    );
    assert_eq!(c.concept.state, ConceptState::Open);
    let c = s
        .update_concept(
            "p",
            "power-generation",
            ConceptUpdate {
                state: Some(ConceptState::Refined),
                add_links: vec![Link {
                    kind: LinkKind::Spec,
                    target: "power".into(),
                }],
                note: Some("refined into the power spec".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(c.concept.state, ConceptState::Refined);
    assert_eq!(c.concept.links.len(), 2);
    assert_eq!(c.events.len(), 2);
    assert_eq!(
        s.list_concepts("p", Some(ConceptState::Refined))
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.list_concepts("p", Some(ConceptState::Open))
            .await
            .unwrap()
            .len(),
        0
    );
    // A link to a spec that does not exist is refused.
    assert!(s
        .update_concept(
            "p",
            "power-generation",
            ConceptUpdate {
                add_links: vec![Link {
                    kind: LinkKind::Spec,
                    target: "nope".into()
                }],
                ..Default::default()
            },
            &mcp()
        )
        .await
        .is_err());
}

// ---- Attachments ------------------------------------------------------------

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR fake image body";

fn att(project: &str, name: &str, media: Option<&str>, bytes: &[u8]) -> NewAttachment {
    NewAttachment {
        project: project.into(),
        name: name.into(),
        media_type: media.map(str::to_string),
        bytes: bytes.to_vec(),
    }
}

#[tokio::test]
async fn the_same_bytes_twice_are_one_file_and_two_records() {
    let f = fixture().await;
    let s = &f.store;
    let a = s
        .store_attachment(att("p", "terrain.png", Some("image/png"), PNG), &mcp())
        .await
        .unwrap();
    let b = s
        .store_attachment(att("q", "C:\\shots\\copy.png", None, PNG), &web())
        .await
        .unwrap();
    assert_eq!(a.sha256, b.sha256);
    assert_ne!(a.id, b.id);
    assert_eq!(b.name, "copy.png");
    assert_eq!(b.media_type, "image/png", "sniffed when undeclared");
    assert_eq!(a.reference, format!("att:{}", &a.sha256[..12]));
    // One file on disk.
    let mut files = 0;
    for entry in std::fs::read_dir(s.attachments_dir()).unwrap() {
        files += std::fs::read_dir(entry.unwrap().path()).unwrap().count();
    }
    assert_eq!(files, 1);
    // A 12-character prefix (or the att: reference) fetches it.
    let got = s.find_attachment(&a.sha256[..12]).await.unwrap();
    assert_eq!(std::fs::read(&got.path).unwrap(), PNG);
    assert_eq!(
        got.attachment.name, "terrain.png",
        "the first upload's record"
    );
    assert_eq!(
        s.find_attachment(&a.reference)
            .await
            .unwrap()
            .attachment
            .sha256,
        a.sha256
    );
    assert_eq!(s.list_attachments("p").await.unwrap().len(), 1);
    assert!(matches!(
        s.find_attachment("0123456789ab").await.unwrap_err(),
        TrackerError::NotFound(_)
    ));
    assert!(matches!(
        s.find_attachment("short").await.unwrap_err(),
        TrackerError::Refused(_)
    ));
}

#[tokio::test]
async fn an_ambiguous_prefix_is_refused() {
    let f = fixture().await;
    let s = &f.store;
    let a = s
        .store_attachment(att("p", "a.txt", Some("text/plain"), b"hello"), &mcp())
        .await
        .unwrap();
    // A second file sharing the first 12 characters cannot be produced by
    // hashing, so its row is planted directly.
    let twin = format!("{}{}", &a.sha256[..12], "0".repeat(52));
    sqlx::query(
        "INSERT INTO attachments (project, sha256, name, media_type, size, author_email, agent, surface, uploaded_at) \
         VALUES ('p', ?, 'twin', 'text/plain', 1, 'x', 'y', 'mcp', 'now')",
    )
    .bind(&twin)
    .execute(&s.pool)
    .await
    .unwrap();
    let e = s.find_attachment(&a.sha256[..12]).await.unwrap_err();
    assert!(e.to_string().contains("ambiguous"), "{e}");
    // The full hash is not ambiguous.
    assert_eq!(
        s.find_attachment(&a.sha256)
            .await
            .unwrap()
            .attachment
            .sha256,
        a.sha256
    );
}

#[tokio::test]
async fn oversized_and_mislabelled_uploads_are_refused() {
    let f = fixture().await;
    let s = &f.store;
    let big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
    let e = s
        .store_attachment(att("p", "big.bin", None, &big), &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("50 MB"), "{e}");
    let e = s
        .store_attachment(att("p", "x.png", Some("image/png"), b"not a png"), &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("not a recognised image"), "{e}");
    let e = s
        .store_attachment(att("p", "x.jpg", Some("image/jpeg"), PNG), &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("image/png"), "{e}");
    assert!(s
        .store_attachment(att("p", "x", Some("not a type"), b"x"), &mcp())
        .await
        .is_err());
    assert!(s
        .store_attachment(att("p", "x", None, b""), &mcp())
        .await
        .is_err());
    assert!(s.list_attachments("p").await.unwrap().is_empty());
}

#[test]
fn image_types_are_sniffed() {
    assert_eq!(sniff_image_type(PNG), Some("image/png"));
    assert_eq!(
        sniff_image_type(&[0xFF, 0xD8, 0xFF, 0xE0]),
        Some("image/jpeg")
    );
    assert_eq!(sniff_image_type(b"GIF89a...."), Some("image/gif"));
    assert_eq!(
        sniff_image_type(b"RIFF\0\0\0\0WEBPVP8 "),
        Some("image/webp")
    );
    assert_eq!(
        sniff_image_type(b"<?xml version=\"1.0\"?><svg xmlns=\"x\"/>"),
        Some("image/svg+xml")
    );
    assert_eq!(sniff_image_type(b"plain text"), None);
}

#[test]
fn slugify_makes_file_names() {
    assert_eq!(
        slugify("The store and the HTTP API"),
        "the-store-and-the-http-api"
    );
    assert_eq!(slugify("  Music & sound! "), "music-sound");
    assert_eq!(slugify("***"), "");
}

/// D7 as amended 2026-10-27: a record created approved needs no note; the
/// create event then names the approval.
#[tokio::test]
async fn an_approval_at_creation_needs_no_note() {
    let f = fixture().await;
    let s = &f.store;
    let approved = NewMilestone {
        approval: Approval::Agent,
        ..ms("m01", "Store", None)
    };
    let spec = s
        .create_spec(new_spec("b", vec![approved.clone()]), &mcp())
        .await
        .unwrap();
    assert_eq!(spec.spec.milestones[0].approval, Approval::Agent);
    assert_eq!(spec.events[0].body, "Created spec b.");
    let m = s
        .get_milestone("p", "b", "m01", true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        m.events[0].body,
        "Created milestone m01 of spec b (approval: agent)."
    );
    // The spec's note covers its milestones.
    let spec = s
        .create_spec(
            NewSpec {
                note: Some("manager approved the plan".into()),
                ..new_spec("a", vec![approved.clone()])
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(spec.spec.milestones[0].approval, Approval::Agent);
    let m = s
        .get_milestone("p", "a", "m01", true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(m.events[0].body, "manager approved the plan");
    s.create_milestone(
        "p",
        "a",
        NewMilestone {
            code: "m02".into(),
            ..approved.clone()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let item = s
        .create_item(
            NewItem {
                approval: Approval::Owner,
                ..new_item("p", "x")
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(item.item.approval, Approval::Owner);
    assert_eq!(item.events[0].body, "Created dev item (approval: owner).");
    assert!(s
        .create_item(
            NewItem {
                approval: Approval::Ratified,
                note: Some("x".into()),
                ..new_item("p", "x")
            },
            &mcp()
        )
        .await
        .is_err());
}

// ---- Parallel work past a gate (rag-t0013) ----------------------------------

#[tokio::test]
async fn parallel_is_set_on_create_and_update_and_refused_on_a_gate() {
    let f = fixture().await;
    let s = &f.store;
    let rec = s
        .create_item(
            NewItem {
                parallel: true,
                ..new_item("p", "scratch build")
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert!(rec.item.parallel);
    assert_eq!(rec.events[0].fields["parallel"], json!(true));
    let plain = create(s, "p", "plain").await;
    assert!(
        !s.get_item(&plain, false)
            .await
            .unwrap()
            .unwrap()
            .item
            .parallel
    );

    let off = s
        .update_item(
            &rec.item.id,
            ItemUpdate {
                parallel: Some(false),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    assert!(!off.item.parallel);
    let last = off.events.last().unwrap();
    assert_eq!(last.kind, EventKind::Edit);
    assert_eq!(last.body, "Parallel: off.");
    assert_eq!(last.fields["parallel"], json!(false));
    // The queue view carries it too.
    s.update_item(
        &plain,
        ItemUpdate {
            parallel: Some(true),
            ..Default::default()
        },
        &mcp(),
    )
    .await
    .unwrap();
    let view = s.queue_view("p").await.unwrap();
    let flags: Vec<bool> = view.queue.iter().map(|i| i.parallel).collect();
    assert_eq!(flags, vec![false, true]);

    // A gate is what parallel work lands after: it cannot be parallel itself.
    let e = s
        .create_item(
            NewItem {
                parallel: true,
                ..new_gate("p", Intensity::Standard)
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("a gate cannot be parallel"), "{e}");
    let g = s
        .create_item(new_gate("p", Intensity::Quick), &mcp())
        .await
        .unwrap()
        .item
        .id;
    let e = s
        .update_item(
            &g,
            ItemUpdate {
                parallel: Some(true),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    assert!(e.to_string().contains("a gate cannot be parallel"), "{e}");
    assert!(!s.get_item(&g, false).await.unwrap().unwrap().item.parallel);
    sound(s, "p").await;
}

#[tokio::test]
async fn an_older_database_gains_the_parallel_column_and_keeps_its_items() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    // The schema as it was before rag-t0013: no `parallel` column.
    let old_schema = SCHEMA_SQL.replace("    parallel        INTEGER NOT NULL DEFAULT 0,\n", "");
    assert_ne!(old_schema, SCHEMA_SQL, "the column moved: update this test");
    {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::query(&old_schema).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO projects (name, head_id, tail_id, item_seq, created_at) \
             VALUES ('old', 'old-t0001', 'old-t0001', 1, '2026-10-27T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, status, approval, created_at, \
             updated_at) VALUES ('old-t0001', 'old', 1, 'dev', 'from before', 'pending', \
             'unapproved', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('items')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(!cols.iter().any(|c| c == "parallel"));
        pool.close().await;
    }
    for pass in 0..2 {
        // Opening twice: the second open finds the column and adds nothing.
        let store = TrackerStore::open(&path, dir.path().join("att"))
            .await
            .unwrap();
        let old = store
            .get_item("old-t0001", false)
            .await
            .unwrap()
            .unwrap()
            .item;
        assert_eq!(old.title, "from before");
        assert!(!old.parallel);
        assert!(old.depends_on.is_empty());
        let order = sound(&store, "old").await;
        if pass == 1 {
            assert_eq!(order, ids(&["old-t0001", "old-t0002"]));
            assert!(item(&store, "old-t0002").await.item.parallel);
            break;
        }
        assert_eq!(order, ids(&["old-t0001"]));
        let rec = store
            .create_item(
                NewItem {
                    parallel: true,
                    ..new_item("old", "new")
                },
                &mcp(),
            )
            .await
            .unwrap();
        assert!(rec.item.parallel);
        store.pool.close().await;
    }
}

// ---- Block reason dependency (rag-t0018) ------------------------------------

fn wait_on(deps: &[&str]) -> ItemUpdate {
    ItemUpdate {
        blocked: Some(true),
        block_reason: Some(BlockReason::Dependency),
        depends_on: Some(ids(deps)),
        ..Default::default()
    }
}

async fn item(s: &TrackerStore, id: &str) -> ItemRecord {
    s.get_item(id, true).await.unwrap().unwrap()
}

#[tokio::test]
async fn a_dependency_unblocks_itself_when_its_one_dependency_is_done() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "ubu", "the spec").await;
    let b = create(s, "ubu", "build it").await;
    let rec = s.update_item(&b, wait_on(&[&a]), &mcp()).await.unwrap();
    assert!(rec.item.blocked);
    assert_eq!(rec.item.block_reason, Some(BlockReason::Dependency));
    assert_eq!(rec.item.depends_on, ids(&[&a]));
    let ev = rec.events.last().unwrap();
    assert_eq!(ev.kind, EventKind::Block);
    assert_eq!(ev.body, format!("Blocked (dependency). Waits on {a}."));
    assert_eq!(ev.fields["depends_on"], json!([a]));
    // The queue view lists it under blocked, with what it waits on.
    let view = s.queue_view("ubu").await.unwrap();
    assert_eq!(view.blocked.len(), 1);
    assert_eq!(view.blocked[0].depends_on, ids(&[&a]));
    sound(s, "ubu").await;

    // The owner finishes a; b unblocks in the same write, by the same author.
    s.update_item(&a, status(ItemStatus::InProgress, "go"), &mcp())
        .await
        .unwrap();
    sound(s, "ubu").await;
    assert!(item(s, &b).await.item.blocked);
    s.update_item(
        &a,
        ItemUpdate {
            status: Some(ItemStatus::Done),
            ..Default::default()
        },
        &web(),
    )
    .await
    .unwrap();
    let rec = item(s, &b).await;
    assert!(!rec.item.blocked);
    assert_eq!(rec.item.block_reason, None);
    assert!(rec.item.depends_on.is_empty());
    let ev = rec.events.last().unwrap();
    assert_eq!(ev.kind, EventKind::Unblock);
    assert_eq!(ev.body, format!("Unblocked: {a} is done."));
    assert_eq!(ev.author_email, "owner@example.com");
    assert_eq!(ev.surface, Surface::Web);
    assert_eq!(ev.agent, "Unknown");
    assert_eq!(ev.fields["unblocked_by"], json!(a));
    // b is back in the queue, at the place it kept.
    let view = s.queue_view("ubu").await.unwrap();
    assert!(view.blocked.is_empty());
    assert_eq!(
        view.queue.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        ids(&[&b])
    );
    // The unblock event comes after the write that caused it.
    let a_done = item(s, &a).await.events.last().unwrap().event_id;
    assert!(ev.event_id > a_done);
    sound(s, "ubu").await;
}

#[tokio::test]
async fn a_dependency_on_two_items_waits_for_both() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "ubu", "a").await;
    let b = create(s, "ubu", "b").await;
    let c = create(s, "ubu", "c").await;
    s.update_item(&c, wait_on(&[&a, &b, &a]), &mcp())
        .await
        .unwrap();
    // Duplicates are dropped, the order kept.
    assert_eq!(item(s, &c).await.item.depends_on, ids(&[&a, &b]));
    sound(s, "ubu").await;

    finish(s, &a).await;
    let rec = item(s, &c).await;
    assert!(rec.item.blocked, "one of two done must not unblock");
    assert_eq!(rec.item.depends_on, ids(&[&a, &b]));
    sound(s, "ubu").await;

    finish(s, &b).await;
    let rec = item(s, &c).await;
    assert!(!rec.item.blocked);
    assert!(rec.item.depends_on.is_empty());
    assert_eq!(
        rec.events.last().unwrap().body,
        format!("Unblocked: {b} is done, the last of {a}, {b}.")
    );
    sound(s, "ubu").await;
}

#[tokio::test]
async fn a_cancelled_or_failed_dependency_unblocks_nothing() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "ubu", "a").await;
    let b = create(s, "ubu", "b").await;
    let c = create(s, "ubu", "c").await;
    s.update_item(&c, wait_on(&[&a, &b]), &mcp()).await.unwrap();
    set_status(s, &a, ItemStatus::Cancelled).await;
    set_status(s, &b, ItemStatus::Failed).await;
    let rec = item(s, &c).await;
    assert!(rec.item.blocked);
    assert_eq!(rec.item.depends_on, ids(&[&a, &b]));
    sound(s, "ubu").await;
    // A person unblocks it by hand; that clears the list.
    let rec = s
        .update_item(
            &c,
            ItemUpdate {
                blocked: Some(false),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    assert!(!rec.item.blocked);
    assert!(rec.item.depends_on.is_empty());
    assert_eq!(rec.events.last().unwrap().fields["depends_on"], json!([]));
    sound(s, "ubu").await;
}

#[tokio::test]
async fn depends_on_is_refused_across_projects_empty_self_unknown_done_and_in_a_cycle() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "ubu", "a").await;
    let b = create(s, "ubu", "b").await;
    let other = create(s, "rag", "elsewhere").await;
    let refuse = |e: TrackerError, want: &str| {
        assert!(matches!(e, TrackerError::Refused(_)), "{e:?}");
        assert!(e.to_string().contains(want), "{e} (wanted {want:?})");
    };

    // Another project's item.
    let e = s
        .update_item(&b, wait_on(&[&other]), &mcp())
        .await
        .unwrap_err();
    refuse(e, "can only depend on items of its own project (ubu)");
    sound(s, "ubu").await;
    sound(s, "rag").await;
    // An empty list, and none at all.
    let e = s.update_item(&b, wait_on(&[]), &mcp()).await.unwrap_err();
    refuse(e, "needs depends_on");
    let e = s
        .update_item(
            &b,
            ItemUpdate {
                blocked: Some(true),
                block_reason: Some(BlockReason::Dependency),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err();
    refuse(e, "needs depends_on");
    let e = s
        .update_item(&b, wait_on(&["  ", ""]), &mcp())
        .await
        .unwrap_err();
    refuse(e, "needs depends_on");
    sound(s, "ubu").await;
    // Itself, an unknown id, and only done items.
    refuse(
        s.update_item(&b, wait_on(&[&b]), &mcp()).await.unwrap_err(),
        "cannot depend on itself",
    );
    refuse(
        s.update_item(&b, wait_on(&["ubu-t0099"]), &mcp())
            .await
            .unwrap_err(),
        "not an item",
    );
    let done = create(s, "ubu", "done already").await;
    finish(s, &done).await;
    refuse(
        s.update_item(&b, wait_on(&[&done]), &mcp())
            .await
            .unwrap_err(),
        "nothing to wait on",
    );
    // A done item beside an open one is fine.
    s.update_item(&b, wait_on(&[&done, &a]), &mcp())
        .await
        .unwrap();
    sound(s, "ubu").await;
    // A cycle: b waits on a, so a cannot wait on b.
    refuse(
        s.update_item(&a, wait_on(&[&b]), &mcp()).await.unwrap_err(),
        "cycle",
    );
    // depends_on without the reason dependency.
    let c = create(s, "ubu", "c").await;
    refuse(
        s.update_item(
            &c,
            ItemUpdate {
                depends_on: Some(ids(&[&a])),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err(),
        "depends_on goes with block_reason dependency",
    );
    refuse(
        s.update_item(
            &c,
            ItemUpdate {
                blocked: Some(true),
                block_reason: Some(BlockReason::Review),
                depends_on: Some(ids(&[&a])),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap_err(),
        "depends_on goes with block_reason dependency",
    );
    // Nothing was written by any refusal.
    for id in [&a, &c] {
        let rec = item(s, id).await;
        assert!(!rec.item.blocked, "{id}");
        assert!(rec.item.depends_on.is_empty(), "{id}");
        assert_eq!(rec.events.len(), 1, "{id}");
    }
    sound(s, "ubu").await;
}

#[tokio::test]
async fn depends_on_changes_in_place_and_clears_with_the_reason() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "ubu", "a").await;
    let b = create(s, "ubu", "b").await;
    let c = create(s, "ubu", "c").await;
    s.update_item(&c, wait_on(&[&a]), &mcp()).await.unwrap();
    // A new list alone, while blocked with dependency.
    let rec = s
        .update_item(
            &c,
            ItemUpdate {
                depends_on: Some(ids(&[&b])),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.item.depends_on, ids(&[&b]));
    let ev = rec.events.last().unwrap();
    assert_eq!(ev.kind, EventKind::Block);
    assert_eq!(ev.body, format!("Waits on {b}."));
    // a no longer frees it.
    finish(s, &a).await;
    assert!(item(s, &c).await.item.blocked);
    sound(s, "ubu").await;
    // Another reason clears the list.
    let rec = s
        .update_item(
            &c,
            ItemUpdate {
                block_reason: Some(BlockReason::Review),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.item.block_reason, Some(BlockReason::Review));
    assert!(rec.item.depends_on.is_empty());
    sound(s, "ubu").await;
    // And leaving the queue clears it.
    s.update_item(&c, wait_on(&[&b]), &mcp()).await.unwrap();
    set_status(s, &c, ItemStatus::Cancelled).await;
    let rec = item(s, &c).await;
    assert!(!rec.item.blocked);
    assert!(rec.item.depends_on.is_empty());
    // b done later finds nothing to unblock.
    finish(s, &b).await;
    assert_eq!(item(s, &c).await.item.status, ItemStatus::Cancelled);
    sound(s, "ubu").await;
}

#[tokio::test]
async fn the_integrity_check_finds_a_dependency_fault() {
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "ubu", "a").await;
    let b = create(s, "ubu", "b").await;
    // A list on an item that is not blocked with dependency.
    sqlx::query("INSERT INTO item_depends (item_id, depends_on) VALUES (?, ?)")
        .bind(&b)
        .bind(&a)
        .execute(&s.pool)
        .await
        .unwrap();
    let r = s.check("ubu").await.unwrap();
    assert!(!r.ok);
    assert!(
        r.problems
            .iter()
            .any(|p| p.contains("not blocked with reason dependency")),
        "{:?}",
        r.problems
    );
    // Blocked with dependency on nothing.
    sqlx::query("DELETE FROM item_depends")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE items SET blocked = 1, block_reason = 'dependency' WHERE id = ?")
        .bind(&b)
        .execute(&s.pool)
        .await
        .unwrap();
    let r = s.check("ubu").await.unwrap();
    assert!(
        r.problems.iter().any(|p| p.contains("depends on nothing")),
        "{:?}",
        r.problems
    );
}

// ---- Labels (rag-t0027) -------------------------------------------------------

fn labels(v: &[&str]) -> Vec<String> {
    ids(v)
}

async fn labelled(s: &TrackerStore, project: &str, title: &str, l: &[&str]) -> ItemRecord {
    s.create_item(
        NewItem {
            labels: labels(l),
            ..new_item(project, title)
        },
        &mcp(),
    )
    .await
    .unwrap()
}

fn set_labels(l: &[&str]) -> ItemUpdate {
    ItemUpdate {
        labels: Some(labels(l)),
        ..Default::default()
    }
}

#[tokio::test]
async fn labels_are_cleaned_sorted_and_recorded_on_create() {
    let f = fixture().await;
    let s = &f.store;
    let rec = labelled(
        s,
        "ubu",
        "Heat",
        &["  Physics ", "biomes", "physics", "Deep   water"],
    )
    .await;
    // Trimmed, inner whitespace collapsed, a case-insensitive duplicate merged
    // (the first kept), sorted case-insensitively.
    assert_eq!(
        rec.item.labels,
        labels(&["biomes", "Deep water", "Physics"])
    );
    let e = &rec.events[0];
    assert_eq!(
        e.fields["labels"],
        json!(["biomes", "Deep water", "Physics"])
    );
    assert_eq!(
        e.body,
        "Created dev item. Labels: biomes, Deep water, Physics."
    );
    // An unlabelled item says nothing about labels.
    let plain = s.create_item(new_item("ubu", "x"), &mcp()).await.unwrap();
    assert!(plain.item.labels.is_empty());
    assert_eq!(plain.events[0].body, "Created dev item.");
    assert_eq!(plain.events[0].fields["labels"], json!([]));
    // A read and the queue view carry them.
    let id = rec.item.id.clone();
    assert_eq!(item(s, &id).await.item.labels, rec.item.labels);
    let view = s.queue_view("ubu").await.unwrap();
    assert_eq!(view.queue[0].labels, rec.item.labels);
    assert!(view.queue[1].labels.is_empty());
}

#[tokio::test]
async fn an_existing_labels_casing_wins_within_the_project_only() {
    let f = fixture().await;
    let s = &f.store;
    labelled(s, "ubu", "a", &["Physics"]).await;
    let b = labelled(s, "ubu", "b", &["PHYSICS", "creatures"]).await;
    assert_eq!(b.item.labels, labels(&["creatures", "Physics"]));
    // Another project has its own vocabulary.
    let other = labelled(s, "rag", "c", &["physics"]).await;
    assert_eq!(other.item.labels, labels(&["physics"]));
    // An update reuses the project's casing too.
    let c = create(s, "ubu", "c").await;
    let rec = s
        .update_item(&c, set_labels(&["CREATURES"]), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.labels, labels(&["creatures"]));
    // A label another item carries keeps that item's casing, so asking b for
    // `Creatures` changes nothing (c carries `creatures`).
    let e = s
        .update_item(&b.item.id, set_labels(&["Physics", "Creatures"]), &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("nothing to update"), "{e}");
    // An item that alone carries a label may change its casing.
    let only = labelled(s, "ubu", "d", &["sky"]).await;
    let rec = s
        .update_item(&only.item.id, set_labels(&["Sky"]), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.labels, labels(&["Sky"]));
}

#[tokio::test]
async fn labels_are_set_wholesale_and_each_change_is_one_event() {
    let f = fixture().await;
    let s = &f.store;
    let id = create(s, "ubu", "x").await;
    let rec = s
        .update_item(&id, set_labels(&["Physics", "Biomes"]), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.labels, labels(&["Biomes", "Physics"]));
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Edit);
    assert_eq!(e.body, "Labels: Biomes, Physics.");
    assert_eq!(e.fields, json!({ "labels": ["Biomes", "Physics"] }));
    // The same set in another order, or with a duplicate, is not a change.
    let e = s
        .update_item(&id, set_labels(&["Physics", "Biomes", "physics"]), &mcp())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("nothing to update"), "{e}");
    // Wholesale: the new set replaces the old one.
    let rec = s
        .update_item(&id, set_labels(&["Creatures"]), &mcp())
        .await
        .unwrap();
    assert_eq!(rec.item.labels, labels(&["Creatures"]));
    // With another change, the generated body says both.
    let rec = s
        .update_item(
            &id,
            ItemUpdate {
                status: Some(ItemStatus::InProgress),
                labels: Some(labels(&["Creatures", "Biomes"])),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    let e = rec.events.last().unwrap();
    assert_eq!(e.kind, EventKind::Status);
    assert_eq!(
        e.body,
        "Status: pending → in_progress. Labels: Biomes, Creatures."
    );
    // An empty list clears them; absent leaves them alone.
    let rec = s
        .update_item(
            &id,
            ItemUpdate {
                title: Some("y".into()),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.item.labels, labels(&["Biomes", "Creatures"]));
    let rec = s.update_item(&id, set_labels(&[]), &mcp()).await.unwrap();
    assert!(rec.item.labels.is_empty());
    assert_eq!(rec.events.last().unwrap().body, "Labels: none.");
    assert_eq!(rec.events.last().unwrap().fields, json!({ "labels": [] }));
    sound(s, "ubu").await;
}

#[tokio::test]
async fn bad_labels_are_refused_and_change_nothing() {
    let f = fixture().await;
    let s = &f.store;
    let id = labelled(s, "ubu", "x", &["Physics"]).await.item.id;
    let long = "x".repeat(MAX_LABEL_CHARS + 1);
    let many: Vec<String> = (0..=MAX_LABELS).map(|n| format!("l{n}")).collect();
    let cases: Vec<(Vec<String>, &str)> = vec![
        (labels(&["  "]), "must not be blank"),
        (labels(&[""]), "must not be blank"),
        (vec![long.clone()], "longer than 32"),
        (labels(&["Physics, Biomes"]), "holds a comma"),
        (labels(&["a\u{7}b"]), "control character"),
        (many.clone(), "at most 10 labels"),
    ];
    for (given, says) in &cases {
        let e = s
            .update_item(
                &id,
                ItemUpdate {
                    labels: Some(given.clone()),
                    ..Default::default()
                },
                &mcp(),
            )
            .await
            .unwrap_err();
        assert!(matches!(e, TrackerError::Refused(_)), "{e:?}");
        assert!(e.to_string().contains(says), "{given:?}: {e}");
        let e = s
            .create_item(
                NewItem {
                    labels: given.clone(),
                    ..new_item("ubu", "y")
                },
                &mcp(),
            )
            .await
            .unwrap_err();
        assert!(e.to_string().contains(says), "{given:?}: {e}");
    }
    // Nothing changed: the item keeps its label and no item was created.
    let rec = item(s, &id).await;
    assert_eq!(rec.item.labels, labels(&["Physics"]));
    assert_eq!(rec.events.len(), 1);
    assert_eq!(s.list_items("ubu", None, None).await.unwrap().len(), 1);
    // Exactly at the limits is fine, and duplicates do not count twice.
    let at = "x".repeat(MAX_LABEL_CHARS);
    // Nine short ones, one at the length limit, and a duplicate of the first.
    let mut ten: Vec<String> = (0..MAX_LABELS - 1).map(|n| format!("l{n}")).collect();
    ten.push(at.clone());
    ten.push("L0".into());
    let rec = s
        .update_item(
            &id,
            ItemUpdate {
                labels: Some(ten),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    assert_eq!(rec.item.labels.len(), MAX_LABELS);
    assert!(rec.item.labels.contains(&at));
}

#[tokio::test]
async fn the_vocabulary_lists_each_label_once_with_its_counts() {
    let f = fixture().await;
    let s = &f.store;
    let a = labelled(s, "ubu", "a", &["Physics", "Biomes"])
        .await
        .item
        .id;
    labelled(s, "ubu", "b", &["physics"]).await;
    labelled(s, "rag", "c", &["Search"]).await;
    finish(s, &a).await;
    let v = s.project_labels("ubu").await.unwrap();
    assert_eq!(
        v,
        vec![
            LabelCount {
                label: "Biomes".into(),
                count: 1,
                queued: 0
            },
            LabelCount {
                label: "Physics".into(),
                count: 2,
                queued: 1
            },
        ]
    );
    assert_eq!(s.project_labels("rag").await.unwrap().len(), 1);
    assert!(s.project_labels("nobody").await.unwrap().is_empty());
    // A label no item carries any more is forgotten.
    s.update_item(&a, set_labels(&["Physics"]), &mcp())
        .await
        .unwrap();
    let v = s.project_labels("ubu").await.unwrap();
    assert_eq!(
        v.iter().map(|l| l.label.as_str()).collect::<Vec<_>>(),
        vec!["Physics"]
    );
}

#[tokio::test]
async fn items_list_by_label_case_insensitively() {
    let f = fixture().await;
    let s = &f.store;
    let a = labelled(s, "ubu", "a", &["Physics", "Biomes"])
        .await
        .item
        .id;
    let b = labelled(s, "ubu", "b", &["Biomes"]).await.item.id;
    labelled(s, "ubu", "c", &[]).await;
    let v = |items: Vec<Item>| items.into_iter().map(|i| i.id).collect::<Vec<_>>();
    assert_eq!(
        v(s.list_items("ubu", None, Some("biomes")).await.unwrap()),
        vec![a.clone(), b.clone()]
    );
    assert_eq!(
        v(s.list_items("ubu", None, Some(" PHYSICS ")).await.unwrap()),
        vec![a.clone()]
    );
    assert!(s
        .list_items("ubu", None, Some("Creatures"))
        .await
        .unwrap()
        .is_empty());
    // With a status filter both apply; a blank label is no filter.
    finish(s, &b).await;
    assert_eq!(
        v(s.list_items("ubu", Some(ItemStatus::Done), Some("Biomes"))
            .await
            .unwrap()),
        vec![b]
    );
    assert_eq!(
        s.list_items("ubu", None, Some("  ")).await.unwrap().len(),
        3
    );
}

#[tokio::test]
async fn an_older_database_gains_the_labels_table_and_keeps_its_items() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.db");
    // The schema as it was before rag-t0027: no `item_labels` table.
    let start = SCHEMA_SQL
        .find("-- An item's labels (rag-t0027)")
        .expect("the labels table moved: update this test");
    let end = SCHEMA_SQL[start..]
        .find("CREATE TABLE IF NOT EXISTS specs")
        .unwrap()
        + start;
    let old_schema = format!("{}{}", &SCHEMA_SQL[..start], &SCHEMA_SQL[end..]);
    assert!(!old_schema.contains("item_labels"));
    {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::query(&old_schema).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO projects (name, head_id, tail_id, item_seq, created_at) \
             VALUES ('old', 'old-t0001', 'old-t0001', 1, '2026-10-27T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, status, approval, created_at, \
             updated_at) VALUES ('old-t0001', 'old', 1, 'dev', 'from before', 'pending', \
             'unapproved', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }
    for pass in 0..2 {
        let store = TrackerStore::open(&path, dir.path().join("att"))
            .await
            .unwrap();
        let old = item(&store, "old-t0001").await;
        assert_eq!(old.item.title, "from before");
        if pass == 0 {
            assert!(old.item.labels.is_empty());
            assert!(old.events.is_empty());
            assert!(store.project_labels("old").await.unwrap().is_empty());
            store
                .update_item("old-t0001", set_labels(&["Physics"]), &mcp())
                .await
                .unwrap();
        } else {
            // The second open keeps what the first wrote.
            assert_eq!(old.item.labels, labels(&["Physics"]));
            assert_eq!(store.project_labels("old").await.unwrap().len(), 1);
        }
        assert_eq!(sound(&store, "old").await, ids(&["old-t0001"]));
        store.pool.close().await;
    }
}
