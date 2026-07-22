//! Turn a source file into chunks carrying full provenance.
//!
//! Sizing is character-based, calibrated to the token target via
//! [`CHARS_PER_TOKEN`]. Token-exact sizing (tiktoken/HF as the splitter's sizer)
//! was measured at 100×+ slower — individual TypeScript files took 2–30 s because
//! text-splitter re-tokenises candidate splits thousands of times. Character
//! sizing keeps chunks in the right band for `voyage-4-large` (32K context) at a
//! fraction of the cost. Code is split on AST boundaries, markdown on structure,
//! everything else recursively.

use std::time::UNIX_EPOCH;

use anyhow::Context;
use rag_core::hashing::hash_str;
use rag_core::model::{Chunk, ChunkPayload};
use text_splitter::{ChunkConfig, CodeSplitter, MarkdownSplitter, TextSplitter};

use crate::discovery::DiscoveredFile;
use crate::language::{self, Splitter};

/// Approximate characters per token. ~4 is the usual ratio for code/English and
/// is only used to translate the token-based config into a character budget.
const CHARS_PER_TOKEN: usize = 4;

/// Code files larger than this are chunked with the (much cheaper) text splitter
/// instead of the tree-sitter splitter. AST-aware chunking on very large files is
/// disproportionately expensive in text-splitter and adds little retrieval value.
const LARGE_CODE_BYTES: usize = 80_000;

pub struct Chunker {
    max_chars: usize,
    overlap_chars: usize,
}

impl Chunker {
    pub fn new(max_tokens: u32, overlap_tokens: u32) -> anyhow::Result<Self> {
        Ok(Self {
            max_chars: max_tokens as usize * CHARS_PER_TOKEN,
            overlap_chars: overlap_tokens as usize * CHARS_PER_TOKEN,
        })
    }

    /// Chunk one discovered file. Returns the chunks (empty if the file yields
    /// none) and whether it hit the code-language fallback.
    pub fn chunk_file(&self, file: &DiscoveredFile) -> anyhow::Result<(Vec<Chunk>, bool)> {
        let text = std::fs::read_to_string(&file.path)
            .with_context(|| format!("read {}", file.path.display()))?;
        let file_hash = hash_str(&text);
        let mtime = std::fs::metadata(&file.path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let class = language::classify(&file.path);
        let path = file.path.to_string_lossy().into_owned();

        let config = ChunkConfig::new(self.max_chars)
            .with_overlap(self.overlap_chars)
            .context("invalid chunk overlap/capacity")?;

        let raw: Vec<(usize, String)> = match class.splitter {
            // Very large code files fall back to the cheap text splitter.
            Splitter::Code(_) if text.len() > LARGE_CODE_BYTES => TextSplitter::new(config)
                .chunk_indices(&text)
                .map(|(o, s)| (o, s.to_string()))
                .collect(),
            Splitter::Code(lang) => CodeSplitter::new(lang, config)
                .context("build code splitter")?
                .chunk_indices(&text)
                .map(|(o, s)| (o, s.to_string()))
                .collect(),
            Splitter::Markdown => MarkdownSplitter::new(config)
                .chunk_indices(&text)
                .map(|(o, s)| (o, s.to_string()))
                .collect(),
            Splitter::Text => TextSplitter::new(config)
                .chunk_indices(&text)
                .map(|(o, s)| (o, s.to_string()))
                .collect(),
        };

        let starts = line_starts(&text);
        let mut chunks = Vec::with_capacity(raw.len());
        for (index, (offset, chunk_text)) in raw.into_iter().enumerate() {
            if chunk_text.is_empty() {
                continue;
            }
            let start_line = line_at(&starts, offset);
            let end_byte = offset + chunk_text.len() - 1;
            let end_line = line_at(&starts, end_byte).max(start_line);
            let content_hash = hash_str(&chunk_text);

            chunks.push(Chunk::new(ChunkPayload {
                corpus: file.corpus,
                repo: file.repo.clone(),
                path: path.clone(),
                rel_path: file.rel_path.clone(),
                language: class.language.clone(),
                chunk_index: index as u32,
                start_line,
                end_line,
                content_hash,
                file_hash: file_hash.clone(),
                text: chunk_text,
                mtime,
            }));
        }

        Ok((chunks, class.code_fallback))
    }

    /// Split a raw text blob into character-sized, markdown-aware chunks. Used for
    /// ledger monologue entries (free-form prose that can run long); a short entry
    /// yields a single chunk. Empty chunks are dropped.
    pub fn chunk_text(&self, text: &str) -> anyhow::Result<Vec<String>> {
        let config = ChunkConfig::new(self.max_chars)
            .with_overlap(self.overlap_chars)
            .context("invalid chunk overlap/capacity")?;
        Ok(MarkdownSplitter::new(config)
            .chunks(text)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect())
    }
}

/// Byte offsets at which each line begins (line 1 begins at 0).
fn line_starts(text: &str) -> Vec<usize> {
    let mut v = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            v.push(i + 1);
        }
    }
    v
}

/// 1-based line number containing the given byte offset.
fn line_at(starts: &[usize], offset: usize) -> u32 {
    starts.partition_point(|&s| s <= offset) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_at_maps_offsets() {
        let text = "a\nbb\nccc";
        let s = line_starts(text);
        assert_eq!(line_at(&s, 0), 1); // 'a'
        assert_eq!(line_at(&s, 2), 2); // first 'b'
        assert_eq!(line_at(&s, 5), 3); // first 'c'
    }

    #[test]
    fn chunk_text_splits_long_and_keeps_short_whole() {
        // Small budget so the test text reliably spans multiple chunks.
        let c = Chunker {
            max_chars: 100,
            overlap_chars: 0,
        };
        let short = c.chunk_text("a short note").unwrap();
        assert_eq!(short.len(), 1);

        let long = "para. ".repeat(200); // ~1200 chars >> 100-char budget
        let chunks = c.chunk_text(&long).unwrap();
        assert!(
            chunks.len() > 1,
            "long text must split into multiple chunks"
        );
        assert!(chunks.iter().all(|s| !s.is_empty()));
    }
}
