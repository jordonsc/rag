//! Content hashing for change detection.
//!
//! BLAKE3 chosen for speed; the digest is rendered as lowercase hex. Used for both
//! per-chunk `content_hash` and whole-file `file_hash`.

/// Hex-encoded BLAKE3 hash of the given bytes.
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Convenience wrapper for hashing a string slice.
pub fn hash_str(s: &str) -> String {
    hash_bytes(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_distinct() {
        assert_eq!(hash_str("hello"), hash_str("hello"));
        assert_ne!(hash_str("hello"), hash_str("world"));
        // BLAKE3 hex digest is 64 chars.
        assert_eq!(hash_str("x").len(), 64);
    }
}
