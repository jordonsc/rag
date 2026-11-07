//! The velocity report (spec:velocity m03, VL-10): the burn-down's buckets,
//! time in each state, MTTC and MTTR, over spans written straight into the
//! tables at pinned times; the read's query plans; and the timing budget on a
//! generated project (`#[ignore]`: the gate runs it in release).

use std::time::Instant;

use chrono::{DateTime, Duration, Utc};
use sqlx::SqlitePool;

use super::*;
use crate::tracker::report::{summarise, Summary, READS};

const H: i64 = 3_600;

/// A Sunday noon, so the 7-day window starts on the hour, the Sunday before,
/// and holds 168 whole hours.
const NOW: &str = "2026-11-08T12:00:00Z";

fn now() -> DateTime<Utc> {
    NOW.parse().unwrap()
}

/// Seconds from `from` to [`NOW`].
fn to_now(from: &str) -> i64 {
    (now() - from.parse::<DateTime<Utc>>().unwrap()).num_seconds()
}

/// One write of a ticket's history.
#[derive(Debug, Clone, Copy)]
enum Step {
    /// Its status became this (the first step is its create).
    Status(&'static str),
    /// Published from a draft.
    Publish,
    /// Made a draft, after its create.
    Redraft,
    Block,
    Unblock,
}
use Step::*;

/// A span as the builder keeps it.
struct Kept {
    track: &'static str,
    state: String,
    from: (String, i64),
    to: Option<(String, i64)>,
}

fn close(spans: &mut [Kept], track: &str, at: &str, event: i64) {
    let s = spans
        .iter_mut()
        .find(|s| s.track == track && s.to.is_none())
        .unwrap_or_else(|| panic!("no open {track} span to close"));
    s.to = Some((at.into(), event));
}

/// Tickets and their spans, inserted straight into the tables (as
/// `velocity_read.rs`'s `Seed` does), each ticket's row matching its open
/// spans so the span invariant holds.
struct Week {
    pool: SqlitePool,
    project: String,
    seq: i64,
    event: i64,
}

impl Week {
    async fn new(s: &TrackerStore, project: &str) -> Self {
        sqlx::query("INSERT INTO projects (name, created_at) VALUES (?, '2026-01-01T00:00:00Z')")
            .bind(project)
            .execute(&s.pool)
            .await
            .unwrap();
        Self {
            pool: s.pool.clone(),
            project: project.into(),
            seq: 0,
            event: 0,
        }
    }

    /// A ticket of type `ty` through `steps`, each at its time, oldest first;
    /// the first a `Status`, its create (a draft one when `draft`). Event ids
    /// are allotted in step order.
    async fn ticket(&mut self, ty: &str, draft: bool, steps: &[(&str, Step)]) -> String {
        self.seq += 1;
        let id = format!("{}-t{:04}", self.project, self.seq);
        let mut spans: Vec<Kept> = Vec::new();
        let (mut status, mut blocked, mut is_draft) = (String::new(), false, false);
        for (k, &(at, step)) in steps.iter().enumerate() {
            self.event += 1;
            let ev = self.event;
            let mut open = |track: &'static str, state: &str| {
                spans.push(Kept {
                    track,
                    state: state.into(),
                    from: (at.into(), ev),
                    to: None,
                })
            };
            match step {
                Status(st) if k == 0 => {
                    open("status", st);
                    if draft {
                        open("draft", "draft");
                    }
                    status = st.into();
                    is_draft = draft;
                }
                _ if k == 0 => panic!("a ticket starts with its create"),
                Status(st) => {
                    close(&mut spans, "status", at, ev);
                    spans.push(Kept {
                        track: "status",
                        state: st.into(),
                        from: (at.into(), ev),
                        to: None,
                    });
                    status = st.into();
                }
                Publish => {
                    close(&mut spans, "draft", at, ev);
                    is_draft = false;
                }
                Redraft => {
                    open("draft", "draft");
                    is_draft = true;
                }
                Block => {
                    open("blocked", "blocked");
                    blocked = true;
                }
                Unblock => {
                    close(&mut spans, "blocked", at, ev);
                    blocked = false;
                }
            }
        }
        let (created, updated) = (steps[0].0, steps[steps.len() - 1].0);
        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, status, blocked, draft, approval, \
             created_at, updated_at) VALUES (?,?,?,?,'x',?,?,?,'unapproved',?,?)",
        )
        .bind(&id)
        .bind(&self.project)
        .bind(self.seq)
        .bind(ty)
        .bind(&status)
        .bind(blocked)
        .bind(is_draft)
        .bind(created)
        .bind(updated)
        .execute(&self.pool)
        .await
        .unwrap();
        for s in spans {
            let (to_at, to_ev) = s.to.map_or((None, None), |(a, e)| (Some(a), Some(e)));
            sqlx::query(
                "INSERT INTO item_spans (project, item_id, track, state, started_at, ended_at, \
                 started_event, ended_event) VALUES (?,?,?,?,?,?,?,?)",
            )
            .bind(&self.project)
            .bind(&id)
            .bind(s.track)
            .bind(&s.state)
            .bind(&s.from.0)
            .bind(to_at)
            .bind(s.from.1)
            .bind(to_ev)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        id
    }

    /// A dev ticket, not a draft.
    async fn dev(&mut self, steps: &[(&str, Step)]) -> String {
        self.ticket("dev", false, steps).await
    }
}

