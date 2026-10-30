//! Specs, milestones and concepts (D4): records that own a document each.
//!
//! A spec's master is at `specs/<slug>/master.md`; a milestone's document at
//! `specs/<slug>/<code>-<name>.md` (the name defaults to the title, slugified);
//! a concept's at `concepts/<slug>.md`. A record and its document are created in
//! one transaction, so a clash on any path creates nothing.

use serde::Serialize;
use serde_json::{json, Map, Value};
use sqlx::SqliteConnection;

use super::docs::{insert_document, owned_doc, Owner};
use super::{
    append_event, ensure_project, events_for, given_note, now_iso, refused, require_title, slugify,
    validate_link, validate_slug, Actor, Approval, ConceptState, DocKind, Event, EventKind, Link,
    MilestoneState, SpecState, TResult, TargetKind, TrackerError, TrackerStore, Who,
};

/// A spec (D4).
#[derive(Debug, Clone, Serialize)]
pub struct Spec {
    pub project: String,
    pub slug: String,
    pub title: String,
    pub state: SpecState,
    pub approval: Approval,
    /// The master document's id and path.
    pub doc_id: Option<String>,
    pub path: Option<String>,
    /// Its document is a draft (owner, 2026-10-30), and so, while it is, is
    /// this record: see [`super::Document::draft`].
    pub draft: bool,
    /// In order.
    pub milestones: Vec<Milestone>,
    pub created_at: String,
    pub updated_at: String,
}

