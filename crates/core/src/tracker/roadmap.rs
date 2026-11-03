//! The roadmap's forward look (`spec:roadmap` D24, D25): how far out development
//! is planned, computed on request with no stored figure (R7), so the queue and
//! the phases change size and the ETAs follow.
//!
//! The rate is the velocity read's for the chosen window (`velocity.rs`); a ticket
//! is counted as it counts one (not a request, not a draft). An ETA is a duration
//! in active days, never a date, and a velocity of 0 is unknown (`null`).
//!
//! A **released, incomplete** phase's ETA is everything in the queue above and
//! including its last counted ticket. A **planned** phase's is the queue's
//! `remaining` plus the frozen tickets of it and every earlier planned phase.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::phases::{roadmap_walk, Tally};
use super::report::ReportWindow;
use super::velocity::{self, eta_days, iso};
use super::{validate_project, PhaseSize, PhaseState, TResult, TrackerStore};

/// The forward look (D24), as `GET /tracker/{project}/roadmap` answers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Roadmap {
    pub project: String,
    pub window: ReportWindow,
    /// When it was computed, RFC 3339 UTC to the second.
    pub now: String,
    /// The window's velocity, per 24 hours of active time.
    pub velocity_per_day: f64,
    pub queue: RoadmapQueue,
    /// The project's frozen tickets, drafts included.
    pub frozen: i64,
    /// The last planned phase's ETA, or the queue's with none planned.
    pub planned_out_days: Option<f64>,
    /// Released and incomplete, soonest first.
    pub released: Vec<PhaseFigures>,
    /// In roadmap order.
    pub planned: Vec<PhaseFigures>,
    /// Released and complete (D15), newest release first.
    pub complete: Vec<PhaseFigures>,
    /// Newest change first.
    pub archived: Vec<PhaseFigures>,
}

/// The queue's figures, as the velocity read has them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RoadmapQueue {
    pub remaining: i64,
    pub eta_days: Option<f64>,
}

/// One phase in the forward look. It has no body: the roadmap reads many phases.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhaseFigures {
    pub id: String,
    pub project: String,
    pub title: String,
    pub state: PhaseState,
    pub released_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub size: PhaseSize,
    /// The counted tickets its ETA covers.
    pub ahead: i64,
    pub eta_days: Option<f64>,
}

/// The project's queue head.
pub(super) const HEAD_SQL: &str = "SELECT head_id FROM projects WHERE name = ?";

/// The main list's rows. The statuses are `items::QUEUED_IN` (a test checks it).
pub(super) const QUEUE_SQL: &str = "SELECT id, next_id, type, status, draft, phase_id FROM items \
     WHERE project = ? AND frozen = 0 \
     AND status IN ('pending', 'in_progress', 'failed', 'deferred', 'review')";

/// The project's phases, without their bodies.
pub(super) const PHASES_SQL: &str = "SELECT id, project, title, state, released_at, created_at, \
     updated_at FROM phases WHERE project = ?";

/// The linked tickets of all the project's phases, grouped as a size adds them up.
pub(super) const SIZES_SQL: &str = "SELECT phase_id, status, draft, frozen, blocked, COUNT(*) \
     FROM items WHERE project = ? AND phase_id IS NOT NULL \
     GROUP BY phase_id, status, draft, frozen, blocked";

/// How many of the project's tickets are frozen.
pub(super) const FROZEN_SQL: &str = "SELECT COUNT(*) FROM items WHERE project = ? AND frozen = 1";

/// Every statement [`TrackerStore::roadmap`] runs of its own, for the plan test.
#[cfg(test)]
pub(super) const READS: &[&str] = &[
    HEAD_SQL,
    QUEUE_SQL,
    PHASES_SQL,
    SIZES_SQL,
    FROZEN_SQL,
    super::phases::ROADMAP_WALK_SQL,
];

/// Whether a queued, unfrozen ticket counts towards an ETA (D24): as the velocity
/// spec's D1 and D2 count one, and of a status that is `remaining` (D5).
fn counted(item_type: &str, status: &str, draft: bool) -> bool {
    item_type != "request"
        && !draft
        && matches!(status, "pending" | "in_progress" | "failed" | "review")
}

