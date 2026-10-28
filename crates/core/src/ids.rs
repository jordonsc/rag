//! Deterministic point IDs.
//!
//! A chunk's Qdrant point ID is a UUIDv5 of `"{path}#{chunk_index}"` under a fixed
//! project namespace. This makes re-ingest idempotent: the same source location
//! always maps to the same point.

use uuid::Uuid;

/// Fixed namespace UUID for this project. Do not change — altering it would
/// orphan every existing point on the next ingest.
pub const RAG_NAMESPACE: Uuid = Uuid::from_u128(0x7d9f_1c2a_3b4e_5f60_8a1b_2c3d_4e5f_6071);

/// Deterministic point ID for a chunk at `path`, index `chunk_index`.
pub fn chunk_id(path: &str, chunk_index: u32) -> Uuid {
    let name = format!("{path}#{chunk_index}");
    Uuid::new_v5(&RAG_NAMESPACE, name.as_bytes())
}

/// Deterministic point ID for a ledger topic's primary (summary) point.
pub fn ledger_topic_id(topic_id: &str) -> Uuid {
    let name = format!("ledger:topic:{topic_id}");
    Uuid::new_v5(&RAG_NAMESPACE, name.as_bytes())
}

/// Deterministic point ID for a single ledger monologue event, optionally split
/// into `chunk_index` parts for over-long bodies.
pub fn ledger_event_id(topic_id: &str, event_id: i64, chunk_index: u32) -> Uuid {
    let name = format!("ledger:event:{topic_id}#{event_id}#{chunk_index}");
    Uuid::new_v5(&RAG_NAMESPACE, name.as_bytes())
}

/// Deterministic point ID for chunk `chunk_index` of a tracker unit (a document
/// id like `ubu-d0007` or an item id like `ubu-t0042`). Keyed on the id, not the
/// path, so a renamed document's new points overwrite its old ones in place.
pub fn tracker_point_id(tracker_id: &str, chunk_index: u32) -> Uuid {
    let name = format!("tracker:{tracker_id}#{chunk_index}");
    Uuid::new_v5(&RAG_NAMESPACE, name.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_ids_are_stable_and_distinct_from_ledger_ids() {
        assert_eq!(
            tracker_point_id("ubu-d0001", 0),
            tracker_point_id("ubu-d0001", 0)
        );
        assert_ne!(
            tracker_point_id("ubu-d0001", 0),
            tracker_point_id("ubu-d0001", 1)
        );
        assert_ne!(
            tracker_point_id("ubu-t0001", 0),
            ledger_topic_id("ubu-t0001")
        );
        // A ledger id of either form (rag-t0051) keys its own points: the
        // `l`-marked id and the legacy one with the same number are two topics.
        assert_ne!(ledger_topic_id("ubu-l0001"), ledger_topic_id("ubu-0001"));
        assert_ne!(
            ledger_topic_id("ubu-l0001"),
            tracker_point_id("ubu-l0001", 0)
        );
    }

    #[test]
    fn stable_across_calls() {
        let p = "/repo/src/lib.rs";
        assert_eq!(chunk_id(p, 0), chunk_id(p, 0));
        assert_ne!(chunk_id(p, 0), chunk_id(p, 1));
    }
}