async fn week_report(s: &TrackerStore, project: &str) -> Report {
    s.report(project, ReportWindow::Week, now()).await.unwrap()
}

/// The index of the bucket that starts at `at`.
fn bucket_at(r: &Report, at: &str) -> usize {
    r.buckets
        .iter()
        .position(|b| b.start == at)
        .unwrap_or_else(|| panic!("no bucket starts at {at}"))
}

fn series(r: &Report, f: fn(&Bucket) -> i64) -> Vec<i64> {
    r.buckets.iter().map(f).collect()
}

/// A series that is 1 at the buckets named and 0 elsewhere.
fn ones_at(len: usize, at: &[usize]) -> Vec<i64> {
    (0..len).map(|k| at.contains(&k) as i64).collect()
}

// ---- The burn-down ------------------------------------------------------------

#[tokio::test]
async fn a_hand_built_week_gives_the_expected_buckets_and_a_request_appears_nowhere() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // Waiting since before the window: remaining in every bucket.
    w.dev(&[("2026-10-20T00:00:00Z", Status("pending"))]).await;
    // Added Monday, started Tuesday, done Wednesday.
    w.dev(&[
        ("2026-11-02T09:00:00Z", Status("pending")),
        ("2026-11-03T10:00:00Z", Status("in_progress")),
        ("2026-11-04T15:30:00Z", Status("done")),
    ])
    .await;
    // A request, queued and done in the week: in no figure.
    w.ticket(
        "request",
        false,
        &[
            ("2026-11-03T09:00:00Z", Status("pending")),
            ("2026-11-04T09:00:00Z", Status("in_progress")),
            ("2026-11-05T09:00:00Z", Status("done")),
        ],
    )
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    assert_eq!(r.window, ReportWindow::Week);
    assert_eq!(
        (r.start.as_str(), r.end.as_str()),
        ("2026-11-01T12:00:00Z", NOW)
    );
    assert_eq!(r.buckets.len(), 168);
    assert_eq!(r.buckets[0].start, r.start);
    assert_eq!(r.buckets[167].start, "2026-11-08T11:00:00Z");

    let monday = bucket_at(&r, "2026-11-02T09:00:00Z");
    let wednesday = bucket_at(&r, "2026-11-04T15:00:00Z");
    // Remaining from Monday's 09:00 bucket until Wednesday's 15:00 one, where
    // it is done: each bucket's figure is read after everything in it.
    let want: Vec<i64> = (0..168)
        .map(|k| 1 + (k >= monday && k < wednesday) as i64)
        .collect();
    assert_eq!(series(&r, |b| b.remaining), want);
    assert_eq!(series(&r, |b| b.added), ones_at(168, &[monday]));
    assert_eq!(series(&r, |b| b.done), ones_at(168, &[wednesday]));
    // The last bucket's remaining is the widget's, and the done the window's.
    let v = s.velocity("p", now()).await.unwrap();
    assert_eq!(r.buckets[167].remaining, v.remaining);
    assert_eq!(r.velocity, v.windows.week);
    assert_eq!(r.velocity.done, 1);

    // The request's pending and in-progress spans ended in the window too, and
    // are not here.
    assert_eq!(r.states.pending.count, 1);
    assert_eq!(r.states.pending.mean_seconds, Some(25.0 * H as f64));
    assert_eq!(r.states.in_progress.count, 1);
    assert_eq!(r.states.in_progress.mean_seconds, Some(29.5 * H as f64));
    assert_eq!(r.states.pending.open, 1);
    assert_eq!(
        r.states.pending.oldest_open_seconds,
        Some(to_now("2026-10-20T00:00:00Z"))
    );
    assert_eq!((r.mttc.count, r.mttc.never_in_progress), (1, 0));
    assert_eq!(r.mttc.mean_seconds, Some(29.5 * H as f64));
    assert_eq!(r.mttr.count, 0);
}

