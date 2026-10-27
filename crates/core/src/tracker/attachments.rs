//! Attachments (D8, R14): files stored by content hash under `attachments_dir`
//! (`<sha256[0..2]>/<sha256>`), one row per upload. A document refers to one as
//! `att:<first 12 hex characters of its sha256>`.
//!
//! The bytes are stored once however often they are uploaded; each upload keeps
//! its own row (project, name, media type, uploader), so the same image attached
//! in two projects is one file and two records. Nothing is ever deleted here: an
//! attachment no document references may still be referenced by a revision.

use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{ensure_project, now_iso, refused, Actor, TResult, TrackerError, TrackerStore};

/// The largest attachment accepted: 50 MB (D8).
pub const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;

/// How many hex characters of the hash an `att:` reference carries.
pub const REFERENCE_LEN: usize = 12;

/// One upload's record.
#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: i64,
    pub project: String,
    /// The full sha256 of the bytes, lowercase hex.
    pub sha256: String,
    /// The markdown reference: `att:<sha256[0..12]>`.
    #[serde(rename = "ref")]
    pub reference: String,
    /// The original file name.
    pub name: String,
    pub media_type: String,
    pub size: i64,
    pub author_email: String,
    pub agent: String,
    pub surface: super::Surface,
    pub uploaded_at: String,
}

/// Input to [`TrackerStore::store_attachment`].
#[derive(Debug, Clone)]
pub struct NewAttachment {
    pub project: String,
    pub name: String,
    /// The media type the uploader declared. `None` (or blank) sniffs an image
    /// type from the bytes, else `application/octet-stream`.
    pub media_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// An attachment found by hash: its first upload's record and where its bytes are.
#[derive(Debug, Clone)]
pub struct AttachmentContent {
    pub attachment: Attachment,
    pub path: PathBuf,
}

/// The image type the bytes' magic number says, if any.
pub fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        Some("image/avif")
    } else if bytes.starts_with(b"BM") && bytes.len() >= 14 {
        Some("image/bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if looks_like_svg(bytes) {
        Some("image/svg+xml")
    } else {
        None
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let Ok(text) =
        std::str::from_utf8(head).or_else(|e| std::str::from_utf8(&head[..e.valid_up_to()]))
    else {
        return false;
    };
    let t = text.trim_start_matches('\u{feff}').trim_start();
    (t.starts_with("<?xml")
        || t.starts_with("<svg")
        || t.starts_with("<!--")
        || t.starts_with("<!DOCTYPE svg"))
        && t.contains("<svg")
}

/// Normalise and check a declared media type against the bytes.
fn resolve_media_type(declared: Option<&str>, bytes: &[u8]) -> TResult<String> {
    let declared = declared
        .map(|m| {
            m.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|m| !m.is_empty());
    let sniffed = sniff_image_type(bytes);
    let Some(mut declared) = declared else {
        return Ok(sniffed.unwrap_or("application/octet-stream").to_string());
    };
    let valid = declared.split_once('/').is_some_and(|(t, s)| {
        !t.is_empty()
            && !s.is_empty()
            && declared
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '+' | '-' | '_'))
    }) && declared.matches('/').count() == 1;
    if !valid {
        return refused(format!("invalid media type {declared:?}"));
    }
    if declared == "image/jpg" || declared == "image/pjpeg" {
        declared = "image/jpeg".into();
    }
    if declared == "image/vnd.microsoft.icon" {
        declared = "image/x-icon".into();
    }
    if declared.starts_with("image/") {
        match sniffed {
            Some(s) if s == declared => {}
            Some(s) => {
                return refused(format!("the upload says {declared} but its content is {s}"))
            }
            None => {
                return refused(format!(
                    "the upload says {declared} but its content is not a recognised image \
                     (png, jpeg, gif, webp, avif, bmp, tiff, ico, svg)"
                ))
            }
        }
    }
    Ok(declared)
}

/// A file name as stored: the last path segment, trimmed, at most 200 characters.
fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let base: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    if base.is_empty() {
        "attachment".to_string()
    } else {
        base
    }
}

