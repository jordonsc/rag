//! Velocity (spec:velocity m01, VL-04 and VL-05): active time, the figures, and
//! the read's query plans.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use sqlx::SqlitePool;

use super::*;
use crate::tracker::velocity::READS;

const H: i64 = 3_600;

// ---- Active time (VL-04) ----------------------------------------------------

#[test]
fn active_time_counts_the_gaps_of_at_most_two_hours_within_the_window() {
    let now = 1_000_000_000;
    let start = now - 24 * H;
    let active = |times: &[i64]| active_seconds(times, start, now, IDLE_GAP);
    assert_eq!(IDLE_GAP, 2 * H);
    // No events: nothing.
    assert_eq!(active(&[]), 0);
    // One event 10 minutes ago: the stretch to now.
    assert_eq!(active(&[now - 600]), 600);
    // An event every hour all day: the whole window.
    let hourly: Vec<i64> = (0..24).map(|h| start + h * H).collect();
    assert_eq!(active(&hourly), 24 * H);
    // Two one-hour bursts with three hours between: the bursts only.
    let burst = |from: i64| (0..=6).map(move |m| from + m * 600);
    let bursts: Vec<i64> = burst(start + 3 * H).chain(burst(start + 7 * H)).collect();
    assert_eq!(active(&bursts), 2 * H);
    // A gap of exactly two hours counts; one second more does not.
    assert_eq!(active(&[start + 5 * H, start + 7 * H]), 2 * H);
    assert_eq!(active(&[start + 5 * H, start + 7 * H + 1]), 0);
    // An event before the window's start bounds the first gap, counted only
    // from the start: 30 minutes before and after it is 30 minutes of it...
    assert_eq!(active(&[start - 1_800, start + 1_800]), 1_800);
    // ...and an event 1 h before it makes the gap to one 1.5 h in idle, where
    // the start alone would have bounded a 1.5 h gap that counts.
    assert_eq!(active(&[start - H, start + 3 * H / 2]), 0);
    assert_eq!(active(&[start + 3 * H / 2]), 3 * H / 2);
    // An empty or inverted window has no active time.
    assert_eq!(active_seconds(&[now], now, now, IDLE_GAP), 0);
    assert_eq!(active_seconds(&[now], now, start, IDLE_GAP), 0);
}

#[test]
fn velocity_has_a_floor_of_an_hour_and_the_eta_is_unrounded() {
    assert_eq!(MIN_ACTIVE, H);
    // Three in an hour, or in twenty minutes (the floor), is 72 a day.
    assert_eq!(velocity_per_day(3, H), 72.0);
    assert_eq!(velocity_per_day(3, H / 3), 72.0);
    assert_eq!(velocity_per_day(56, 7 * 24 * H), 8.0);
    assert_eq!(velocity_per_day(0, 7 * 24 * H), 0.0);
    assert_eq!(velocity_per_day(0, 0), 0.0);
    // 51 at 8 a day is 6.375 days, unrounded (rag-t0062): the client words it.
    assert_eq!(eta_days(51, 8.0), Some(6.375));
    assert_eq!(eta_days(48, 8.0), Some(6.0));
    // One at 48 a day is half an hour.
    assert_eq!(eta_days(1, 48.0), Some(1.0 / 48.0));
    assert_eq!(eta_days(0, 0.0), Some(0.0));
    assert_eq!(eta_days(0, 8.0), Some(0.0));
    assert_eq!(eta_days(5, 0.0), None);
}

// ---- The figures (VL-05) ----------------------------------------------------

const NOW: &str = "2026-11-02T12:00:00Z";

fn now() -> DateTime<Utc> {
    NOW.parse().unwrap()
}

