//! Map a file to how it should be chunked.
//!
//! Code extensions map to a tree-sitter grammar (AST-aware chunking); markdown
//! gets the markdown splitter; everything else falls back to the plain text
//! splitter, labelled by its extension so it remains filterable.

use std::path::Path;

use tree_sitter::Language;

/// How a file should be split.
pub enum Splitter {
    /// AST-aware chunking with the given tree-sitter grammar.
    Code(Language),
    /// Markdown-structure-aware chunking.
    Markdown,
    /// Plain recursive text chunking (config, data, unsupported languages).
    Text,
}

/// The classification of a source file: a language label (stored in the payload
/// and usable as a filter) and the splitter to use.
pub struct Classification {
    pub language: String,
    pub splitter: Splitter,
    /// True when the file fell back to the text splitter despite looking like
    /// code (i.e. an unsupported code language) — surfaced as a coverage gap.
    pub code_fallback: bool,
}

/// Tree-sitter grammar + canonical language label for a code extension.
fn grammar_for(ext: &str) -> Option<(&'static str, Language)> {
    let (label, lang): (&str, Language) = match ext {
        "rs" => ("rust", tree_sitter_rust::LANGUAGE.into()),
        "py" | "pyi" => ("python", tree_sitter_python::LANGUAGE.into()),
        "ts" | "mts" | "cts" => (
            "typescript",
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        ),
        "tsx" => ("tsx", tree_sitter_typescript::LANGUAGE_TSX.into()),
        "js" | "jsx" | "mjs" | "cjs" => ("javascript", tree_sitter_javascript::LANGUAGE.into()),
        "c" | "h" => ("c", tree_sitter_c::LANGUAGE.into()),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "ino" => {
            ("cpp", tree_sitter_cpp::LANGUAGE.into())
        }
        "sh" | "bash" => ("bash", tree_sitter_bash::LANGUAGE.into()),
        "rb" => ("ruby", tree_sitter_ruby::LANGUAGE.into()),
        _ => return None,
    };
    Some((label, lang))
}

/// Extensions that look like code but have no grammar here — chunked as text,
/// but flagged so coverage gaps are visible rather than silent.
fn is_unsupported_code(ext: &str) -> bool {
    matches!(
        ext,
        "tf" | "hcl" | "proto" | "go" | "java" | "kt" | "swift" | "cs" | "php" | "lua" | "scala"
    )
}

pub fn classify(path: &Path) -> Classification {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if matches!(ext.as_str(), "md" | "markdown" | "mdx") {
        return Classification {
            language: "markdown".to_string(),
            splitter: Splitter::Markdown,
            code_fallback: false,
        };
    }

    if let Some((label, lang)) = grammar_for(&ext) {
        return Classification {
            language: label.to_string(),
            splitter: Splitter::Code(lang),
            code_fallback: false,
        };
    }

    // Text fallback. Label by extension when present so filtering still works.
    let language = if ext.is_empty() {
        "text".to_string()
    } else {
        ext.clone()
    };
    Classification {
        language,
        splitter: Splitter::Text,
        code_fallback: is_unsupported_code(&ext),
    }
}