#[tokio::test]
async fn a_ticket_made_a_draft_after_its_create_is_in_no_figure() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // Created, worked and sent to review, then made a draft: the live
    // ubu-t0680's shape.
    w.dev(&[
        ("2026-11-02T10:00:00Z", Status("pending")),
        ("2026-11-02T11:00:00Z", Status("in_progress")),
        ("2026-11-02T12:00:00Z", Status("review")),
        ("2026-11-03T00:00:00Z", Redraft),
    ])
    .await;
    // Done, then made a draft: not done for the report or the widget.
    w.dev(&[
        ("2026-11-02T10:00:00Z", Status("pending")),
        ("2026-11-02T11:00:00Z", Status("in_progress")),
        ("2026-11-02T12:00:00Z", Status("done")),
        ("2026-11-03T00:00:00Z", Redraft),
    ])
    .await;
    // Blocked, then made a draft.
    w.dev(&[
        ("2026-11-02T10:00:00Z", Status("pending")),
        ("2026-11-02T11:00:00Z", Block),
        ("2026-11-02T12:00:00Z", Unblock),
        ("2026-11-03T00:00:00Z", Redraft),
    ])
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    assert_eq!(r.buckets.len(), 168);
    assert!(r
        .buckets
        .iter()
        .all(|b| (b.remaining, b.added, b.done) == (0, 0, 0)));
    for st in [
        &r.states.pending,
        &r.states.in_progress,
        &r.states.review,
        &r.states.deferred,
        &r.states.blocked,
    ] {
        assert_eq!((st.count, st.open), (0, 0));
    }
    assert_eq!((r.mttc.count, r.mttc.never_in_progress), (0, 0));
    assert_eq!(r.mttr.count, 0);
    assert_eq!(r.velocity.done, 0);
    let v = s.velocity("p", now()).await.unwrap();
    assert_eq!(v.windows.week.done, 0);
    assert_eq!(v.remaining, 0);
}

#[tokio::test]
async fn a_stretch_as_a_draft_is_out_of_a_published_tickets_figures() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // In progress for 10 h, of which 4 h a draft, then 3 h in review, of which
    // 1 h a draft, then done: 6 h to complete and 2 h to resolve.
    w.dev(&[
        ("2026-11-02T00:00:00Z", Status("in_progress")),
        ("2026-11-02T02:00:00Z", Redraft),
        ("2026-11-02T06:00:00Z", Publish),
        ("2026-11-02T10:00:00Z", Status("review")),
        ("2026-11-02T11:00:00Z", Redraft),
        ("2026-11-02T12:00:00Z", Publish),
        ("2026-11-02T13:00:00Z", Status("done")),
    ])
    .await;
    // Pending for 8 h so far, of which 4 h a draft: 4 h open.
    w.dev(&[
        ("2026-11-08T04:00:00Z", Status("pending")),
        ("2026-11-08T05:00:00Z", Redraft),
        ("2026-11-08T09:00:00Z", Publish),
    ])
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    assert_eq!(r.states.in_progress.mean_seconds, Some(6.0 * H as f64));
    assert_eq!(r.states.review.mean_seconds, Some(2.0 * H as f64));
    assert_eq!(r.mttc.mean_seconds, Some(6.0 * H as f64));
    assert_eq!(r.mttr.mean_seconds, Some(2.0 * H as f64));
    assert_eq!(r.states.pending.open, 1);
    assert_eq!(r.states.pending.oldest_open_seconds, Some(4 * H));
    // Not remaining while a draft: the first ticket from its start to 02:00
    // and 06:00 to done, with the second's own draft hours out too.
    let at = |t: &str| r.buckets[bucket_at(&r, t)].remaining;
    assert_eq!(at("2026-11-02T01:00:00Z"), 1);
    assert_eq!(at("2026-11-02T03:00:00Z"), 0);
    assert_eq!(at("2026-11-02T07:00:00Z"), 1);
    assert_eq!(at("2026-11-08T06:00:00Z"), 0);
    assert_eq!(at("2026-11-08T10:00:00Z"), 1);
}