impl TrackerStore {
    /// The forward look for `project` over `window` at `now` (D24), in one read
    /// transaction so the velocity, the queue and the phases agree. An unknown
    /// project answers empty, not an error; an invalid project name is refused.
    pub async fn roadmap(
        &self,
        project: &str,
        window: ReportWindow,
        now: DateTime<Utc>,
    ) -> TResult<Roadmap> {
        validate_project(project)?;
        let mut tx = self.pool.begin().await?;
        let v = velocity::read(&mut tx, project, now).await?;
        let rate = match window {
            ReportWindow::Day => &v.windows.day,
            ReportWindow::Week => &v.windows.week,
        };
        let velocity_per_day = rate.velocity_per_day;

        // Released phases: what is above each one's last counted ticket.
        let head: Option<Option<String>> = sqlx::query_scalar(HEAD_SQL)
            .bind(project)
            .fetch_optional(&mut *tx)
            .await?;
        type QueueRow = (String, Option<String>, String, String, i64, Option<String>);
        let rows: Vec<QueueRow> = sqlx::query_as(QUEUE_SQL)
            .bind(project)
            .fetch_all(&mut *tx)
            .await?;
        let by_id: HashMap<&str, &QueueRow> = rows.iter().map(|r| (r.0.as_str(), r)).collect();
        let mut ahead: HashMap<&str, i64> = HashMap::new();
        let mut running = 0;
        let mut steps = 0;
        let mut cur = head.flatten();
        while let Some(id) = cur {
            let Some(&row) = by_id.get(id.as_str()) else {
                break;
            };
            // `check` reports a cycle; here it only must not hang.
            steps += 1;
            if steps > rows.len() {
                break;
            }
            if counted(&row.2, &row.3, row.4 != 0) {
                running += 1;
                if let Some(phase) = row.5.as_deref() {
                    ahead.insert(phase, running);
                }
            }
            cur = row.1.clone();
        }

        // Sizes, from one grouped read.
        type SizeRow = (String, String, i64, i64, i64, i64);
        let size_rows: Vec<SizeRow> = sqlx::query_as(SIZES_SQL)
            .bind(project)
            .fetch_all(&mut *tx)
            .await?;
        let mut tallies: HashMap<String, Tally> = HashMap::new();
        for (phase, status, draft, frozen, blocked, n) in size_rows {
            tallies.entry(phase).or_default().add(
                &status,
                draft != 0,
                frozen != 0,
                blocked != 0,
                n,
            );
        }

        let frozen: i64 = sqlx::query_scalar(FROZEN_SQL)
            .bind(project)
            .fetch_one(&mut *tx)
            .await?;
        let order = roadmap_walk(&mut tx, project).await?;

        type PhaseRow = (
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            String,
        );
        let phase_rows: Vec<PhaseRow> = sqlx::query_as(PHASES_SQL)
            .bind(project)
            .fetch_all(&mut *tx)
            .await?;
        let mut figures: HashMap<String, PhaseFigures> = HashMap::new();
        let (mut released, mut complete, mut archived) = (Vec::new(), Vec::new(), Vec::new());
        for (id, project, title, state, released_at, created_at, updated_at) in phase_rows {
            let state: PhaseState = state.parse()?;
            let size = tallies.get(&id).map(|t| t.size(state)).unwrap_or_default();
            let mut f = PhaseFigures {
                id,
                project,
                title,
                state,
                released_at,
                created_at,
                updated_at,
                size,
                ahead: 0,
                eta_days: None,
            };
            match state {
                PhaseState::Planned => {
                    figures.insert(f.id.clone(), f);
                }
                PhaseState::Archived => archived.push(f),
                PhaseState::Released if size.complete => complete.push(f),
                PhaseState::Released => {
                    f.ahead = ahead.get(f.id.as_str()).copied().unwrap_or(0);
                    if f.ahead > 0 {
                        f.eta_days = eta_days(f.ahead, velocity_per_day);
                    }
                    released.push(f);
                }
            }
        }
        tx.commit().await?;

        // By `ahead`, so the order holds with a velocity of 0.
        released.sort_by(|a, b| {
            a.ahead
                .cmp(&b.ahead)
                .then_with(|| a.released_at.cmp(&b.released_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        complete.sort_by(|a, b| {
            b.released_at
                .cmp(&a.released_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        archived.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });

        // Planned phases: the queue, then each frozen list in turn.
        let mut planned = Vec::with_capacity(order.len());
        let mut cumulative = v.remaining;
        for id in &order {
            if let Some(mut f) = figures.remove(id) {
                cumulative += f.size.frozen;
                f.ahead = cumulative;
                f.eta_days = eta_days(cumulative, velocity_per_day);
                planned.push(f);
            }
        }
        let queue = RoadmapQueue {
            remaining: v.remaining,
            eta_days: rate.eta_days,
        };
        let planned_out_days = match planned.last() {
            Some(last) => last.eta_days,
            None => queue.eta_days,
        };
        Ok(Roadmap {
            project: project.to_string(),
            window,
            now: iso(now),
            velocity_per_day,
            queue,
            frozen,
            planned_out_days,
            released,
            planned,
            complete,
            archived,
        })
    }
}
