//! Velocity (`specs/velocity/master.md` D1–D10, D26): how fast a project's
//! tickets get done, measured over its **active time** so an idle project does
//! not read as slow (R3), and the ETA of what remains at that pace.
//!
//! Every figure is computed on request (D25: no counters, no rollups) from three
//! range reads: the project's items as they are now (`idx_items_project`), the
//! `done` spans started in the last 7 days (`idx_item_spans_project_started`),
//! and the `ts` of the window's events (`idx_events_project_ts`). The statements
//! are constants so a test can pin their query plans (D30).

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::Serialize;
use sqlx::SqliteConnection;

use super::{validate_project, TResult, TrackerStore};

/// The longest gap between two of a project's events that still counts as
/// working time (D6, C1): 2 hours. A longer one is idle and adds nothing.
pub const IDLE_GAP: i64 = 2 * 3_600;

/// The least active time a window's velocity is measured over (D8, C3): 1 hour,
/// so a short burst that closed a few tickets does not read as a huge rate.
pub const MIN_ACTIVE: i64 = 3_600;

const DAY: i64 = 86_400;

/// The widget's figures (D26), as `GET /tracker/{project}/velocity` answers
/// them. The counts are the items as they are now (D4); the windows are rolling
/// and end at `now` (D10).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Velocity {
    pub project: String,
    /// When the figures were computed, RFC 3339 UTC to the second.
    pub now: String,
    /// Status `in_progress` or `review`, not blocked (R5).
    pub in_progress: i64,
    /// Of `in_progress`, those in review.
    pub in_review: i64,
    /// Status `pending` or `failed`, plus every blocked ticket of status
    /// `pending`, `in_progress`, `failed` or `review` (R6, C4).
    pub pending: i64,
    /// Of `pending`, those blocked.
    pub blocked: i64,
    /// Status `deferred`, blocked or not: in neither count.
    pub deferred: i64,
    /// `in_progress + pending` (D5): the ETA's numerator.
    pub remaining: i64,
    pub windows: VelocityWindows,
}

/// The two rolling windows (D10).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VelocityWindows {
    /// The last 24 hours.
    #[serde(rename = "24h")]
    pub day: VelocityWindow,
    /// The last 7 × 24 hours.
    #[serde(rename = "7d")]
    pub week: VelocityWindow,
}

/// One window's figures.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VelocityWindow {
    /// Tickets that reached `done` in the window, each counted once however
    /// often it did, and still counted if reopened since (D3, R11).
    pub done: i64,
    /// The window's active time in seconds (D6).
    pub active_seconds: i64,
    /// `done ÷ max(active, MIN_ACTIVE)`, per 24 hours of active time (D8).
    pub velocity_per_day: f64,
    /// `ceil(remaining ÷ velocity)` days (D9): 0 with nothing remaining, `None`
    /// (unknown) with work remaining and a velocity of 0.
    pub eta_days: Option<i64>,
}

/// The active time in `[start, now]` (D6), in seconds, from the sorted Unix
/// times of a project's events. The gaps are those from `start` to the first
/// event, between each pair, and from the last to `now`; each counts when it is
/// at most `idle_gap` long, and only its part inside `[start, now]` is added.
/// No events: the one gap from `start` to `now`, counted as any other.
pub fn active_seconds(times: &[i64], start: i64, now: i64, idle_gap: i64) -> i64 {
    if now <= start {
        return 0;
    }
    let mut total = 0;
    let mut prev = start;
    for &t in times.iter().chain(std::iter::once(&now)) {
        let gap = t - prev;
        if gap <= idle_gap {
            total += (t.min(now) - prev.max(start)).max(0);
        }
        prev = t;
    }
    total
}

/// Tickets per 24 hours of active time (D8): `done ÷ max(active, MIN_ACTIVE)`,
/// and 0 with nothing done.
pub fn velocity_per_day(done: i64, active_seconds: i64) -> f64 {
    if done <= 0 {
        return 0.0;
    }
    done as f64 * DAY as f64 / active_seconds.max(MIN_ACTIVE) as f64
}

/// The ETA in days (D9): `ceil(remaining ÷ velocity)`; 0 with nothing
/// remaining; `None` (unknown) with work remaining and no velocity.
pub fn eta_days(remaining: i64, velocity_per_day: f64) -> Option<i64> {
    if remaining <= 0 {
        Some(0)
    } else if velocity_per_day > 0.0 {
        Some((remaining as f64 / velocity_per_day).ceil() as i64)
    } else {
        None
    }
}

/// The project's counted tickets as they are now, by status and block (D1, D2,
/// D4): not requests, not drafts, and only the statuses some count holds.
pub(super) const COUNTS_SQL: &str = "SELECT status, blocked, COUNT(*) FROM items \
     WHERE project = ? AND status IN ('pending', 'in_progress', 'failed', 'review', 'deferred') \
     AND type <> 'request' AND draft = 0 GROUP BY status, blocked";

