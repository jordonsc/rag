//! Shared foundations for the RAG project: data model, config, external clients,
//! errors, and telemetry. Every binary crate (`ingest`, `serve`, `mcp`) builds on this.
//!
//! See `README.md` for an architecture overview.

pub mod anthropic;
pub mod config;
pub mod error;
pub mod hashing;
pub mod ids;
pub mod ledger;
pub mod model;
pub mod qdrant;
pub mod retrieval;
pub mod telemetry;
pub mod voyage;

pub use error::{Error, Result};
