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

    /// Voyage refused a request for carrying too many tokens in one batch
    /// (`400 TOO_MANY_TOKENS_IN_BATCH`). Distinct from [`Error::Voyage`] because it
    /// is the one refusal a caller can fix by splitting the batch and retrying.
    #[error("voyage API error (batch too large): {0}")]
    VoyageBatchTooLarge(String),

    /// A failed call to the Anthropic Messages API, or a response that could not
    /// be made sense of. The message is shown to a reader, so it carries the
    /// vendor's own wording where there is one — and never the API key, which
    /// `anthropic::AnthropicClient::scrub` strips before it gets here.
    #[error("anthropic API error: {0}")]
    Anthropic(String),

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