/// Each ticket that reached `done` in `[?, ?]` (D3), with the latest time it
/// did: a `done` span on the `status` track started in the window, of a ticket
/// that is not a request (D1) and was not a draft at the time (D2: no `draft`
/// span open over the event that started it).
pub(super) const DONE_SQL: &str = "SELECT s.item_id, MAX(s.started_at) FROM item_spans s \
     JOIN items i ON i.id = s.item_id \
     WHERE s.project = ? AND s.started_at >= ? AND s.started_at <= ? \
     AND s.track = 'status' AND s.state = 'done' AND i.type <> 'request' \
     AND NOT EXISTS (SELECT 1 FROM item_spans d WHERE d.item_id = s.item_id \
       AND d.track = 'draft' AND d.started_event <= s.started_event \
       AND (d.ended_event IS NULL OR d.ended_event > s.started_event)) \
     GROUP BY s.item_id";

/// The times of the project's events in `[?, ?]`, oldest first (D6): every
/// target kind and surface, draft events left out.
pub(super) const ACTIVITY_SQL: &str = "SELECT ts FROM events \
     WHERE project = ? AND draft = 0 AND ts >= ? AND ts <= ? ORDER BY ts";

/// Every statement [`TrackerStore::velocity`] runs, for the plan test.
#[cfg(test)]
pub(super) const READS: &[&str] = &[COUNTS_SQL, DONE_SQL, ACTIVITY_SQL];

pub(super) fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(super) fn unix(ts: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(ts).ok().map(|d| d.timestamp())
}

/// One window's figures from its done count, its events' times and the start.
fn window(
    done: i64,
    times: &[i64],
    start: DateTime<Utc>,
    now: DateTime<Utc>,
    remaining: i64,
) -> VelocityWindow {
    let active = active_seconds(times, start.timestamp(), now.timestamp(), IDLE_GAP);
    let velocity = velocity_per_day(done, active);
    VelocityWindow {
        done,
        active_seconds: active,
        velocity_per_day: velocity,
        eta_days: eta_days(remaining, velocity),
    }
}

/// The figures at `now`, in the caller's transaction: [`TrackerStore::velocity`]
/// and the report (`report.rs`), whose window's figures are these.
pub(super) async fn read(
    conn: &mut SqliteConnection,
    project: &str,
    now: DateTime<Utc>,
) -> TResult<Velocity> {
    let (day_start, week_start) = (now - Duration::days(1), now - Duration::days(7));
    let (now_s, day_s, week_s) = (iso(now), iso(day_start), iso(week_start));

    let mut v = Velocity {
        project: project.to_string(),
        now: now_s.clone(),
        in_progress: 0,
        in_review: 0,
        pending: 0,
        blocked: 0,
        deferred: 0,
        remaining: 0,
        windows: VelocityWindows {
            day: window(0, &[], day_start, now, 0),
            week: window(0, &[], week_start, now, 0),
        },
    };
    let counts: Vec<(String, i64, i64)> = sqlx::query_as(COUNTS_SQL)
        .bind(project)
        .fetch_all(&mut *conn)
        .await?;
    for (status, blocked, n) in counts {
        match (status.as_str(), blocked != 0) {
            ("deferred", _) => v.deferred += n,
            (_, true) => {
                v.pending += n;
                v.blocked += n;
            }
            ("in_progress", false) => v.in_progress += n,
            ("review", false) => {
                v.in_progress += n;
                v.in_review += n;
            }
            _ => v.pending += n,
        }
    }
    v.remaining = v.in_progress + v.pending;

    let done: Vec<(String, String)> = sqlx::query_as(DONE_SQL)
        .bind(project)
        .bind(&week_s)
        .bind(&now_s)
        .fetch_all(&mut *conn)
        .await?;
    let done_week = done.len() as i64;
    let done_day = done.iter().filter(|(_, at)| *at >= day_s).count() as i64;

    let events: Vec<String> = sqlx::query_scalar(ACTIVITY_SQL)
        .bind(project)
        .bind(&week_s)
        .bind(&now_s)
        .fetch_all(&mut *conn)
        .await?;
    let week_times: Vec<i64> = events.iter().filter_map(|ts| unix(ts)).collect();
    // The window's own events only: its start counts as the end of its first
    // gap (D6), whatever came before it.
    let day_times: Vec<i64> = week_times
        .iter()
        .copied()
        .filter(|t| *t >= day_start.timestamp())
        .collect();

    v.windows = VelocityWindows {
        day: window(done_day, &day_times, day_start, now, v.remaining),
        week: window(done_week, &week_times, week_start, now, v.remaining),
    };
    Ok(v)
}

impl TrackerStore {
    /// The velocity figures for `project` at `now` (D26). An unknown project
    /// answers zeros (with an ETA of 0: nothing remains), not an error; an
    /// invalid project name is refused. `now` is a parameter so a test can pin
    /// time; the route passes the clock. Read-only, in one read transaction so
    /// the counts and the windows agree.
    pub async fn velocity(&self, project: &str, now: DateTime<Utc>) -> TResult<Velocity> {
        validate_project(project)?;
        let mut tx = self.pool.begin().await?;
        let v = read(&mut tx, project, now).await?;
        tx.commit().await?;
        Ok(v)
    }
}