type AttachmentRow = (
    i64,
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

const ATT_SELECT: &str =
    "SELECT id, project, sha256, name, media_type, size, author_email, agent, surface, \
    uploaded_at FROM attachments";

fn from_row(r: AttachmentRow) -> TResult<Attachment> {
    let (id, project, sha256, name, media_type, size, author_email, agent, surface, uploaded_at) =
        r;
    Ok(Attachment {
        id,
        project,
        reference: format!("att:{}", &sha256[..REFERENCE_LEN.min(sha256.len())]),
        sha256,
        name,
        media_type,
        size,
        author_email,
        agent,
        surface: surface.parse()?,
        uploaded_at,
    })
}

impl TrackerStore {
    fn blob_path(&self, sha256: &str) -> PathBuf {
        self.attachments_dir.join(&sha256[..2]).join(sha256)
    }

    /// Store an upload: the bytes once per hash, a row per upload.
    pub async fn store_attachment(&self, new: NewAttachment, actor: &Actor) -> TResult<Attachment> {
        let who = actor.validated()?;
        if new.bytes.len() > MAX_ATTACHMENT_BYTES {
            return refused(format!(
                "attachment is {} bytes; the limit is {MAX_ATTACHMENT_BYTES} (50 MB)",
                new.bytes.len()
            ));
        }
        if new.bytes.is_empty() {
            return refused("attachment is empty");
        }
        super::validate_project(&new.project)?;
        let media_type = resolve_media_type(new.media_type.as_deref(), &new.bytes)?;
        let name = clean_name(&new.name);
        let sha256 = format!("{:x}", Sha256::digest(&new.bytes));

        let dest = self.blob_path(&sha256);
        if !tokio::fs::try_exists(&dest).await? {
            let dir = dest.parent().expect("blob path has a parent");
            tokio::fs::create_dir_all(dir).await?;
            // Write beside it and rename into place, so a reader never sees half a file.
            let tmp = dir.join(format!(
                ".{sha256}.{}.{}.tmp",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ));
            tokio::fs::write(&tmp, &new.bytes).await?;
            tokio::fs::rename(&tmp, &dest).await?;
        }

        let now = now_iso();
        let mut tx = self.write_tx().await?;
        ensure_project(&mut tx, &new.project, &now).await?;
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO attachments (project, sha256, name, media_type, size, author_email, agent, surface, \
             uploaded_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
        )
        .bind(&new.project)
        .bind(&sha256)
        .bind(&name)
        .bind(&media_type)
        .bind(new.bytes.len() as i64)
        .bind(&who.0)
        .bind(&who.1)
        .bind(who.2.as_str())
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        let row: AttachmentRow = sqlx::query_as(&format!("{ATT_SELECT} WHERE id = ?"))
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        from_row(row)
    }

    /// Find an attachment by its full hash or a prefix of at least 12 hex
    /// characters. A prefix matching two different files is refused.
    pub async fn find_attachment(&self, hash: &str) -> TResult<AttachmentContent> {
        let hash = hash.trim().trim_start_matches("att:").to_ascii_lowercase();
        if hash.len() < REFERENCE_LEN
            || hash.len() > 64
            || !hash.chars().all(|c| c.is_ascii_hexdigit())
        {
            return refused(format!(
                "invalid attachment hash {hash:?} (at least {REFERENCE_LEN} hex characters of its sha256)"
            ));
        }
        let shas: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT sha256 FROM attachments WHERE substr(sha256, 1, ?) = ? LIMIT 2",
        )
        .bind(hash.len() as i64)
        .bind(&hash)
        .fetch_all(&self.pool)
        .await?;
        let sha = match shas.as_slice() {
            [] => return Err(TrackerError::NotFound(format!("no attachment {hash:?}"))),
            [one] => one.clone(),
            _ => {
                return refused(format!(
                    "attachment prefix {hash:?} is ambiguous: give more of the hash"
                ))
            }
        };
        let row: AttachmentRow = sqlx::query_as(&format!(
            "{ATT_SELECT} WHERE sha256 = ? ORDER BY id LIMIT 1"
        ))
        .bind(&sha)
        .fetch_one(&self.pool)
        .await?;
        let path = self.blob_path(&sha);
        if !tokio::fs::try_exists(&path).await? {
            return Err(TrackerError::Internal(format!(
                "attachment {sha} has a record but no file"
            )));
        }
        Ok(AttachmentContent {
            attachment: from_row(row)?,
            path,
        })
    }

    /// The uploads of `project`, newest first.
    pub async fn list_attachments(&self, project: &str) -> TResult<Vec<Attachment>> {
        let rows: Vec<AttachmentRow> =
            sqlx::query_as(&format!("{ATT_SELECT} WHERE project = ? ORDER BY id DESC"))
                .bind(project)
                .fetch_all(&self.pool)
                .await?;
        rows.into_iter().map(from_row).collect()
    }
}