/// A milestone of a spec (D4).
#[derive(Debug, Clone, Serialize)]
pub struct Milestone {
    pub project: String,
    /// The spec's slug.
    pub spec: String,
    /// `m01`, `m02`, …
    pub code: String,
    pub title: String,
    /// Its place within the spec (ascending).
    pub order: i64,
    pub state: MilestoneState,
    pub approval: Approval,
    pub doc_id: Option<String>,
    pub path: Option<String>,
    /// Its document is a draft (owner, 2026-10-30), and so, while it is, is
    /// this record: see [`super::Document::draft`].
    pub draft: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// A concept document's record (D4).
#[derive(Debug, Clone, Serialize)]
pub struct Concept {
    pub project: String,
    pub slug: String,
    pub title: String,
    pub state: ConceptState,
    pub approval: Approval,
    /// The specs, ledger topics (and anything else) it became.
    pub links: Vec<Link>,
    pub doc_id: Option<String>,
    pub path: Option<String>,
    /// Its document is a draft (owner, 2026-10-30), and so, while it is, is
    /// this record: see [`super::Document::draft`].
    pub draft: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpecRecord {
    #[serde(flatten)]
    pub spec: Spec,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MilestoneRecord {
    #[serde(flatten)]
    pub milestone: Milestone,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConceptRecord {
    #[serde(flatten)]
    pub concept: Concept,
    pub events: Vec<Event>,
}

/// Input to [`TrackerStore::create_spec`].
#[derive(Debug, Clone)]
pub struct NewSpec {
    pub project: String,
    pub slug: String,
    pub title: String,
    /// Defaults to `draft`.
    pub state: Option<SpecState>,
    pub approval: Approval,
    /// The master document's body.
    pub body: String,
    /// Created with it, in order, in the same transaction.
    pub milestones: Vec<NewMilestone>,
    /// Optional; without one the event says what was created.
    pub note: Option<String>,
    /// Created as a draft (owner, 2026-10-30): its master document, and with
    /// it every milestone created here, is a draft (see
    /// [`super::Document::draft`]). Each is published on its own.
    pub draft: bool,
}

/// A milestone to create (with a spec, or alone via [`TrackerStore::create_milestone`]).
#[derive(Debug, Clone)]
pub struct NewMilestone {
    pub code: String,
    pub title: String,
    /// The file name after `<code>-`; defaults to the title slugified.
    pub name: Option<String>,
    /// Defaults to `not_started`.
    pub state: Option<MilestoneState>,
    pub approval: Approval,
    pub body: String,
    /// The creation event's note, optional; within [`NewSpec`], a milestone
    /// without one takes the spec's.
    pub note: Option<String>,
    /// Created as a draft (owner, 2026-10-30): its document is one. Within a
    /// draft [`NewSpec`] every milestone is.
    pub draft: bool,
}

/// Input to [`TrackerStore::create_concept`].
#[derive(Debug, Clone)]
pub struct NewConcept {
    pub project: String,
    pub slug: String,
    pub title: String,
    /// Defaults to `open`.
    pub state: Option<ConceptState>,
    pub approval: Approval,
    pub body: String,
    pub links: Vec<Link>,
    pub note: Option<String>,
    /// Created as a draft (owner, 2026-10-30): its document is one, and while
    /// it is, so is the concept (see [`super::Document::draft`]).
    pub draft: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SpecUpdate {
    pub title: Option<String>,
    pub state: Option<SpecState>,
    pub approval: Option<Approval>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MilestoneUpdate {
    pub title: Option<String>,
    pub state: Option<MilestoneState>,
    pub approval: Option<Approval>,
    pub order: Option<i64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ConceptUpdate {
    pub title: Option<String>,
    pub state: Option<ConceptState>,
    pub approval: Option<Approval>,
    pub add_links: Vec<Link>,
    pub remove_links: Vec<Link>,
    pub note: Option<String>,
}

/// The changes one record update makes, gathered so it becomes one event.
struct Changes {
    fields: Map<String, Value>,
    /// What each changed field held before (rag-t0038), keyed as `fields`.
    before: Map<String, Value>,
    kinds: Vec<EventKind>,
    /// What a state or approval change says when the write carried no note
    /// (`State: draft → ready.`), in the order made.
    said: Vec<String>,
}

impl Changes {
    fn new() -> Self {
        Self {
            fields: Map::new(),
            before: Map::new(),
            kinds: Vec::new(),
            said: Vec::new(),
        }
    }

    /// A field with no prior value to record (`links_added`).
    fn set(&mut self, name: &str, value: Value, kind: EventKind) {
        self.fields.insert(name.into(), value);
        self.kinds.push(kind);
    }

    /// A field changed from `from` to `to`.
    fn change(&mut self, name: &str, from: Value, to: Value, kind: EventKind) {
        self.before.insert(name.into(), from);
        self.set(name, to, kind);
    }

    /// A state change, described from → to for the generated body.
    fn state(&mut self, from: &str, to: &str) {
        self.change("state", json!(from), json!(to), EventKind::Status);
        self.said.push(format!("State: {from} → {to}."));
    }

    /// An approval change, described from → to for the generated body.
    fn approval(&mut self, from: Approval, to: Approval) {
        self.change("approval", json!(from), json!(to), EventKind::Approve);
        self.said.push(format!("Approval: {from} → {to}."));
    }

    /// The event's kind and body, or a refusal when nothing changed and no note
    /// was given. A note is optional on every change (D7, amended 2026-10-27);
    /// without one the body is generated from the change.
    fn event(&self, note: Option<&str>, what: &str) -> TResult<(EventKind, String)> {
        let note = given_note(note);
        let kind = [
            EventKind::Status,
            EventKind::Approve,
            EventKind::Link,
            EventKind::Edit,
        ]
        .into_iter()
        .find(|k| self.kinds.contains(k));
        match (kind, note) {
            (None, None) => refused(format!(
                "nothing to update on {what}: no field changed and no note given"
            )),
            (None, Some(n)) => Ok((EventKind::Note, n)),
            (Some(k), Some(n)) => Ok((k, n)),
            (Some(k), None) => Ok((k, self.describe())),
        }
    }

    /// The generated body: each state or approval change from → to, then the
    /// other fields set (`State: draft → ready. Set title.`).
    fn describe(&self) -> String {
        let mut parts = self.said.clone();
        let rest: Vec<&str> = self
            .fields
            .keys()
            .map(String::as_str)
            .filter(|f| !matches!(*f, "state" | "approval"))
            .collect();
        if !rest.is_empty() {
            parts.push(format!("Set {}.", rest.join(", ")));
        }
        parts.join(" ")
    }
}

fn check_approval_change(from: Approval, to: Approval, what: &str) -> TResult<()> {
    if to == Approval::Ratified && from != Approval::Agent {
        return refused(format!(
            "ratified records the owner confirming an agent's approval; {what} is {from}, not agent"
        ));
    }
    Ok(())
}

/// A creation event's body: the note, or `default` (with the approval, when the
/// record is created approved). A note is optional (D7, amended 2026-10-27).
fn creation_note(approval: Approval, note: Option<&str>, default: String) -> TResult<String> {
    if approval == Approval::Ratified {
        return refused(
            "a record cannot be created ratified: ratified follows an agent's approval",
        );
    }
    Ok(given_note(note).unwrap_or_else(|| created_body(default, approval)))
}

/// `Created spec tracker.`, or `Created spec tracker (approval: owner).` when
/// the record starts approved.
pub(super) fn created_body(default: String, approval: Approval) -> String {
    if approval == Approval::Unapproved {
        return default;
    }
    let base = default.strip_suffix('.').unwrap_or(&default);
    format!("{base} (approval: {approval}).")
}

type SpecRow = (String, String, String, String, String, String, String);
type MilestoneRow = (
    String,
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    String,
);
type ConceptRow = (String, String, String, String, String, String, String);

async fn load_milestones(
    conn: &mut SqliteConnection,
    project: &str,
    spec: &str,
) -> TResult<Vec<Milestone>> {
    let rows: Vec<MilestoneRow> = sqlx::query_as(
        "SELECT project, spec_slug, code, title, ord, state, approval, created_at, updated_at FROM milestones \
         WHERE project = ? AND spec_slug = ? ORDER BY ord, code",
    )
    .bind(project)
    .bind(spec)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(milestone_from(conn, r).await?);
    }
    Ok(out)
}

async fn milestone_from(conn: &mut SqliteConnection, r: MilestoneRow) -> TResult<Milestone> {
    let (project, spec, code, title, order, state, approval, created_at, updated_at) = r;
    let doc = owned_doc(
        conn,
        &project,
        DocKind::Milestone,
        Some(&spec),
        Some(&code),
        None,
    )
    .await?;
    Ok(Milestone {
        project,
        spec,
        code,
        title,
        order,
        state: state.parse()?,
        approval: approval.parse()?,
        doc_id: doc.as_ref().map(|d| d.id.clone()),
        draft: doc.as_ref().is_some_and(|d| d.draft),
        path: doc.map(|d| d.path),
        created_at,
        updated_at,
    })
}

async fn load_milestone(
    conn: &mut SqliteConnection,
    project: &str,
    spec: &str,
    code: &str,
) -> TResult<Option<Milestone>> {
    let row: Option<MilestoneRow> = sqlx::query_as(
        "SELECT project, spec_slug, code, title, ord, state, approval, created_at, updated_at FROM milestones \
         WHERE project = ? AND spec_slug = ? AND code = ?",
    )
    .bind(project)
    .bind(spec)
    .bind(code)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(r) => Ok(Some(milestone_from(conn, r).await?)),
        None => Ok(None),
    }
}

async fn spec_from(conn: &mut SqliteConnection, r: SpecRow) -> TResult<Spec> {
    let (project, slug, title, state, approval, created_at, updated_at) = r;
    let doc = owned_doc(conn, &project, DocKind::Spec, Some(&slug), None, None).await?;
    let milestones = load_milestones(conn, &project, &slug).await?;
    Ok(Spec {
        state: state.parse()?,
        approval: approval.parse()?,
        doc_id: doc.as_ref().map(|d| d.id.clone()),
        draft: doc.as_ref().is_some_and(|d| d.draft),
        path: doc.map(|d| d.path),
        milestones,
        project,
        slug,
        title,
        created_at,
        updated_at,
    })
}

const SPEC_SELECT: &str =
    "SELECT project, slug, title, state, approval, created_at, updated_at FROM specs";

async fn load_spec(
    conn: &mut SqliteConnection,
    project: &str,
    slug: &str,
) -> TResult<Option<Spec>> {
    let row: Option<SpecRow> =
        sqlx::query_as(&format!("{SPEC_SELECT} WHERE project = ? AND slug = ?"))
            .bind(project)
            .bind(slug)
            .fetch_optional(&mut *conn)
            .await?;
    match row {
        Some(r) => Ok(Some(spec_from(conn, r).await?)),
        None => Ok(None),
    }
}

async fn concept_from(conn: &mut SqliteConnection, r: ConceptRow) -> TResult<Concept> {
    let (project, slug, title, state, approval, created_at, updated_at) = r;
    let doc = owned_doc(conn, &project, DocKind::Concept, None, None, Some(&slug)).await?;
    let links: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind, target FROM concept_links WHERE project = ? AND slug = ? ORDER BY kind, target",
    )
    .bind(&project)
    .bind(&slug)
    .fetch_all(&mut *conn)
    .await?;
    let links = links
        .into_iter()
        .map(|(kind, target)| {
            Ok(Link {
                kind: kind.parse()?,
                target,
            })
        })
        .collect::<TResult<Vec<_>>>()?;
    Ok(Concept {
        state: state.parse()?,
        approval: approval.parse()?,
        links,
        doc_id: doc.as_ref().map(|d| d.id.clone()),
        draft: doc.as_ref().is_some_and(|d| d.draft),
        path: doc.map(|d| d.path),
        project,
        slug,
        title,
        created_at,
        updated_at,
    })
}

const CONCEPT_SELECT: &str =
    "SELECT project, slug, title, state, approval, created_at, updated_at FROM concepts";

async fn load_concept(
    conn: &mut SqliteConnection,
    project: &str,
    slug: &str,
) -> TResult<Option<Concept>> {
    let row: Option<ConceptRow> =
        sqlx::query_as(&format!("{CONCEPT_SELECT} WHERE project = ? AND slug = ?"))
            .bind(project)
            .bind(slug)
            .fetch_optional(&mut *conn)
            .await?;
    match row {
        Some(r) => Ok(Some(concept_from(conn, r).await?)),
        None => Ok(None),
    }
}

/// Insert one milestone and its document, with its two `create` events.
#[allow(clippy::too_many_arguments)]
async fn insert_milestone(
    conn: &mut SqliteConnection,
    project: &str,
    spec: &str,
    m: &NewMilestone,
    order: i64,
    fallback_note: Option<&str>,
    who: &Who,
    now: &str,
) -> TResult<()> {
    validate_slug("milestone code", &m.code)?;
    let note = creation_note(
        m.approval,
        m.note.as_deref().or(fallback_note),
        format!("Created milestone {} of spec {spec}.", m.code),
    )?;
    let title = require_title(&m.title)?;
    let name = match m.name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => {
            validate_slug("milestone file name", n)?;
            n.to_string()
        }
        _ => slugify(&title),
    };
    if name.is_empty() {
        return refused(format!(
            "milestone {} needs a name: its title has no letters or digits",
            m.code
        ));
    }
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM milestones WHERE project = ? AND spec_slug = ? AND code = ?",
    )
    .bind(project)
    .bind(spec)
    .bind(&m.code)
    .fetch_optional(&mut *conn)
    .await?;
    if exists.is_some() {
        return refused(format!("spec {spec} already has a milestone {}", m.code));
    }
    let state = m.state.unwrap_or(MilestoneState::NotStarted);
    sqlx::query(
        "INSERT INTO milestones (project, spec_slug, code, title, ord, state, approval, created_at, updated_at) \
         VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(project)
    .bind(spec)
    .bind(&m.code)
    .bind(&title)
    .bind(order)
    .bind(state.as_str())
    .bind(m.approval.as_str())
    .bind(now)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    let path = format!("specs/{spec}/{}-{name}.md", m.code);
    let owner = Owner {
        kind: DocKind::Milestone,
        spec: Some(spec),
        milestone: Some(&m.code),
        concept: None,
        draft: m.draft,
    };
    insert_document(conn, project, &path, &title, &m.body, owner, who, None, now).await?;
    append_event(
        conn,
        project,
        TargetKind::Milestone,
        &format!("{spec}/{}", m.code),
        who,
        EventKind::Create,
        &note,
        &json!({ "title": title, "state": state, "approval": m.approval, "order": order, "path": path }),
        None,
        now,
    )
    .await?;
    Ok(())
}

impl TrackerStore {
    /// Create a spec, its master document and its milestones (with theirs), in
    /// one transaction.
    pub async fn create_spec(&self, new: NewSpec, actor: &Actor) -> TResult<SpecRecord> {
        let who = actor.validated()?;
        validate_slug("spec slug", &new.slug)?;
        let title = require_title(&new.title)?;
        let body = creation_note(
            new.approval,
            new.note.as_deref(),
            format!("Created spec {}.", new.slug),
        )?;
        let state = new.state.unwrap_or(SpecState::Draft);
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        ensure_project(&mut tx, &new.project, &now).await?;
        if load_spec(&mut tx, &new.project, &new.slug).await?.is_some() {
            return refused(format!(
                "project {} already has a spec {}",
                new.project, new.slug
            ));
        }
        sqlx::query(
            "INSERT INTO specs (project, slug, title, state, approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&new.project)
        .bind(&new.slug)
        .bind(&title)
        .bind(state.as_str())
        .bind(new.approval.as_str())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let path = format!("specs/{}/master.md", new.slug);
        let owner = Owner {
            kind: DocKind::Spec,
            spec: Some(&new.slug),
            milestone: None,
            concept: None,
            draft: new.draft,
        };
        insert_document(
            &mut tx,
            &new.project,
            &path,
            &title,
            &new.body,
            owner,
            &who,
            None,
            &now,
        )
        .await?;
        append_event(
            &mut tx,
            &new.project,
            TargetKind::Spec,
            &new.slug,
            &who,
            EventKind::Create,
            &body,
            &json!({ "title": title, "state": state, "approval": new.approval, "path": path,
                     "milestones": new.milestones.iter().map(|m| m.code.clone()).collect::<Vec<_>>() }),
            None,
            &now,
        )
        .await?;
        for (n, m) in new.milestones.iter().enumerate() {
            // A draft spec's milestones are drafts with it.
            let m = NewMilestone {
                draft: m.draft || new.draft,
                ..m.clone()
            };
            insert_milestone(
                &mut tx,
                &new.project,
                &new.slug,
                &m,
                n as i64 + 1,
                new.note.as_deref(),
                &who,
                &now,
            )
            .await?;
        }
        self.commit(tx).await?;
        self.get_spec(&new.project, &new.slug, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("spec vanished after create".into()))
    }

    /// A spec with its milestones (and its history unless `history` is false).
    pub async fn get_spec(
        &self,
        project: &str,
        slug: &str,
        history: bool,
    ) -> TResult<Option<SpecRecord>> {
        let mut conn = self.pool.acquire().await?;
        let Some(spec) = load_spec(&mut conn, project, slug).await? else {
            return Ok(None);
        };
        let events = if history {
            events_for(&mut conn, project, TargetKind::Spec, slug).await?
        } else {
            Vec::new()
        };
        Ok(Some(SpecRecord { spec, events }))
    }

    /// Every spec of `project`, by slug, each with its milestones.
    pub async fn list_specs(&self, project: &str) -> TResult<Vec<Spec>> {
        let mut conn = self.pool.acquire().await?;
        let rows: Vec<SpecRow> =
            sqlx::query_as(&format!("{SPEC_SELECT} WHERE project = ? ORDER BY slug"))
                .bind(project)
                .fetch_all(&mut *conn)
                .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            out.push(spec_from(&mut conn, r).await?);
        }
        Ok(out)
    }

    /// Update a spec's title, state or approval. One event; the note is
    /// optional (without one the body is generated from the change).
    pub async fn update_spec(
        &self,
        project: &str,
        slug: &str,
        upd: SpecUpdate,
        actor: &Actor,
    ) -> TResult<SpecRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let spec = load_spec(&mut tx, project, slug).await?.ok_or_else(|| {
            TrackerError::NotFound(format!("no spec {slug:?} in project {project}"))
        })?;
        let mut c = Changes::new();
        if let Some(t) = &upd.title {
            let t = require_title(t)?;
            if t != spec.title {
                c.change("title", json!(spec.title), json!(t), EventKind::Edit);
            }
        }
        if let Some(s) = upd.state.filter(|s| *s != spec.state) {
            c.state(spec.state.as_str(), s.as_str());
        }
        if let Some(a) = upd.approval.filter(|a| *a != spec.approval) {
            check_approval_change(spec.approval, a, &format!("spec {slug}"))?;
            c.approval(spec.approval, a);
        }
        let (kind, body) = c.event(upd.note.as_deref(), &format!("spec {slug}"))?;
        sqlx::query(
            "UPDATE specs SET title = COALESCE(?, title), state = COALESCE(?, state), approval = COALESCE(?, approval), \
             updated_at = ? WHERE project = ? AND slug = ?",
        )
        .bind(c.fields.get("title").and_then(Value::as_str))
        .bind(c.fields.get("state").and_then(Value::as_str))
        .bind(c.fields.get("approval").and_then(Value::as_str))
        .bind(&now)
        .bind(project)
        .bind(slug)
        .execute(&mut *tx)
        .await?;
        append_event(
            &mut tx,
            project,
            TargetKind::Spec,
            slug,
            &who,
            kind,
            &body,
            &Value::Object(c.fields),
            Some(&Value::Object(c.before)),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_spec(project, slug, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("spec vanished after update".into()))
    }

    /// Add a milestone (and its document) to an existing spec, after its last one.
    pub async fn create_milestone(
        &self,
        project: &str,
        spec: &str,
        new: NewMilestone,
        actor: &Actor,
    ) -> TResult<MilestoneRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        if load_spec(&mut tx, project, spec).await?.is_none() {
            return Err(TrackerError::NotFound(format!(
                "no spec {spec:?} in project {project}"
            )));
        }
        let order: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(ord), 0) + 1 FROM milestones WHERE project = ? AND spec_slug = ?",
        )
        .bind(project)
        .bind(spec)
        .fetch_one(&mut *tx)
        .await?;
        insert_milestone(&mut tx, project, spec, &new, order, None, &who, &now).await?;
        self.commit(tx).await?;
        self.get_milestone(project, spec, &new.code, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("milestone vanished after create".into()))
    }

