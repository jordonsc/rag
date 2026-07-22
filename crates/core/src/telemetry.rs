//! Tracing initialisation shared by all binaries.

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Initialise structured logging to **stdout**. Honours `RUST_LOG` (defaults to
/// `info`).
///
/// Safe to call once at the start of a binary. Subsequent calls are ignored.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true))
        .try_init();
}

/// As [`init`] but logs to **stderr**. Required for stdio-transport servers
/// (e.g. `rag-mcp`) where stdout carries the protocol stream and must not be
/// polluted by log lines.
pub fn init_stderr() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_writer(std::io::stderr))
        .try_init();
}
