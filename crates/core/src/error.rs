//! Crate-wide error type and `Result` alias.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("missing required environment variable: {0}")]
    MissingEnv(String),

    #[error("voyage API error: {0}")]
    Voyage(String),

    #[error("qdrant error: {0}")]
    Qdrant(String),

    #[error("ledger error: {0}")]
    Ledger(String),

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<figment::Error> for Error {
    fn from(e: figment::Error) -> Self {
        Error::Config(e.to_string())
    }
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Error::Ledger(e.to_string())
    }
}