/// `secs` seconds before [`NOW`], as the store writes a timestamp.
fn ago(secs: i64) -> String {
    (now() - Duration::seconds(secs)).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Rows written straight into the tables, at pinned times, for the figures
/// that depend on the clock. Every ticket gets the spans its row calls for, so
/// the span invariant holds.
struct Seed {
    pool: SqlitePool,
    project: String,
    seq: i64,
}

impl Seed {
    async fn new(s: &TrackerStore, project: &str) -> Self {
        sqlx::query("INSERT INTO projects (name, created_at) VALUES (?, ?)")
            .bind(project)
            .bind(ago(30 * 24 * H))
            .execute(&s.pool)
            .await
            .unwrap();
        Self {
            pool: s.pool.clone(),
            project: project.into(),
            seq: 0,
        }
    }

    async fn span(&self, id: &str, track: &str, state: &str, from: (String, i64)) {
        sqlx::query(
            "INSERT INTO item_spans (project, item_id, track, state, started_at, started_event) \
             VALUES (?,?,?,?,?,?)",
        )
        .bind(&self.project)
        .bind(id)
        .bind(track)
        .bind(state)
        .bind(&from.0)
        .bind(from.1)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// A ticket as it is now, its open spans started 30 days ago.
    async fn ticket(&mut self, ty: &str, status: &str, blocked: bool) -> String {
        self.seq += 1;
        let id = format!("{}-t{:04}", self.project, self.seq);
        let then = ago(30 * 24 * H);
        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, status, blocked, approval, \
             created_at, updated_at) VALUES (?,?,?,?,'x',?,?,'unapproved',?,?)",
        )
        .bind(&id)
        .bind(&self.project)
        .bind(self.seq)
        .bind(ty)
        .bind(status)
        .bind(blocked)
        .bind(&then)
        .bind(&then)
        .execute(&self.pool)
        .await
        .unwrap();
        let event = self.seq * 10;
        self.span(&id, "status", status, (then.clone(), event))
            .await;
        if blocked {
            self.span(&id, "blocked", "blocked", (then, event)).await;
        }
        id
    }

    /// A dev ticket that reached done `secs` before [`NOW`].
    async fn done(&mut self, secs: i64) -> String {
        let id = self.ticket("dev", "done", false).await;
        let at = ago(secs);
        sqlx::query(
            "UPDATE item_spans SET state = 'pending', ended_at = ?, ended_event = ? \
             WHERE item_id = ?",
        )
        .bind(&at)
        .bind(self.seq * 10 + 1)
        .bind(&id)
        .execute(&self.pool)
        .await
        .unwrap();
        self.span(&id, "status", "done", (at, self.seq * 10 + 1))
            .await;
        id
    }

    /// One event of the project (on a document) at each of `secs` before [`NOW`].
    async fn events(&self, secs: impl IntoIterator<Item = i64>, draft: bool) {
        for s in secs {
            sqlx::query(
                "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, \
                 surface, kind, body, draft) VALUES (?, 'document', 'x-d0001', ?, \
                 'dev@example.com', 'Claude Test', 'mcp', 'edit', 'x', ?)",
            )
            .bind(&self.project)
            .bind(ago(s))
            .bind(draft)
            .execute(&self.pool)
            .await
            .unwrap();
        }
    }
}

#[tokio::test]
async fn the_concepts_example_reads_eight_a_day_and_seven_days() {
    // Velocity: 8 | In progress: 3 | Pending: 48 | ETA: 7 days (the concept).
    let f = fixture().await;
    let s = &f.store;
    let mut seed = Seed::new(s, "c").await;
    // 56 done over the week, one every 3 hours, the newest now.
    for k in 0..56 {
        seed.done(k * 3 * H).await;
    }
    for _ in 0..3 {
        seed.ticket("dev", "in_progress", false).await;
    }
    for _ in 0..48 {
        seed.ticket("recon", "pending", false).await;
    }
    // Active all week: an event every hour.
    seed.events((0..168).map(|k| k * H), false).await;
    let v = s.velocity("c", now()).await.unwrap();
    assert_eq!(v.now, NOW);
    assert_eq!((v.in_progress, v.in_review), (3, 0));
    assert_eq!((v.pending, v.blocked, v.deferred), (48, 0, 0));
    assert_eq!(v.remaining, 51);
    let week = &v.windows.week;
    assert_eq!(week.done, 56);
    assert_eq!(week.active_seconds, 7 * 24 * H);
    assert_eq!(week.velocity_per_day, 8.0);
    assert_eq!(week.eta_days, Some(6.375));
    // The last 24 hours: nine done (0 h to 24 h ago, both ends in), all day active.
    let day = &v.windows.day;
    assert_eq!(day.done, 9);
    assert_eq!(day.active_seconds, 24 * H);
    assert_eq!(day.velocity_per_day, 9.0);
    assert_eq!(day.eta_days, Some(51.0 / 9.0));
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn the_figures_have_the_routes_shape() {
    let f = fixture().await;
    let v = serde_json::to_value(f.store.velocity("none", now()).await.unwrap()).unwrap();
    let keys = |v: &serde_json::Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(&v),
        [
            "blocked",
            "deferred",
            "in_progress",
            "in_review",
            "now",
            "pending",
            "project",
            "remaining",
            "windows"
        ]
    );
    assert_eq!(keys(&v["windows"]), ["24h", "7d"]);
    for w in ["24h", "7d"] {
        assert_eq!(
            keys(&v["windows"][w]),
            ["active_seconds", "done", "eta_days", "velocity_per_day"]
        );
    }
    // An unknown project: zeros, and nothing remaining is an ETA of 0.
    assert_eq!(
        v,
        json!({
            "project": "none", "now": NOW, "in_progress": 0, "in_review": 0, "pending": 0,
            "blocked": 0, "deferred": 0, "remaining": 0,
            "windows": {
                "24h": {"done": 0, "active_seconds": 0, "velocity_per_day": 0.0, "eta_days": 0.0},
                "7d": {"done": 0, "active_seconds": 0, "velocity_per_day": 0.0, "eta_days": 0.0}
            }
        })
    );
    // An invalid name is refused.
    assert!(matches!(
        f.store.velocity("bad name", now()).await,
        Err(TrackerError::Refused(_))
    ));
}

