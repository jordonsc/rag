//! Voyage AI client — embeddings and reranking.
//!
//! Embeddings support batching, retry/backoff on transient failures, and token
//! accounting. `input_type` is enforced (`document` at ingest, `query` at search).
//! Reranking (Phase 05) is the single-shot typed shell for now.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::VoyageConfig;
use crate::error::{Error, Result};

const DEFAULT_BASE_URL: &str = "https://api.voyageai.com/v1";
const API_KEY_ENV: &str = "VOYAGE_API_KEY";

/// Max inputs per embeddings request.
const MAX_BATCH: usize = 128;
/// Max cumulative characters per embeddings request (≈ token budget / 4), kept
/// well under Voyage's per-request limits.
const MAX_BATCH_CHARS: usize = 320_000;
/// Retry attempts for transient (429/5xx/timeout) failures.
const MAX_RETRIES: u32 = 5;

/// Whether an embedding input is a stored document or a search query. This
/// materially affects retrieval quality and must be set correctly on every call.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    Document,
    Query,
}

pub struct VoyageClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    cfg: VoyageConfig,
}

impl VoyageClient {
    /// Construct a client, reading `VOYAGE_API_KEY` from the environment.
    ///
    /// Fails loudly with [`Error::MissingEnv`] if the key is absent — this is the
    /// only place the key is required, so config can be loaded without it.
    pub fn from_env(cfg: VoyageConfig) -> Result<Self> {
        let api_key =
            std::env::var(API_KEY_ENV).map_err(|_| Error::MissingEnv(API_KEY_ENV.into()))?;
        Self::new(cfg, api_key)
    }

    /// Construct a client with an explicit key (useful for tests).
    pub fn new(cfg: VoyageConfig, api_key: String) -> Result<Self> {
        if api_key.trim().is_empty() {
            return Err(Error::MissingEnv(API_KEY_ENV.into()));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| Error::Voyage(format!("http client: {e}")))?;
        Ok(Self {
            http,
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key,
            cfg,
        })
    }

    /// Embed documents (for ingest). Splits `texts` into batches, embeds each with
    /// retry, and returns one vector per input (in order) plus total tokens billed.
    pub async fn embed_documents(&self, texts: &[String]) -> Result<(Vec<Vec<f32>>, u64)> {
        let mut vectors = Vec::with_capacity(texts.len());
        let mut tokens = 0u64;
        for batch in batches(texts) {
            let (vecs, t) = self.embed_once(batch, InputType::Document).await?;
            vectors.extend(vecs);
            tokens += t;
        }
        Ok((vectors, tokens))
    }

    /// Embed a single query string (for search). Uses `input_type = query`.
    pub async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let input = [text.to_string()];
        let (mut vecs, _) = self.embed_once(&input, InputType::Query).await?;
        vecs.pop()
            .ok_or_else(|| Error::Voyage("empty embedding response".into()))
    }

    /// One embeddings request. Returns the vectors (in input order) and tokens used.
    async fn embed_once(
        &self,
        inputs: &[String],
        input_type: InputType,
    ) -> Result<(Vec<Vec<f32>>, u64)> {
        let req = EmbedRequest {
            model: &self.cfg.embed_model,
            input: inputs,
            input_type,
            output_dimension: self.cfg.dimensions,
        };
        let resp: EmbedResponse = self.post("embeddings", &req).await?;
        let tokens = resp.usage.map(|u| u.total_tokens).unwrap_or(0);
        Ok((resp.data.into_iter().map(|d| d.embedding).collect(), tokens))
    }

    /// Rerank `documents` against `query`, returning `(index, score)` pairs ordered
    /// by relevance.
    pub async fn rerank(&self, query: &str, documents: &[String]) -> Result<Vec<(usize, f32)>> {
        let req = RerankRequest {
            model: &self.cfg.rerank_model,
            query,
            documents,
        };
        let resp: RerankResponse = self.post("rerank", &req).await?;
        Ok(resp
            .data
            .into_iter()
            .map(|r| (r.index, r.relevance_score))
            .collect())
    }

    async fn post<B: Serialize, T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let url = format!("{}/{}", self.base_url, path);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let sent = self
                .http
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(body)
                .send()
                .await;

            match sent {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return Ok(resp.json::<T>().await?);
                    }
                    let retryable = status.as_u16() == 429 || status.is_server_error();
                    if retryable && attempt <= MAX_RETRIES {
                        let wait = backoff(attempt);
                        tracing::warn!(%status, attempt, ?wait, "voyage transient error, retrying");
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    let text = resp.text().await.unwrap_or_default();
                    return Err(Error::Voyage(format!("{status}: {text}")));
                }
                Err(e) => {
                    if attempt <= MAX_RETRIES && (e.is_timeout() || e.is_connect()) {
                        let wait = backoff(attempt);
                        tracing::warn!(error = %e, attempt, ?wait, "voyage request failed, retrying");
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    return Err(e.into());
                }
            }
        }
    }
}

/// Exponential backoff: 0.5s, 1s, 2s, 4s, … capped at 16s.
fn backoff(attempt: u32) -> Duration {
    let secs = (1u64 << attempt.min(5)) as f64 * 0.25;
    Duration::from_secs_f64(secs.min(16.0))
}

/// Split inputs into batches bounded by count and cumulative character length.
fn batches(texts: &[String]) -> Vec<&[String]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = 0;
    for i in 0..texts.len() {
        let len = texts[i].len();
        let would_overflow = i > start && (i - start >= MAX_BATCH || chars + len > MAX_BATCH_CHARS);
        if would_overflow {
            out.push(&texts[start..i]);
            start = i;
            chars = 0;
        }
        chars += len;
    }
    if start < texts.len() {
        out.push(&texts[start..]);
    }
    out
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
    input_type: InputType,
    output_dimension: u32,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedData>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct EmbedData {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct Usage {
    total_tokens: u64,
}

#[derive(Serialize)]
struct RerankRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
}

#[derive(Deserialize)]
struct RerankResponse {
    data: Vec<RerankResult>,
}

#[derive(Deserialize)]
struct RerankResult {
    index: usize,
    relevance_score: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VoyageConfig {
        VoyageConfig {
            embed_model: "voyage-4-large".into(),
            rerank_model: "rerank-2.5".into(),
            dimensions: 1024,
        }
    }

    #[test]
    fn empty_key_is_rejected() {
        assert!(VoyageClient::new(cfg(), String::new()).is_err());
        assert!(VoyageClient::new(cfg(), "  ".into()).is_err());
    }

    #[test]
    fn input_type_serialises_lowercase() {
        let v = serde_json::to_string(&InputType::Document).unwrap();
        assert_eq!(v, "\"document\"");
        let v = serde_json::to_string(&InputType::Query).unwrap();
        assert_eq!(v, "\"query\"");
    }
}