    pub async fn get_milestone(
        &self,
        project: &str,
        spec: &str,
        code: &str,
        history: bool,
    ) -> TResult<Option<MilestoneRecord>> {
        let mut conn = self.pool.acquire().await?;
        let Some(milestone) = load_milestone(&mut conn, project, spec, code).await? else {
            return Ok(None);
        };
        let events = if history {
            events_for(
                &mut conn,
                project,
                TargetKind::Milestone,
                &format!("{spec}/{code}"),
            )
            .await?
        } else {
            Vec::new()
        };
        Ok(Some(MilestoneRecord { milestone, events }))
    }

    /// Update a milestone's title, state, approval or order. One event; the
    /// note is optional (without one the body is generated from the change).
    pub async fn update_milestone(
        &self,
        project: &str,
        spec: &str,
        code: &str,
        upd: MilestoneUpdate,
        actor: &Actor,
    ) -> TResult<MilestoneRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let what = format!("milestone {spec}/{code}");
        let m = load_milestone(&mut tx, project, spec, code)
            .await?
            .ok_or_else(|| TrackerError::NotFound(format!("no {what} in project {project}")))?;
        let mut c = Changes::new();
        if let Some(t) = &upd.title {
            let t = require_title(t)?;
            if t != m.title {
                c.change("title", json!(m.title), json!(t), EventKind::Edit);
            }
        }
        if let Some(o) = upd.order.filter(|o| *o != m.order) {
            c.change("order", json!(m.order), json!(o), EventKind::Edit);
        }
        if let Some(s) = upd.state.filter(|s| *s != m.state) {
            c.state(m.state.as_str(), s.as_str());
        }
        if let Some(a) = upd.approval.filter(|a| *a != m.approval) {
            check_approval_change(m.approval, a, &what)?;
            c.approval(m.approval, a);
        }
        let (kind, body) = c.event(upd.note.as_deref(), &what)?;
        sqlx::query(
            "UPDATE milestones SET title = COALESCE(?, title), ord = COALESCE(?, ord), state = COALESCE(?, state), \
             approval = COALESCE(?, approval), updated_at = ? WHERE project = ? AND spec_slug = ? AND code = ?",
        )
        .bind(c.fields.get("title").and_then(Value::as_str))
        .bind(c.fields.get("order").and_then(Value::as_i64))
        .bind(c.fields.get("state").and_then(Value::as_str))
        .bind(c.fields.get("approval").and_then(Value::as_str))
        .bind(&now)
        .bind(project)
        .bind(spec)
        .bind(code)
        .execute(&mut *tx)
        .await?;
        append_event(
            &mut tx,
            project,
            TargetKind::Milestone,
            &format!("{spec}/{code}"),
            &who,
            kind,
            &body,
            &Value::Object(c.fields),
            Some(&Value::Object(c.before)),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_milestone(project, spec, code, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("milestone vanished after update".into()))
    }

