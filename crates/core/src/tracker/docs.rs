//! Documents and their revisions (D4, D9).
//!
//! A document is markdown at a **path** within its project that keeps the shape
//! the repository used (`specs/<spec>/master.md`, `concepts/<slug>.md`), so the
//! references already written into code, `docs/` and the ledger stay readable.
//! Every edit writes a whole new revision; an edit names the revision it read
//! and is refused, never merged, when that is no longer the current one. A
//! rename leaves the old path as a redirect, and a redirected path is never
//! given to another document.

use serde::Serialize;
use serde_json::json;
use sqlx::SqliteConnection;

use super::{
    append_event, ensure_project, events_for, now_iso, refused, require_title, Actor, DocKind,
    Event, EventKind, TResult, TargetKind, TrackerError, TrackerStore, Who,
};

/// The largest document body accepted, in bytes.
pub const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

/// A document's record (without its body).
#[derive(Debug, Clone, Serialize)]
pub struct Document {
    /// `<project>-d<seq:04>`, minted by the server.
    pub id: String,
    pub project: String,
    pub path: String,
    pub kind: DocKind,
    pub title: String,
    /// The current revision: what an edit must name as its base.
    pub revision: i64,
    /// The spec it belongs to (a spec's master or a milestone's document).
    pub spec: Option<String>,
    /// The milestone code it belongs to (a milestone's document).
    pub milestone: Option<String>,
    /// The concept it belongs to (a concept's document).
    pub concept: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A document with a body, as `get` returns it.
#[derive(Debug, Clone, Serialize)]
pub struct DocumentView {
    #[serde(flatten)]
    pub document: Document,
    pub body: String,
    /// The revision `body` is from: the current one unless an older one was asked for.
    pub body_revision: i64,
    /// The path asked for, when it was an old path that redirected here.
    pub redirected_from: Option<String>,
    /// The document's history (create, edit, rename), oldest first. Empty when
    /// the caller asked for the record alone.
    pub events: Vec<Event>,
}

/// One revision's metadata (its body comes from a `get` at that revision).
#[derive(Debug, Clone, Serialize)]
pub struct Revision {
    pub revision: i64,
    pub author_email: String,
    pub agent: String,
    pub surface: super::Surface,
    pub ts: String,
    pub message: String,
    /// The body's length in bytes.
    pub size: i64,
}

/// A unified, line-based diff between two revisions.
#[derive(Debug, Clone, Serialize)]
pub struct RevisionDiff {
    pub doc_id: String,
    pub from: i64,
    pub to: i64,
    /// Unified diff text (`---`/`+++` headers, `@@` hunks, 3 lines of context).
    /// Empty when the two bodies are identical.
    pub diff: String,
}

/// Input to [`TrackerStore::create_document`] (a free-standing document).
#[derive(Debug, Clone)]
pub struct NewDocument {
    pub project: String,
    pub path: String,
    pub title: String,
    pub body: String,
    pub message: Option<String>,
}

/// One exact-text replacement: `old` must occur exactly once.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Replacement {
    pub old: String,
    pub new: String,
}

/// How an edit changes the body.
#[derive(Debug, Clone)]
pub enum Edit {
    /// Replacements applied in order, each `old` matching exactly once in the
    /// body as it stands when it is applied; all or none.
    Replace(Vec<Replacement>),
    /// A whole new body.
    Body(String),
}

/// Validate a document path: relative, `/`-separated segments of letters,
/// digits, `.`, `_` and `-` (no `.` or `..` segment), ending in `.md`.
pub fn validate_path(path: &str) -> TResult<()> {
    let ok = !path.is_empty()
        && path.len() <= 300
        && path.ends_with(".md")
        && path.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        });
    if ok {
        Ok(())
    } else {
        refused(format!(
            "invalid document path {path:?} (relative, segments of letters, digits, '.', '_', '-', ending in .md)"
        ))
    }
}

fn one_line(message: Option<&str>, default: impl FnOnce() -> String) -> String {
    match message.map(str::trim) {
        Some(m) if !m.is_empty() => m.split_whitespace().collect::<Vec<_>>().join(" "),
        _ => default(),
    }
}

fn check_body(body: &str) -> TResult<()> {
    if body.len() > MAX_DOCUMENT_BYTES {
        return refused(format!(
            "document body is {} bytes; the limit is {MAX_DOCUMENT_BYTES}",
            body.len()
        ));
    }
    Ok(())
}