#[tokio::test]
async fn a_ticket_counts_once_in_a_window_however_often_it_was_done_and_after_a_reopen() {
    // D3, R11: done twice in the window is one; done and reopened since is still one.
    let f = fixture().await;
    let s = &f.store;
    let a = create(s, "p", "a").await;
    let b = create(s, "p", "b").await;
    let c = create(s, "p", "c").await;
    finish(s, &a).await;
    set_status(s, &a, ItemStatus::Pending).await;
    finish(s, &a).await;
    finish(s, &b).await;
    set_status(s, &b, ItemStatus::Pending).await;
    // A cancelled ticket is not done.
    set_status(s, &c, ItemStatus::Cancelled).await;
    let v = s.velocity("p", Utc::now()).await.unwrap();
    assert_eq!((v.windows.week.done, v.windows.day.done), (2, 2));
    // b is pending again; a is done and c cancelled, in no count.
    assert_eq!((v.pending, v.in_progress, v.remaining), (1, 0, 1));
    // A few seconds of writes: the one-hour floor, 2 an hour is 48 a day.
    assert!(v.windows.week.active_seconds < MIN_ACTIVE);
    assert_eq!(v.windows.week.velocity_per_day, 48.0);
    assert_eq!(v.windows.week.eta_days, Some(1.0 / 48.0));
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn a_request_and_a_draft_are_in_no_count() {
    let f = fixture().await;
    let s = &f.store;
    // A request: queued, then done; never counted.
    let r = request(s, "p", "an idea").await;
    // A draft: pending while a draft, then done while one, then published.
    let d = s
        .create_item(
            NewItem {
                draft: true,
                ..new_item("p", "a draft")
            },
            &web(),
        )
        .await
        .unwrap()
        .item
        .id;
    let v = s.velocity("p", Utc::now()).await.unwrap();
    assert_eq!((v.pending, v.in_progress, v.remaining), (0, 0, 0));
    set_status(s, &r, ItemStatus::Done).await;
    finish(s, &d).await;
    s.update_item(
        &d,
        ItemUpdate {
            draft: Some(false),
            ..Default::default()
        },
        &web(),
    )
    .await
    .unwrap();
    let v = s.velocity("p", Utc::now()).await.unwrap();
    assert_eq!((v.windows.week.done, v.windows.day.done), (0, 0));
    assert_eq!(v.windows.week.velocity_per_day, 0.0);
    // Reopened published and done again, it counts: it is done now as a ticket.
    set_status(s, &d, ItemStatus::Pending).await;
    finish(s, &d).await;
    let v = s.velocity("p", Utc::now()).await.unwrap();
    assert_eq!(v.windows.week.done, 1);
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn blocked_tickets_wait_review_is_in_progress_and_deferred_is_apart() {
    let f = fixture().await;
    let s = &f.store;
    let block = |id: String| async move {
        s.update_item(
            &id,
            ItemUpdate {
                block_reason: Some(BlockReason::Redesign),
                ..Default::default()
            },
            &mcp(),
        )
        .await
        .unwrap();
    };
    // A blocked in-progress ticket is pending.
    let a = create(s, "p", "a").await;
    set_status(s, &a, ItemStatus::InProgress).await;
    block(a.clone()).await;
    // An unblocked review ticket is in progress, and in review.
    let b = create(s, "p", "b").await;
    set_status(s, &b, ItemStatus::Review).await;
    // A blocked review ticket is pending.
    let c = create(s, "p", "c").await;
    set_status(s, &c, ItemStatus::Review).await;
    block(c.clone()).await;
    // A blocked deferred ticket is in neither, nor is an unblocked one.
    let d = create(s, "p", "d").await;
    set_status(s, &d, ItemStatus::Deferred).await;
    block(d.clone()).await;
    let e = create(s, "p", "e").await;
    set_status(s, &e, ItemStatus::Deferred).await;
    // Plain pending, failed and in progress.
    create(s, "p", "f").await;
    let g = create(s, "p", "g").await;
    set_status(s, &g, ItemStatus::Failed).await;
    let h = create(s, "p", "h").await;
    set_status(s, &h, ItemStatus::InProgress).await;
    let v = s.velocity("p", Utc::now()).await.unwrap();
    assert_eq!((v.in_progress, v.in_review), (2, 1), "b and h; b in review");
    assert_eq!(
        (v.pending, v.blocked),
        (4, 2),
        "a, c, f and g; a and c blocked"
    );
    assert_eq!(v.deferred, 2);
    assert_eq!(v.remaining, 6);
    // Nothing done: no velocity, and the ETA is unknown.
    assert_eq!(v.windows.week.velocity_per_day, 0.0);
    assert_eq!(v.windows.week.eta_days, None);
    assert_eq!(v.windows.day.eta_days, None);
    assert_spans_match_rows(s).await;
}

#[tokio::test]
async fn an_idle_project_reads_its_working_rate_not_its_calendar_rate() {
    // Three done in one hour of activity five days ago: 72 a day, not 3 ÷ 7 = 0.43.
    let f = fixture().await;
    let s = &f.store;
    let mut seed = Seed::new(s, "idle").await;
    let then = 5 * 24 * H;
    for k in 0..3 {
        seed.done(then - k * 1_800).await;
    }
    seed.events([then, then - 1_800, then - 3_600], false).await;
    // The owner's draft writes are not activity.
    seed.events([then - 2 * 3_600, then - 3 * 3_600], true)
        .await;
    let v = s.velocity("idle", now()).await.unwrap();
    let week = &v.windows.week;
    assert_eq!((week.done, week.active_seconds), (3, H));
    assert_eq!(week.velocity_per_day, 72.0);
    // Nothing remaining: an ETA of 0.
    assert_eq!(v.remaining, 0);
    assert_eq!(week.eta_days, Some(0.0));
    // The last 24 hours were idle: nothing done, no velocity, and with nothing
    // remaining still an ETA of 0.
    let day = &v.windows.day;
    assert_eq!((day.done, day.active_seconds), (0, 0));
    assert_eq!(day.velocity_per_day, 0.0);
    assert_eq!(day.eta_days, Some(0.0));
    // One ticket waiting: a 72nd of a day (20 minutes) at the week's pace,
    // unknown at the day's.
    seed.ticket("dev", "pending", false).await;
    let v = s.velocity("idle", now()).await.unwrap();
    assert_eq!(v.windows.week.eta_days, Some(1.0 / 72.0));
    assert_eq!(v.windows.day.eta_days, None);
    // Spans done before the window, and events after now, are outside it.
    seed.done(8 * 24 * H).await;
    seed.events([-600], false).await;
    let v = s.velocity("idle", now()).await.unwrap();
    assert_eq!((v.windows.week.done, v.windows.week.active_seconds), (3, H));
    assert_spans_match_rows(s).await;
}

// ---- Plans (D30) ------------------------------------------------------------

#[tokio::test]
async fn every_statement_of_the_velocity_read_uses_an_index() {
    let f = fixture().await;
    let wanted = [
        "idx_items_project",
        "idx_item_spans_project_started",
        "idx_events_project_ts",
    ];
    assert_eq!(READS.len(), wanted.len());
    for (sql, index) in READS.iter().zip(wanted) {
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
                .any(|d| d.starts_with("SEARCH") && d.contains(index)),
            "{index} unused in {plan:?} for {sql}"
        );
    }
}