    /// Create a concept and its document at `concepts/<slug>.md`.
    pub async fn create_concept(&self, new: NewConcept, actor: &Actor) -> TResult<ConceptRecord> {
        let who = actor.validated()?;
        validate_slug("concept slug", &new.slug)?;
        let title = require_title(&new.title)?;
        let body = creation_note(
            new.approval,
            new.note.as_deref(),
            format!("Created concept {}.", new.slug),
        )?;
        let state = new.state.unwrap_or(ConceptState::Open);
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        ensure_project(&mut tx, &new.project, &now).await?;
        if load_concept(&mut tx, &new.project, &new.slug)
            .await?
            .is_some()
        {
            return refused(format!(
                "project {} already has a concept {}",
                new.project, new.slug
            ));
        }
        sqlx::query(
            "INSERT INTO concepts (project, slug, title, state, approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(&new.project)
        .bind(&new.slug)
        .bind(&title)
        .bind(state.as_str())
        .bind(new.approval.as_str())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let mut links = new.links.clone();
        for l in &mut links {
            l.target = l.target.trim().to_string();
        }
        links.sort();
        links.dedup();
        for link in &links {
            validate_link(&mut tx, &new.project, link, None).await?;
            sqlx::query("INSERT INTO concept_links (project, slug, kind, target) VALUES (?,?,?,?)")
                .bind(&new.project)
                .bind(&new.slug)
                .bind(link.kind.as_str())
                .bind(&link.target)
                .execute(&mut *tx)
                .await?;
        }
        let path = format!("concepts/{}.md", new.slug);
        let owner = Owner {
            kind: DocKind::Concept,
            spec: None,
            milestone: None,
            concept: Some(&new.slug),
            draft: new.draft,
        };
        insert_document(
            &mut tx,
            &new.project,
            &path,
            &title,
            &new.body,
            owner,
            &who,
            None,
            &now,
        )
        .await?;
        append_event(
            &mut tx,
            &new.project,
            TargetKind::Concept,
            &new.slug,
            &who,
            EventKind::Create,
            &body,
            &json!({ "title": title, "state": state, "approval": new.approval, "links": links, "path": path }),
            None,
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_concept(&new.project, &new.slug, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("concept vanished after create".into()))
    }

    pub async fn get_concept(
        &self,
        project: &str,
        slug: &str,
        history: bool,
    ) -> TResult<Option<ConceptRecord>> {
        let mut conn = self.pool.acquire().await?;
        let Some(concept) = load_concept(&mut conn, project, slug).await? else {
            return Ok(None);
        };
        let events = if history {
            events_for(&mut conn, project, TargetKind::Concept, slug).await?
        } else {
            Vec::new()
        };
        Ok(Some(ConceptRecord { concept, events }))
    }

    /// Every concept of `project`, optionally in one state, by slug.
    pub async fn list_concepts(
        &self,
        project: &str,
        state: Option<ConceptState>,
    ) -> TResult<Vec<Concept>> {
        let mut conn = self.pool.acquire().await?;
        let rows: Vec<ConceptRow> = sqlx::query_as(&format!(
            "{CONCEPT_SELECT} WHERE project = ? AND (? IS NULL OR state = ?) ORDER BY slug"
        ))
        .bind(project)
        .bind(state.map(|s| s.as_str()))
        .bind(state.map(|s| s.as_str()))
        .fetch_all(&mut *conn)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            out.push(concept_from(&mut conn, r).await?);
        }
        Ok(out)
    }

    /// Update a concept's title, state, approval or links. One event; the note
    /// is optional (without one the body is generated from the change).
    pub async fn update_concept(
        &self,
        project: &str,
        slug: &str,
        upd: ConceptUpdate,
        actor: &Actor,
    ) -> TResult<ConceptRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let what = format!("concept {slug}");
        let concept = load_concept(&mut tx, project, slug)
            .await?
            .ok_or_else(|| TrackerError::NotFound(format!("no {what} in project {project}")))?;
        let mut c = Changes::new();
        if let Some(t) = &upd.title {
            let t = require_title(t)?;
            if t != concept.title {
                c.change("title", json!(concept.title), json!(t), EventKind::Edit);
            }
        }
        if let Some(s) = upd.state.filter(|s| *s != concept.state) {
            c.state(concept.state.as_str(), s.as_str());
        }
        if let Some(a) = upd.approval.filter(|a| *a != concept.approval) {
            check_approval_change(concept.approval, a, &what)?;
            c.approval(concept.approval, a);
        }
        let mut added = Vec::new();
        for link in &upd.add_links {
            let link = Link {
                kind: link.kind,
                target: link.target.trim().to_string(),
            };
            if concept.links.contains(&link) || added.contains(&link) {
                continue;
            }
            validate_link(&mut tx, project, &link, None).await?;
            sqlx::query("INSERT INTO concept_links (project, slug, kind, target) VALUES (?,?,?,?)")
                .bind(project)
                .bind(slug)
                .bind(link.kind.as_str())
                .bind(&link.target)
                .execute(&mut *tx)
                .await?;
            added.push(link);
        }
        let mut removed = Vec::new();
        for link in &upd.remove_links {
            let link = Link {
                kind: link.kind,
                target: link.target.trim().to_string(),
            };
            if !concept.links.contains(&link) {
                return refused(format!(
                    "{what} has no {} link to {:?} to remove",
                    link.kind, link.target
                ));
            }
            sqlx::query("DELETE FROM concept_links WHERE project = ? AND slug = ? AND kind = ? AND target = ?")
                .bind(project)
                .bind(slug)
                .bind(link.kind.as_str())
                .bind(&link.target)
                .execute(&mut *tx)
                .await?;
            removed.push(link);
        }
        if !added.is_empty() {
            c.set("links_added", json!(added), EventKind::Link);
        }
        if !removed.is_empty() {
            c.set("links_removed", json!(removed), EventKind::Link);
        }
        let (kind, body) = c.event(upd.note.as_deref(), &what)?;
        sqlx::query(
            "UPDATE concepts SET title = COALESCE(?, title), state = COALESCE(?, state), \
             approval = COALESCE(?, approval), updated_at = ? WHERE project = ? AND slug = ?",
        )
        .bind(c.fields.get("title").and_then(Value::as_str))
        .bind(c.fields.get("state").and_then(Value::as_str))
        .bind(c.fields.get("approval").and_then(Value::as_str))
        .bind(&now)
        .bind(project)
        .bind(slug)
        .execute(&mut *tx)
        .await?;
        append_event(
            &mut tx,
            project,
            TargetKind::Concept,
            slug,
            &who,
            kind,
            &body,
            &Value::Object(c.fields),
            Some(&Value::Object(c.before)),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_concept(project, slug, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("concept vanished after update".into()))
    }
}