/// Refuse a path that a document holds, or that a redirect holds for another
/// document (a renamed-away path is never reused, D4).
async fn check_path_free(
    conn: &mut SqliteConnection,
    project: &str,
    path: &str,
    for_doc: Option<&str>,
) -> TResult<()> {
    let taken: Option<String> =
        sqlx::query_scalar("SELECT id FROM documents WHERE project = ? AND path = ?")
            .bind(project)
            .bind(path)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(id) = taken {
        return refused(format!("path {path:?} is taken by document {id}"));
    }
    let redirect: Option<String> =
        sqlx::query_scalar("SELECT doc_id FROM redirects WHERE project = ? AND old_path = ?")
            .bind(project)
            .bind(path)
            .fetch_optional(&mut *conn)
            .await?;
    match redirect {
        Some(id) if Some(id.as_str()) != for_doc => refused(format!(
            "path {path:?} was renamed away from document {id} and redirects to it; it is never reused"
        )),
        _ => Ok(()),
    }
}

/// The owner a document is created for.
pub(super) struct Owner<'a> {
    pub kind: DocKind,
    pub spec: Option<&'a str>,
    pub milestone: Option<&'a str>,
    pub concept: Option<&'a str>,
}

/// Insert a document and its first revision, and append its `create` event.
#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_document(
    conn: &mut SqliteConnection,
    project: &str,
    path: &str,
    title: &str,
    body: &str,
    owner: Owner<'_>,
    who: &Who,
    message: Option<&str>,
    now: &str,
) -> TResult<String> {
    validate_path(path)?;
    check_body(body)?;
    let title = require_title(title)?;
    check_path_free(conn, project, path, None).await?;
    let seq: i64 = sqlx::query_scalar(
        "UPDATE projects SET doc_seq = doc_seq + 1 WHERE name = ? RETURNING doc_seq",
    )
    .bind(project)
    .fetch_one(&mut *conn)
    .await?;
    let id = format!("{project}-d{seq:04}");
    sqlx::query(
        "INSERT INTO documents (id, project, path, kind, title, revision, spec_slug, milestone_code, \
         concept_slug, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(project)
    .bind(path)
    .bind(owner.kind.as_str())
    .bind(&title)
    .bind(owner.spec)
    .bind(owner.milestone)
    .bind(owner.concept)
    .bind(now)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    let message = one_line(message, || "Created.".to_string());
    insert_revision(conn, &id, 1, body, who, &message, now).await?;
    append_event(
        conn,
        project,
        TargetKind::Document,
        &id,
        who,
        EventKind::Create,
        &message,
        &json!({ "path": path, "kind": owner.kind, "title": title, "revision": 1 }),
        None,
        now,
    )
    .await?;
    Ok(id)
}

async fn insert_revision(
    conn: &mut SqliteConnection,
    doc_id: &str,
    revision: i64,
    body: &str,
    who: &Who,
    message: &str,
    now: &str,
) -> TResult<()> {
    sqlx::query(
        "INSERT INTO revisions (doc_id, revision, body, author_email, agent, surface, ts, message) \
         VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(doc_id)
    .bind(revision)
    .bind(body)
    .bind(&who.0)
    .bind(&who.1)
    .bind(who.2.as_str())
    .bind(now)
    .bind(message)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct DocRow {
    id: String,
    project: String,
    path: String,
    kind: String,
    title: String,
    revision: i64,
    spec_slug: Option<String>,
    milestone_code: Option<String>,
    concept_slug: Option<String>,
    created_at: String,
    updated_at: String,
}

const DOC_COLS: &str = "id, project, path, kind, title, revision, spec_slug, milestone_code, \
    concept_slug, created_at, updated_at FROM documents";

impl DocRow {
    fn into_doc(self) -> TResult<Document> {
        Ok(Document {
            id: self.id,
            project: self.project,
            path: self.path,
            kind: self.kind.parse()?,
            title: self.title,
            revision: self.revision,
            spec: self.spec_slug,
            milestone: self.milestone_code,
            concept: self.concept_slug,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

pub(super) async fn load_doc(conn: &mut SqliteConnection, id: &str) -> TResult<Option<Document>> {
    sqlx::query_as::<_, DocRow>(&format!("SELECT {DOC_COLS} WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .map(DocRow::into_doc)
        .transpose()
}

/// The document owned by a record, by owner columns.
pub(super) async fn owned_doc(
    conn: &mut SqliteConnection,
    project: &str,
    kind: DocKind,
    spec: Option<&str>,
    milestone: Option<&str>,
    concept: Option<&str>,
) -> TResult<Option<Document>> {
    sqlx::query_as::<_, DocRow>(&format!(
        "SELECT {DOC_COLS} WHERE project = ? AND kind = ? AND spec_slug IS ? AND milestone_code IS ? \
         AND concept_slug IS ?"
    ))
    .bind(project)
    .bind(kind.as_str())
    .bind(spec)
    .bind(milestone)
    .bind(concept)
    .fetch_optional(&mut *conn)
    .await?
    .map(DocRow::into_doc)
    .transpose()
}

async fn must_doc(conn: &mut SqliteConnection, id: &str) -> TResult<Document> {
    load_doc(conn, id)
        .await?
        .ok_or_else(|| TrackerError::NotFound(format!("no document {id:?}")))
}

async fn body_at(conn: &mut SqliteConnection, id: &str, revision: i64) -> TResult<String> {
    sqlx::query_scalar("SELECT body FROM revisions WHERE doc_id = ? AND revision = ?")
        .bind(id)
        .bind(revision)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| TrackerError::NotFound(format!("document {id} has no revision {revision}")))
}

/// Apply replacements in order; each `old` must occur exactly once in the body
/// as it stands when it is applied.
pub fn apply_replacements(body: &str, replacements: &[Replacement]) -> TResult<String> {
    if replacements.is_empty() {
        return refused("an edit needs at least one replacement");
    }
    let mut out = body.to_string();
    for (n, r) in replacements.iter().enumerate() {
        if r.old.is_empty() {
            return refused(format!("replacement {}: old must not be empty", n + 1));
        }
        let count = out.matches(r.old.as_str()).count();
        if count != 1 {
            return refused(format!(
                "replacement {}: old text occurs {count} times (it must occur exactly once); nothing was changed",
                n + 1
            ));
        }
        out = out.replacen(r.old.as_str(), &r.new, 1);
    }
    Ok(out)
}

fn stale(doc: &Document, base: i64) -> TrackerError {
    TrackerError::Stale {
        message: format!(
            "document {} is at revision {}, not {base}: re-read it and edit against revision {}",
            doc.id, doc.revision, doc.revision
        ),
        current_revision: doc.revision,
    }
}

impl TrackerStore {
    /// Create a free-standing document (kind `doc`) at `path`.
    pub async fn create_document(&self, new: NewDocument, actor: &Actor) -> TResult<DocumentView> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        ensure_project(&mut tx, &new.project, &now).await?;
        let owner = Owner {
            kind: DocKind::Doc,
            spec: None,
            milestone: None,
            concept: None,
        };
        let id = insert_document(
            &mut tx,
            &new.project,
            &new.path,
            &new.title,
            &new.body,
            owner,
            &who,
            new.message.as_deref(),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_document(&id, None, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("document vanished after create".into()))
    }

    /// A document by id, at `revision` (the current one when `None`).
    pub async fn get_document(
        &self,
        id: &str,
        revision: Option<i64>,
        history: bool,
    ) -> TResult<Option<DocumentView>> {
        let mut conn = self.pool.acquire().await?;
        let Some(document) = load_doc(&mut conn, id).await? else {
            return Ok(None);
        };
        let body_revision = revision.unwrap_or(document.revision);
        let body = body_at(&mut conn, id, body_revision).await?;
        let events = if history {
            events_for(&mut conn, &document.project, TargetKind::Document, id).await?
        } else {
            Vec::new()
        };
        Ok(Some(DocumentView {
            document,
            body,
            body_revision,
            redirected_from: None,
            events,
        }))
    }

    /// A document by path, following a redirect left by a rename (and saying so
    /// in `redirected_from`).
    pub async fn get_document_by_path(
        &self,
        project: &str,
        path: &str,
        revision: Option<i64>,
        history: bool,
    ) -> TResult<Option<DocumentView>> {
        let mut conn = self.pool.acquire().await?;
        let direct: Option<String> =
            sqlx::query_scalar("SELECT id FROM documents WHERE project = ? AND path = ?")
                .bind(project)
                .bind(path)
                .fetch_optional(&mut *conn)
                .await?;
        let (id, redirected_from) = match direct {
            Some(id) => (id, None),
            None => {
                let redirect: Option<String> = sqlx::query_scalar(
                    "SELECT doc_id FROM redirects WHERE project = ? AND old_path = ?",
                )
                .bind(project)
                .bind(path)
                .fetch_optional(&mut *conn)
                .await?;
                match redirect {
                    Some(id) => (id, Some(path.to_string())),
                    None => return Ok(None),
                }
            }
        };
        drop(conn);
        Ok(self
            .get_document(&id, revision, history)
            .await?
            .map(|mut v| {
                v.redirected_from = redirected_from;
                v
            }))
    }

    /// The documents of `project`, by path, optionally of one kind and under a
    /// path prefix.
    pub async fn list_documents(
        &self,
        project: &str,
        kind: Option<DocKind>,
        prefix: Option<&str>,
    ) -> TResult<Vec<Document>> {
        let rows = sqlx::query_as::<_, DocRow>(&format!(
            "SELECT {DOC_COLS} WHERE project = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR substr(path, 1, length(?)) = ?) ORDER BY path"
        ))
        .bind(project)
        .bind(kind.map(|k| k.as_str()))
        .bind(kind.map(|k| k.as_str()))
        .bind(prefix)
        .bind(prefix)
        .bind(prefix)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(DocRow::into_doc).collect()
    }

    /// Edit a document against `base_revision` (D9): a new revision, or a
    /// refusal ([`TrackerError::Stale`]) when the base is not current.
    pub async fn edit_document(
        &self,
        id: &str,
        base_revision: i64,
        edit: Edit,
        message: Option<&str>,
        actor: &Actor,
    ) -> TResult<DocumentView> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let doc = must_doc(&mut tx, id).await?;
        if base_revision != doc.revision {
            return Err(stale(&doc, base_revision));
        }
        let current = body_at(&mut tx, id, doc.revision).await?;
        let body = match &edit {
            Edit::Replace(r) => apply_replacements(&current, r)?,
            Edit::Body(b) => b.clone(),
        };
        check_body(&body)?;
        if body == current {
            return refused(format!("the edit leaves document {id} unchanged"));
        }
        let message = one_line(message, || "Edited.".to_string());
        let fields = match &edit {
            Edit::Replace(r) => {
                json!({ "revision": doc.revision + 1, "base_revision": base_revision, "replacements": r.len() })
            }
            Edit::Body(_) => {
                json!({ "revision": doc.revision + 1, "base_revision": base_revision })
            }
        };
        self.write_revision(&mut tx, &doc, &body, &who, &message, fields, &now)
            .await?;
        self.commit(tx).await?;
        self.get_document(id, None, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("document vanished after edit".into()))
    }

    #[allow(clippy::too_many_arguments)]
    async fn write_revision(
        &self,
        conn: &mut SqliteConnection,
        doc: &Document,
        body: &str,
        who: &Who,
        message: &str,
        fields: serde_json::Value,
        now: &str,
    ) -> TResult<()> {
        let next = doc.revision + 1;
        insert_revision(conn, &doc.id, next, body, who, message, now).await?;
        sqlx::query("UPDATE documents SET revision = ?, updated_at = ? WHERE id = ?")
            .bind(next)
            .bind(now)
            .bind(&doc.id)
            .execute(&mut *conn)
            .await?;
        append_event(
            conn,
            &doc.project,
            TargetKind::Document,
            &doc.id,
            who,
            EventKind::Edit,
            message,
            &fields,
            Some(&json!({ "revision": doc.revision })),
            now,
        )
        .await?;
        Ok(())
    }

    /// Rename a document's path, its title, or both. The old path becomes a
    /// redirect to this document. Renaming back onto one of the document's own
    /// old paths is allowed (and drops that redirect); any other redirected path
    /// is never reused.
    pub async fn rename_document(
        &self,
        id: &str,
        new_path: Option<&str>,
        new_title: Option<&str>,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<DocumentView> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let doc = must_doc(&mut tx, id).await?;
        let mut fields = serde_json::Map::new();
        // What changed held before (rag-t0038).
        let mut before = serde_json::Map::new();
        if let Some(path) = new_path.map(str::trim).filter(|p| *p != doc.path) {
            validate_path(path)?;
            check_path_free(&mut tx, &doc.project, path, Some(id)).await?;
            sqlx::query("DELETE FROM redirects WHERE project = ? AND old_path = ?")
                .bind(&doc.project)
                .bind(path)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE documents SET path = ? WHERE id = ?")
                .bind(path)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO redirects (project, old_path, doc_id, renamed_at) VALUES (?,?,?,?)",
            )
            .bind(&doc.project)
            .bind(&doc.path)
            .bind(id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            fields.insert("path".into(), json!(path));
            fields.insert("old_path".into(), json!(doc.path));
            before.insert("path".into(), json!(doc.path));
        }
        if let Some(title) = new_title {
            let title = require_title(title)?;
            if title != doc.title {
                sqlx::query("UPDATE documents SET title = ? WHERE id = ?")
                    .bind(&title)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                fields.insert("title".into(), json!(title));
                before.insert("title".into(), json!(doc.title));
            }
        }
        if fields.is_empty() {
            return refused(format!(
                "nothing to rename on document {id}: the path and title are unchanged"
            ));
        }
        let body = one_line(note, || {
            match (fields.get("old_path"), fields.get("path")) {
                (Some(old), Some(new)) => format!(
                    "Renamed {} to {}.",
                    old.as_str().unwrap_or(""),
                    new.as_str().unwrap_or("")
                ),
                _ => "Retitled.".to_string(),
            }
        });
        sqlx::query("UPDATE documents SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        append_event(
            &mut tx,
            &doc.project,
            TargetKind::Document,
            id,
            &who,
            EventKind::Rename,
            &body,
            &serde_json::Value::Object(fields),
            Some(&serde_json::Value::Object(before)),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_document(id, None, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("document vanished after rename".into()))
    }

    /// A document's revisions, oldest first, without their bodies.
    pub async fn list_revisions(&self, id: &str) -> TResult<Vec<Revision>> {
        let mut conn = self.pool.acquire().await?;
        must_doc(&mut conn, id).await?;
        let rows: Vec<(i64, String, String, String, String, String, i64)> = sqlx::query_as(
            "SELECT revision, author_email, agent, surface, ts, message, length(CAST(body AS BLOB)) \
             FROM revisions WHERE doc_id = ? ORDER BY revision",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
        rows.into_iter()
            .map(
                |(revision, author_email, agent, surface, ts, message, size)| {
                    Ok(Revision {
                        revision,
                        author_email,
                        agent,
                        surface: surface.parse()?,
                        ts,
                        message,
                        size,
                    })
                },
            )
            .collect()
    }

    /// The unified diff from revision `from` to revision `to`. `to` defaults to
    /// the current revision and `from` to the one before `to`.
    pub async fn diff_revisions(
        &self,
        id: &str,
        from: Option<i64>,
        to: Option<i64>,
    ) -> TResult<RevisionDiff> {
        let mut conn = self.pool.acquire().await?;
        let doc = must_doc(&mut conn, id).await?;
        let to = to.unwrap_or(doc.revision);
        let from = from.unwrap_or((to - 1).max(1));
        let a = body_at(&mut conn, id, from).await?;
        let b = body_at(&mut conn, id, to).await?;
        Ok(RevisionDiff {
            doc_id: id.to_string(),
            from,
            to,
            diff: unified_diff(&a, &b, from, to),
        })
    }

    /// Write revision `revision`'s body as a new revision (D9), against
    /// `base_revision` as an edit is.
    pub async fn restore_revision(
        &self,
        id: &str,
        revision: i64,
        base_revision: i64,
        message: Option<&str>,
        actor: &Actor,
    ) -> TResult<DocumentView> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let doc = must_doc(&mut tx, id).await?;
        if base_revision != doc.revision {
            return Err(stale(&doc, base_revision));
        }
        let old = body_at(&mut tx, id, revision).await?;
        let current = body_at(&mut tx, id, doc.revision).await?;
        if old == current {
            return refused(format!("revision {revision} is the same as the current body of document {id}; nothing to restore"));
        }
        let message = one_line(message, || format!("Restored revision {revision}."));
        let fields = json!({ "revision": doc.revision + 1, "base_revision": base_revision, "restored_from": revision });
        self.write_revision(&mut tx, &doc, &old, &who, &message, fields, &now)
            .await?;
        self.commit(tx).await?;
        self.get_document(id, None, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("document vanished after restore".into()))
    }
}

/// A unified, line-based diff with 3 lines of context.
pub fn unified_diff(a: &str, b: &str, from: i64, to: i64) -> String {
    if a == b {
        return String::new();
    }
    similar::TextDiff::from_lines(a, b)
        .unified_diff()
        .context_radius(3)
        .header(&format!("revision {from}"), &format!("revision {to}"))
        .to_string()
}