#[tokio::test]
async fn a_draft_published_tuesday_is_added_tuesday_and_not_counted_before() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // Drafted Monday, published Tuesday 08:00.
    w.ticket(
        "dev",
        true,
        &[
            ("2026-11-02T10:00:00Z", Status("pending")),
            ("2026-11-03T08:00:00Z", Publish),
        ],
    )
    .await;
    // Drafted Wednesday, still a draft: nowhere.
    w.ticket("dev", true, &[("2026-11-04T00:00:00Z", Status("pending"))])
        .await;
    // Drafted and done while a draft on Monday, published Tuesday 09:00:
    // added then, but its completion was a draft's, so it is never done.
    w.ticket(
        "dev",
        true,
        &[
            ("2026-11-02T12:00:00Z", Status("pending")),
            ("2026-11-02T13:00:00Z", Status("in_progress")),
            ("2026-11-02T14:00:00Z", Status("done")),
            ("2026-11-03T09:00:00Z", Publish),
        ],
    )
    .await;
    // Drafted before the window and published in it: added at its publication.
    w.ticket(
        "dev",
        true,
        &[
            ("2026-10-25T00:00:00Z", Status("pending")),
            ("2026-11-05T00:00:00Z", Publish),
        ],
    )
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    let tuesday = bucket_at(&r, "2026-11-03T08:00:00Z");
    let tuesday_9 = bucket_at(&r, "2026-11-03T09:00:00Z");
    let thursday = bucket_at(&r, "2026-11-05T00:00:00Z");
    assert_eq!(
        series(&r, |b| b.added),
        ones_at(168, &[tuesday, tuesday_9, thursday])
    );
    assert_eq!(series(&r, |b| b.done), vec![0; 168]);
    let want: Vec<i64> = (0..168)
        .map(|k| (k >= tuesday) as i64 + (k >= thursday) as i64)
        .collect();
    assert_eq!(series(&r, |b| b.remaining), want);
    assert_eq!(r.velocity.done, 0);
    assert_eq!((r.mttc.count, r.mttc.never_in_progress), (0, 0));
    // The draft-done ticket's pending and in-progress spans were a draft's
    // from end to end; the published ones' pending spans are open, counted
    // from their publication. The unpublished one is in no count.
    assert_eq!(r.states.pending.count, 0);
    assert_eq!(r.states.in_progress.count, 0);
    assert_eq!(r.states.pending.open, 2);
    assert_eq!(
        r.states.pending.oldest_open_seconds,
        Some(to_now("2026-11-03T08:00:00Z"))
    );
}

// ---- Time in each state ---------------------------------------------------------

#[test]
fn the_summary_is_the_count_mean_median_and_nearest_rank_p90() {
    let none = Summary {
        count: 0,
        mean: None,
        median: None,
        p90: None,
    };
    assert_eq!(summarise(vec![]), none);
    // One value is every figure.
    assert_eq!(
        summarise(vec![600]),
        Summary {
            count: 1,
            mean: Some(600.0),
            median: Some(600.0),
            p90: Some(600),
        }
    );
    // An even count: the median is the mean of the middle two; the 90th
    // percentile of four is the fourth (⌈3.6⌉), in any order given.
    assert_eq!(
        summarise(vec![400, 100, 300, 200]),
        Summary {
            count: 4,
            mean: Some(250.0),
            median: Some(250.0),
            p90: Some(400),
        }
    );
    // Ten: the ninth.
    let ten: Vec<i64> = (1..=10).rev().map(|k| k * 60).collect();
    assert_eq!(
        summarise(ten),
        Summary {
            count: 10,
            mean: Some(330.0),
            median: Some(330.0),
            p90: Some(540),
        }
    );
    // Three: the middle one, and the third.
    assert_eq!(
        summarise(vec![5, 1, 9]),
        Summary {
            count: 3,
            mean: Some(5.0),
            median: Some(5.0),
            p90: Some(9),
        }
    );
}

#[tokio::test]
async fn time_in_each_state_is_over_the_spans_that_ended_in_the_window() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // Pending for 1, 2, 3 and 6 hours from Monday midnight, then in progress.
    let starts = [
        "2026-11-02T01:00:00Z",
        "2026-11-02T02:00:00Z",
        "2026-11-02T03:00:00Z",
        "2026-11-02T06:00:00Z",
    ];
    for at in starts {
        w.dev(&[
            ("2026-11-02T00:00:00Z", Status("pending")),
            (at, Status("in_progress")),
        ])
        .await;
    }
    // Blocked for 5 hours on Tuesday, while pending.
    w.dev(&[
        ("2026-11-01T18:00:00Z", Status("pending")),
        ("2026-11-03T00:00:00Z", Block),
        ("2026-11-03T05:00:00Z", Unblock),
    ])
    .await;
    // Pending, in progress and done before the window: in no figure.
    w.dev(&[
        ("2026-10-01T00:00:00Z", Status("pending")),
        ("2026-10-05T00:00:00Z", Status("in_progress")),
        ("2026-10-06T00:00:00Z", Status("done")),
    ])
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    let st = &r.states;
    assert_eq!(st.pending.count, 4);
    assert_eq!(st.pending.mean_seconds, Some(3.0 * H as f64));
    assert_eq!(st.pending.median_seconds, Some(2.5 * H as f64));
    assert_eq!(st.pending.p90_seconds, Some(6 * H));
    // The blocked ticket is still pending: one open, since Sunday 18:00.
    assert_eq!(st.pending.open, 1);
    assert_eq!(
        st.pending.oldest_open_seconds,
        Some(to_now("2026-11-01T18:00:00Z"))
    );
    assert_eq!(
        (
            st.blocked.count,
            st.blocked.mean_seconds,
            st.blocked.median_seconds,
            st.blocked.p90_seconds
        ),
        (1, Some(5.0 * H as f64), Some(5.0 * H as f64), Some(5 * H))
    );
    assert_eq!((st.blocked.open, st.blocked.oldest_open_seconds), (0, None));
    // Nothing has left progress: four open, the oldest since Monday 01:00.
    assert_eq!((st.in_progress.count, st.in_progress.open), (0, 4));
    assert_eq!(st.in_progress.mean_seconds, None);
    assert_eq!(
        st.in_progress.oldest_open_seconds,
        Some(to_now("2026-11-02T01:00:00Z"))
    );
    for empty in [&st.review, &st.deferred] {
        assert_eq!(
            empty,
            &StateTime {
                count: 0,
                mean_seconds: None,
                median_seconds: None,
                p90_seconds: None,
                open: 0,
                oldest_open_seconds: None,
            }
        );
    }
}

// ---- MTTC and MTTR --------------------------------------------------------------

#[tokio::test]
async fn sent_back_twice_and_confirmed_sums_three_stretches_and_counts_three_reviews() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    w.dev(&[
        ("2026-11-02T00:00:00Z", Status("pending")),
        ("2026-11-02T01:00:00Z", Status("in_progress")),
        ("2026-11-02T02:00:00Z", Status("review")),
        ("2026-11-02T02:10:00Z", Status("in_progress")),
        ("2026-11-02T04:10:00Z", Status("review")),
        ("2026-11-02T04:30:00Z", Status("in_progress")),
        ("2026-11-02T07:30:00Z", Status("review")),
        ("2026-11-02T08:00:00Z", Status("done")),
    ])
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    // 1 h + 2 h + 3 h in progress.
    assert_eq!(
        r.mttc,
        Mttc {
            count: 1,
            mean_seconds: Some(6.0 * H as f64),
            median_seconds: Some(6.0 * H as f64),
            never_in_progress: 0,
        }
    );
    // Reviews of 10, 20 and 30 minutes: two sent back, the last confirmed.
    assert_eq!(
        r.mttr,
        Mttr {
            count: 3,
            mean_seconds: Some(1_200.0),
            median_seconds: Some(1_200.0),
            confirmed: 1,
            sent_back: 2,
        }
    );
    assert_eq!(r.states.review.count, 3);
    assert_eq!(r.states.in_progress.count, 3);
    assert_eq!(r.states.in_progress.mean_seconds, Some(2.0 * H as f64));
}

#[tokio::test]
async fn a_reopened_ticket_counts_only_its_in_progress_time_since_the_reopen() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // 5 h in progress and done before the window; reopened in it, 1 h in
    // progress and done again: 1 h.
    w.dev(&[
        ("2026-10-25T00:00:00Z", Status("pending")),
        ("2026-10-25T01:00:00Z", Status("in_progress")),
        ("2026-10-25T06:00:00Z", Status("done")),
        ("2026-11-03T00:00:00Z", Status("pending")),
        ("2026-11-03T02:00:00Z", Status("in_progress")),
        ("2026-11-03T03:00:00Z", Status("done")),
    ])
    .await;
    // Done twice in the window: counted once, by its latest completion, so
    // 30 minutes, not the 4 h before its reopen.
    w.dev(&[
        ("2026-11-02T00:00:00Z", Status("pending")),
        ("2026-11-02T01:00:00Z", Status("in_progress")),
        ("2026-11-02T05:00:00Z", Status("done")),
        ("2026-11-03T00:00:00Z", Status("pending")),
        ("2026-11-03T01:00:00Z", Status("in_progress")),
        ("2026-11-03T01:30:00Z", Status("done")),
    ])
    .await;
    // In progress, then cancelled; reopened and done straight from pending:
    // never in progress since the reopen.
    w.dev(&[
        ("2026-10-30T00:00:00Z", Status("pending")),
        ("2026-10-30T01:00:00Z", Status("in_progress")),
        ("2026-10-30T03:00:00Z", Status("cancelled")),
        ("2026-11-04T00:00:00Z", Status("pending")),
        ("2026-11-04T01:00:00Z", Status("done")),
    ])
    .await;
    assert_spans_match_rows(s).await;

    let r = week_report(s, "p").await;
    assert_eq!(
        r.mttc,
        Mttc {
            count: 2,
            mean_seconds: Some(2_700.0),
            median_seconds: Some(2_700.0),
            never_in_progress: 1,
        }
    );
    assert_eq!(r.velocity.done, 3);
    // Per bucket, the twice-done ticket is in both of its buckets.
    assert_eq!(series(&r, |b| b.done).iter().sum::<i64>(), 4);
}

#[tokio::test]
async fn a_ticket_done_straight_from_pending_is_never_in_progress() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    w.dev(&[
        ("2026-11-02T00:00:00Z", Status("pending")),
        ("2026-11-03T00:00:00Z", Status("done")),
    ])
    .await;
    let r = week_report(s, "p").await;
    assert_eq!(
        r.mttc,
        Mttc {
            count: 0,
            mean_seconds: None,
            median_seconds: None,
            never_in_progress: 1,
        }
    );
    assert_eq!(r.velocity.done, 1);
}

// ---- The shape and the window -------------------------------------------------

#[tokio::test]
async fn an_unknown_project_gets_an_empty_report_of_the_routes_shape() {
    let f = fixture().await;
    let r = week_report(&f.store, "none").await;
    let v = serde_json::to_value(&r).unwrap();
    let keys = |v: &serde_json::Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(&v),
        ["buckets", "end", "mttc", "mttr", "project", "start", "states", "velocity", "window"]
    );
    assert_eq!(v["window"], "7d");
    assert_eq!(
        keys(&v["velocity"]),
        [
            "active_seconds",
            "added",
            "adj_eta_days",
            "adj_velocity_per_day",
            "done",
            "eta_days",
            "velocity_per_day"
        ]
    );
    assert_eq!(
        keys(&v["states"]),
        ["blocked", "deferred", "in_progress", "pending", "review"]
    );
    let empty_state = json!({
        "count": 0, "mean_seconds": null, "median_seconds": null, "p90_seconds": null,
        "open": 0, "oldest_open_seconds": null
    });
    for state in ["blocked", "deferred", "in_progress", "pending", "review"] {
        assert_eq!(v["states"][state], empty_state, "{state}");
    }
    assert_eq!(
        v["mttc"],
        json!({"count": 0, "mean_seconds": null, "median_seconds": null, "never_in_progress": 0})
    );
    assert_eq!(
        v["mttr"],
        json!({
            "count": 0, "mean_seconds": null, "median_seconds": null,
            "confirmed": 0, "sent_back": 0
        })
    );
    // Zero buckets of zeros, one an hour over the window.
    assert_eq!(r.buckets.len(), 168);
    assert_eq!(
        keys(&v["buckets"][0]),
        ["added", "done", "remaining", "start"]
    );
    for (k, b) in r.buckets.iter().enumerate() {
        assert_eq!((b.remaining, b.added, b.done), (0, 0, 0));
        let at = (now() - Duration::hours(168 - k as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        assert_eq!(b.start, at);
    }
    // An invalid name is refused.
    assert!(matches!(
        f.store.report("bad name", ReportWindow::Week, now()).await,
        Err(TrackerError::Refused(_))
    ));
}

#[tokio::test]
async fn the_burn_down_is_seven_days_whatever_the_window_and_the_rest_follows_it() {
    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // Done on Tuesday: outside the 24 hours, inside the 7 days.
    w.dev(&[
        ("2026-11-03T08:00:00Z", Status("pending")),
        ("2026-11-03T09:00:00Z", Status("in_progress")),
        ("2026-11-03T10:00:00Z", Status("done")),
    ])
    .await;
    // Done an hour ago.
    w.dev(&[
        ("2026-11-08T09:00:00Z", Status("pending")),
        ("2026-11-08T10:00:00Z", Status("in_progress")),
        ("2026-11-08T11:00:00Z", Status("done")),
    ])
    .await;

    let day = s.report("p", ReportWindow::Day, now()).await.unwrap();
    let week = week_report(s, "p").await;
    assert_eq!(day.window, ReportWindow::Day);
    assert_eq!(day.start, "2026-11-07T12:00:00Z");
    assert_eq!(day.buckets, week.buckets);
    assert_eq!(day.buckets.len(), 168);
    assert_eq!(day.buckets.iter().map(|b| b.done).sum::<i64>(), 2);
    assert_eq!(day.buckets.iter().map(|b| b.added).sum::<i64>(), 2);
    // Everything else is the window's: one done, one measured.
    assert_eq!(day.velocity.done, 1);
    assert_eq!(day.mttc.count, 1);
    assert_eq!(day.states.pending.count, 1);
    assert_eq!(week.velocity.done, 2);
    assert_eq!(week.mttc.count, 2);
    assert_eq!(week.states.pending.count, 2);
}

#[tokio::test]
async fn the_window_is_24h_or_7d_and_its_buckets_fall_on_utc_hours() {
    assert_eq!("24h".parse::<ReportWindow>().unwrap(), ReportWindow::Day);
    assert_eq!("7d".parse::<ReportWindow>().unwrap(), ReportWindow::Week);
    assert_eq!(ReportWindow::default(), ReportWindow::Week);
    for bad in ["30d", "", "7D", "1h"] {
        assert!(
            matches!(bad.parse::<ReportWindow>(), Err(TrackerError::Refused(_))),
            "{bad}"
        );
    }

    let f = fixture().await;
    let s = &f.store;
    let mut w = Week::new(s, "p").await;
    // Done at exactly the moment the report is read: in the last bucket.
    let at = "2026-11-08T12:34:56Z";
    w.dev(&[
        ("2026-11-08T09:00:00Z", Status("pending")),
        ("2026-11-08T10:00:00Z", Status("in_progress")),
        (at, Status("done")),
    ])
    .await;
    let r = s
        .report("p", ReportWindow::Day, at.parse().unwrap())
        .await
        .unwrap();
    assert_eq!(r.window, ReportWindow::Day);
    assert_eq!(r.start, "2026-11-07T12:34:56Z");
    // Seven days whatever the window: a partial hour at each end and 167 whole
    // ones between.
    assert_eq!(r.buckets.len(), 169);
    assert_eq!(r.buckets[0].start, "2026-11-01T12:34:56Z");
    assert_eq!(r.buckets[1].start, "2026-11-01T13:00:00Z");
    assert_eq!(r.buckets[168].start, "2026-11-08T12:00:00Z");
    assert_eq!(r.buckets[168].done, 1);
    assert_eq!(r.buckets[168].remaining, 0);
    // Added 09:00, in progress until the end: remaining from there.
    let nine = bucket_at(&r, "2026-11-08T09:00:00Z");
    assert_eq!(r.buckets[nine].added, 1);
    assert_eq!(r.buckets[nine].remaining, 1);
    assert_eq!(r.buckets[nine - 1].remaining, 0);
    assert_eq!(r.buckets[167].remaining, 1);
    assert_eq!(r.velocity.done, 1);
    assert_eq!(r.mttc.mean_seconds, Some((2 * H + 34 * 60 + 56) as f64));
}

// ---- Plans (D30) ------------------------------------------------------------

#[tokio::test]
async fn every_statement_of_the_report_read_uses_an_index() {
    let f = fixture().await;
    let wanted: [&[&str]; 2] = [
        &["idx_item_spans_project_ended", "idx_item_spans_item"],
        &["idx_item_spans_item", "idx_item_spans_project_started"],
    ];
    assert_eq!(READS.len(), wanted.len());
    for (sql, indexes) in READS.iter().zip(wanted) {
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
        for index in indexes {
            assert!(
                plan.iter()
                    .any(|d| d.starts_with("SEARCH") && d.contains(index)),
                "{index} unused in {plan:?} for {sql}"
            );
        }
    }
}

// ---- The budget (D30) -------------------------------------------------------

/// A generated project of 6 000 tickets and 50 000 events over 60 days ending
/// at [`NOW`]: the 7-day report in under 100 ms, and the velocity read in under
/// 20 ms, in a release build. The gate runs it:
/// `cargo test --release -p rag-core -- --ignored --nocapture report_budget`,
/// and logs the times it prints in the ticket.
#[tokio::test]
#[ignore = "a timing budget: run in release with --ignored"]
async fn report_budget_on_six_thousand_tickets_and_fifty_thousand_events() {
    const TICKETS: i64 = 6_000;
    const EVENTS: i64 = 50_000;
    const DAYS: i64 = 60;
    let f = fixture().await;
    let s = &f.store;
    let pool = &s.pool;
    let ts = |t: i64| {
        DateTime::from_timestamp(t, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    };
    let end = now().timestamp();
    let first = end - DAYS * 24 * H;
    let step = DAYS * 24 * H / TICKETS;

    let built = Instant::now();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO projects (name, created_at) VALUES ('big', ?)")
        .bind(ts(first))
        .execute(&mut *tx)
        .await
        .unwrap();
    let mut events = 0i64;
    // Four status writes a ticket, and the rest of the events as notes.
    let notes = (EVENTS - 4 * TICKETS) / TICKETS;
    let extra = (EVENTS - 4 * TICKETS) % TICKETS;
    for k in 0..TICKETS {
        let id = format!("big-t{:05}", k + 1);
        let t0 = first + k * step;
        // pending 30 min, in progress 2 h, review 30 min, then done; the
        // newest few are still in progress or pending; every tenth was
        // blocked for an hour while pending.
        let times = [t0, t0 + 1_800, t0 + 1_800 + 2 * H, t0 + 3 * H];
        let states = ["pending", "in_progress", "review", "done"];
        let reached = times.iter().filter(|&&t| t <= end).count();
        let status = states[reached - 1];
        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, status, approval, created_at, \
             updated_at) VALUES (?, 'big', ?, ?, 'x', ?, 'unapproved', ?, ?)",
        )
        .bind(&id)
        .bind(k + 1)
        .bind(if k % 50 == 0 { "gate" } else { "dev" })
        .bind(status)
        .bind(ts(t0))
        .bind(ts(times[reached - 1]))
        .execute(&mut *tx)
        .await
        .unwrap();
        let mut ids = Vec::new();
        for (i, &t) in times[..reached].iter().enumerate() {
            let kind = if i == 0 { "create" } else { "status" };
            let row: (i64,) = sqlx::query_as(
                "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, \
                 surface, kind, body) VALUES ('big', 'item', ?, ?, 'dev@example.com', \
                 'Claude Test', 'mcp', ?, 'x') RETURNING event_id",
            )
            .bind(&id)
            .bind(ts(t))
            .bind(kind)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            ids.push(row.0);
            events += 1;
        }
        let n_notes = notes + (k < extra) as i64;
        for j in 0..n_notes {
            sqlx::query(
                "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, \
                 surface, kind, body) VALUES ('big', 'item', ?, ?, 'dev@example.com', \
                 'Claude Test', 'mcp', 'note', 'x')",
            )
            .bind(&id)
            .bind(ts((t0 + 1_800 + j * 600).min(end)))
            .execute(&mut *tx)
            .await
            .unwrap();
            events += 1;
        }
        for i in 0..reached {
            let (to_at, to_ev) = if i + 1 < reached {
                (Some(ts(times[i + 1])), Some(ids[i + 1]))
            } else {
                (None, None)
            };
            sqlx::query(
                "INSERT INTO item_spans (project, item_id, track, state, started_at, ended_at, \
                 started_event, ended_event) VALUES ('big', ?, 'status', ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(states[i])
            .bind(ts(times[i]))
            .bind(to_at)
            .bind(ids[i])
            .bind(to_ev)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        if k % 10 == 0 && reached > 1 {
            sqlx::query(
                "INSERT INTO item_spans (project, item_id, track, state, started_at, ended_at, \
                 started_event, ended_event) VALUES ('big', ?, 'blocked', 'blocked', ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(ts(t0))
            .bind(ts(times[1]))
            .bind(ids[0])
            .bind(ids[1])
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    // The newest tickets have not reached done: their missing writes as notes
    // on a document, an hour back, so the total is exact.
    while events < EVENTS {
        sqlx::query(
            "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, \
             surface, kind, body) VALUES ('big', 'document', 'big-d0001', ?, 'dev@example.com', \
             'Claude Test', 'mcp', 'edit', 'x')",
        )
        .bind(ts(end - H))
        .execute(&mut *tx)
        .await
        .unwrap();
        events += 1;
    }
    tx.commit().await.unwrap();
    assert_eq!(events, EVENTS);
    sqlx::query("ANALYZE").execute(pool).await.unwrap();
    println!("generated in {:?}", built.elapsed());

    // Warm, then the median of five.
    let r = s.report("big", ReportWindow::Week, now()).await.unwrap();
    assert!(r.velocity.done > 600, "{:?}", r.velocity);
    s.velocity("big", now()).await.unwrap();
    let mut report_ms = Vec::new();
    let mut velocity_ms = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        s.report("big", ReportWindow::Week, now()).await.unwrap();
        report_ms.push(t.elapsed().as_secs_f64() * 1e3);
        let t = Instant::now();
        s.velocity("big", now()).await.unwrap();
        velocity_ms.push(t.elapsed().as_secs_f64() * 1e3);
    }
    report_ms.sort_by(f64::total_cmp);
    velocity_ms.sort_by(f64::total_cmp);
    println!(
        "7-day report: median {:.1} ms of {report_ms:.1?}; velocity: median {:.1} ms of \
         {velocity_ms:.1?} ({} done in the window, {} buckets)",
        report_ms[2],
        velocity_ms[2],
        r.velocity.done,
        r.buckets.len()
    );
    let build = if cfg!(debug_assertions) {
        "a debug build: D30's budget is for release"
    } else {
        "release"
    };
    assert!(
        report_ms[2] < 100.0,
        "the 7-day report took {:.1} ms ({build})",
        report_ms[2]
    );
    assert!(
        velocity_ms[2] < 20.0,
        "the velocity read took {:.1} ms ({build})",
        velocity_ms[2]
    );
}
