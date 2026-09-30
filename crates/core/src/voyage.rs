//! Voyage AI client — embeddings and reranking.
//!
//! Embeddings support batching, retry/backoff on transient failures, and token
//! accounting. `input_type` is enforced (`document` at ingest, `query` at search).
//! Reranking (Phase 05) is the single-shot typed shell for now.
//!
//! ## Batch sizing is a hard bound, not an estimate
//!
//! Voyage refuses a request whose inputs total more than [`VOYAGE_MAX_BATCH_TOKENS`]
//! tokens (`400 TOO_MANY_TOKENS_IN_BATCH`). Batches used to be sized by an assumed
//! ~4 characters per token, which generated SVG path data (~1.3 chars/token) blew
//! through at twice the limit. The bound is now **one token per UTF-8 byte**, plus a
//! per-input allowance for special tokens: a byte-level BPE (or a byte-fallback
//! tokenizer) cannot emit more tokens than the bytes it reads, so a batch sized by
//! bytes cannot exceed the limit whatever the content's density. Budgeting at 80 %
//! of the limit leaves room for normalisation quirks, and a refusal that still
//! happens is split in half and retried ([`embed_splitting`]) rather than failing
//! the run. The cost is more, smaller requests; billing is per token, so it is not
//! more money.

use std::collections::VecDeque;
use std::future::Future;
use std::ops::Range;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::VoyageConfig;
use crate::error::{Error, Result};

const DEFAULT_BASE_URL: &str = "https://api.voyageai.com/v1";
const API_KEY_ENV: &str = "VOYAGE_API_KEY";

/// Max inputs per embeddings request. Voyage accepts 1,000; 128 keeps a request's
/// body and latency modest.
pub const MAX_BATCH_ITEMS: usize = 128;
/// Voyage's per-request token ceiling for `voyage-4-large` (the documented limit,
/// and the figure its `TOO_MANY_TOKENS_IN_BATCH` refusal quotes).
pub const VOYAGE_MAX_BATCH_TOKENS: usize = 120_000;
/// The token budget a planned batch is held under: 80 % of the ceiling.
pub const BATCH_TOKEN_BUDGET: usize = VOYAGE_MAX_BATCH_TOKENS * 4 / 5;
/// Allowance per input for special tokens the tokenizer adds around it.
const PER_INPUT_TOKEN_OVERHEAD: usize = 8;
/// Most requests one [`embed_splitting`] call may make after a refusal. A batch
/// of [`MAX_BATCH_ITEMS`] halves to singletons in `2 * 128 - 1` requests, so this
/// is never the binding limit for a planned batch; it exists so no input can make
/// the split loop unbounded.
const MAX_SPLIT_REQUESTS: usize = 2 * MAX_BATCH_ITEMS;
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

    /// Embed documents (for ingest). Splits `texts` into token-safe batches
    /// ([`plan_batches`]), embeds each, and returns one vector per input (in order)
    /// plus total tokens billed.
    ///
    /// All-or-nothing: a caller that must keep its progress when a later batch
    /// fails plans the batches itself and calls [`Self::embed_document_batch`].
    pub async fn embed_documents(&self, texts: &[String]) -> Result<(Vec<Vec<f32>>, u64)> {
        let mut vectors = Vec::with_capacity(texts.len());
        let mut tokens = 0u64;
        for range in plan_batches(texts) {
            let (vecs, t) = self.embed_document_batch(&texts[range]).await?;
            vectors.extend(vecs);
            tokens += t;
        }
        Ok((vectors, tokens))
    }

    /// Embed one planned batch of documents. A `TOO_MANY_TOKENS_IN_BATCH` refusal
    /// is answered by splitting the batch and retrying the halves (bounded — see
    /// [`embed_splitting`]), so a batch the byte bound under-sized still lands.
    pub async fn embed_document_batch(&self, texts: &[String]) -> Result<(Vec<Vec<f32>>, u64)> {
        embed_splitting(texts, |b| self.embed_once(b, InputType::Document)).await
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
        let vectors: Vec<Vec<f32>> = resp.data.into_iter().map(|d| d.embedding).collect();
        if vectors.len() != inputs.len() {
            return Err(Error::Voyage(format!(
                "embedding count {} != input count {}",
                vectors.len(),
                inputs.len()
            )));
        }
        Ok((vectors, tokens))
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
                    if is_batch_too_large(status.as_u16(), &text) {
                        return Err(Error::VoyageBatchTooLarge(format!("{status}: {text}")));
                    }
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

/// An upper bound on the tokens Voyage can count for `text`: one per UTF-8 byte,
/// plus the per-input special-token allowance. See the module docs for why a byte
/// bound rather than a characters-per-token estimate.
pub fn token_upper_bound(text: &str) -> usize {
    text.len() + PER_INPUT_TOKEN_OVERHEAD
}

/// Split inputs into contiguous batches, each within [`MAX_BATCH_ITEMS`] inputs and
/// [`BATCH_TOKEN_BUDGET`] tokens by [`token_upper_bound`]. An input that exceeds the
/// budget on its own is given a batch of its own (Voyage's per-input context is far
/// larger than a chunk, and [`embed_splitting`] reports it if it is refused).
pub fn plan_batches(texts: &[String]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut tokens = 0;
    for (i, text) in texts.iter().enumerate() {
        let t = token_upper_bound(text);
        let would_overflow =
            i > start && (i - start >= MAX_BATCH_ITEMS || tokens + t > BATCH_TOKEN_BUDGET);
        if would_overflow {
            out.push(start..i);
            start = i;
            tokens = 0;
        }
        tokens += t;
    }
    if start < texts.len() {
        out.push(start..texts.len());
    }
    out
}

/// Whether a Voyage error response is the per-request token ceiling refusal.
/// Keyed on the documented `error_code`, with the prose as a fallback in case the
/// code is ever dropped from the body.
fn is_batch_too_large(status: u16, body: &str) -> bool {
    status == 400
        && (body.contains("TOO_MANY_TOKENS_IN_BATCH")
            || body.contains("max allowed tokens per submitted batch"))
}

/// Embed `texts` with `embed`, splitting on a [`Error::VoyageBatchTooLarge`]
/// refusal: the refused range is halved and each half retried, in order, until it
/// lands. Vectors come back in input order.
///
/// Bounded twice over: a single input that is still refused cannot be split and is
/// an error, and the whole call makes at most [`MAX_SPLIT_REQUESTS`] requests.
/// Every other error is returned as-is — only the batch-size refusal is something
/// splitting can fix, so nothing else is retried here (transient failures are
/// retried with backoff inside the request itself).
pub async fn embed_splitting<'a, F, Fut>(
    texts: &'a [String],
    embed: F,
) -> Result<(Vec<Vec<f32>>, u64)>
where
    F: Fn(&'a [String]) -> Fut,
    Fut: Future<Output = Result<(Vec<Vec<f32>>, u64)>>,
{
    let mut vectors = Vec::with_capacity(texts.len());
    let mut tokens = 0u64;
    if texts.is_empty() {
        return Ok((vectors, tokens));
    }
    let mut pending: VecDeque<Range<usize>> = VecDeque::new();
    pending.push_back(0..texts.len());
    let mut requests = 0usize;
    while let Some(range) = pending.pop_front() {
        requests += 1;
        if requests > MAX_SPLIT_REQUESTS {
            return Err(Error::Voyage(format!(
                "gave up splitting a refused batch after {MAX_SPLIT_REQUESTS} requests"
            )));
        }
        match embed(&texts[range.clone()]).await {
            Ok((vecs, t)) => {
                vectors.extend(vecs);
                tokens += t;
            }
            Err(Error::VoyageBatchTooLarge(msg)) if range.len() > 1 => {
                let mid = range.start + range.len() / 2;
                tracing::warn!(
                    inputs = range.len(),
                    bytes = texts[range.clone()].iter().map(String::len).sum::<usize>(),
                    "voyage refused the batch as too many tokens; splitting and retrying: {msg}"
                );
                pending.push_front(mid..range.end);
                pending.push_front(range.start..mid);
            }
            Err(e) => return Err(e),
        }
    }
    Ok((vectors, tokens))
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

    /// Sum of the byte bound over one planned batch.
    fn bound(texts: &[String], r: &Range<usize>) -> usize {
        texts[r.clone()].iter().map(|t| token_upper_bound(t)).sum()
    }

    #[test]
    fn plan_batches_holds_dense_content_under_the_token_ceiling() {
        // The incident: 2048-char chunks of SVG path data (~1.3 chars/token). The
        // old 320,000-char cap packed 128 of them (~262 KB) into one request —
        // about 200k tokens against a 120k ceiling. Even at the worst possible
        // density (one token per byte) no planned batch may exceed the ceiling.
        let chunk = "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10".repeat(55);
        let texts: Vec<String> = (0..500).map(|_| chunk.clone()).collect();
        let plan = plan_batches(&texts);
        assert!(plan.len() > 1);
        for r in &plan {
            assert!(
                bound(&texts, r) <= BATCH_TOKEN_BUDGET,
                "batch {r:?} over budget"
            );
            assert!(bound(&texts, r) < VOYAGE_MAX_BATCH_TOKENS);
            assert!(r.len() <= MAX_BATCH_ITEMS);
        }
        // Old behaviour, for the record: 128 of these per batch by the char cap.
        assert!(chunk.len() * 128 <= 320_000 && chunk.len() * 128 > VOYAGE_MAX_BATCH_TOKENS);
    }

    #[test]
    fn plan_batches_covers_every_input_once_and_in_order() {
        let texts: Vec<String> = (0..1000).map(|i| "x".repeat(i % 3000 + 1)).collect();
        let plan = plan_batches(&texts);
        let mut next = 0;
        for r in &plan {
            assert_eq!(r.start, next, "batches must be contiguous");
            assert!(!r.is_empty());
            next = r.end;
        }
        assert_eq!(next, texts.len());
    }

    #[test]
    fn plan_batches_caps_item_count_for_tiny_inputs() {
        let texts: Vec<String> = (0..300).map(|_| "a".to_string()).collect();
        let plan = plan_batches(&texts);
        assert_eq!(plan, vec![0..128, 128..256, 256..300]);
    }

    #[test]
    fn plan_batches_isolates_an_oversized_input() {
        let big = "z".repeat(BATCH_TOKEN_BUDGET + 10);
        let texts = vec!["a".into(), big, "b".into()];
        assert_eq!(plan_batches(&texts), vec![0..1, 1..2, 2..3]);
        assert!(plan_batches(&[]).is_empty());
    }

    #[test]
    fn batch_too_large_is_recognised_from_the_real_refusal() {
        let body = r#"{"detail":"Request to model 'voyage-4-large' failed. The max allowed tokens per submitted batch is 120000. Your batch has 240538 tokens after truncation. Please lower the number of tokens in the batch.","error_code":"TOO_MANY_TOKENS_IN_BATCH"}"#;
        assert!(is_batch_too_large(400, body));
        assert!(!is_batch_too_large(429, body));
        assert!(!is_batch_too_large(400, r#"{"detail":"invalid model"}"#));
    }

    type FakeReply = std::future::Ready<Result<(Vec<Vec<f32>>, u64)>>;

    /// A fake Voyage: refuses any request whose byte total exceeds `limit`,
    /// otherwise returns one vector per input whose only element is the input's
    /// length, and bills one token per byte.
    fn fake(limit: usize, calls: &std::cell::Cell<usize>) -> impl Fn(&[String]) -> FakeReply + '_ {
        move |batch: &[String]| {
            calls.set(calls.get() + 1);
            let bytes: usize = batch.iter().map(String::len).sum();
            std::future::ready(if bytes > limit {
                Err(Error::VoyageBatchTooLarge(
                    "400: TOO_MANY_TOKENS_IN_BATCH".into(),
                ))
            } else {
                Ok((
                    batch.iter().map(|t| vec![t.len() as f32]).collect(),
                    bytes as u64,
                ))
            })
        }
    }

    #[tokio::test]
    async fn a_refused_batch_is_split_and_every_vector_lands_in_order() {
        let texts: Vec<String> = (1..=8).map(|i| "q".repeat(i * 10)).collect();
        let calls = std::cell::Cell::new(0);
        // 360 bytes in total; the fake refuses anything over 100.
        let (vecs, tokens) = embed_splitting(&texts, fake(100, &calls)).await.unwrap();
        let lens: Vec<f32> = vecs.iter().map(|v| v[0]).collect();
        assert_eq!(lens, (1..=8).map(|i| (i * 10) as f32).collect::<Vec<_>>());
        assert_eq!(tokens, 360, "only the accepted requests are counted");
        assert!(calls.get() > 1, "the refusal must have been split");
    }

    #[tokio::test]
    async fn an_unsplittable_refusal_is_an_error_not_a_loop() {
        let texts = vec!["w".repeat(500), "v".repeat(10)];
        let calls = std::cell::Cell::new(0);
        let err = embed_splitting(&texts, fake(100, &calls))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::VoyageBatchTooLarge(_)));
        // [0..2] refused → [0..1] refused and unsplittable → stop.
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn other_errors_are_not_retried_by_splitting() {
        let texts: Vec<String> = (0..4).map(|_| "t".into()).collect();
        let calls = std::cell::Cell::new(0);
        let err = embed_splitting(&texts, |_| {
            calls.set(calls.get() + 1);
            std::future::ready(Err::<(Vec<Vec<f32>>, u64), _>(Error::Voyage("500".into())))
        })
        .await
        .unwrap_err();
        assert!(matches!(err, Error::Voyage(_)));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn input_type_serialises_lowercase() {
        let v = serde_json::to_string(&InputType::Document).unwrap();
        assert_eq!(v, "\"document\"");
        let v = serde_json::to_string(&InputType::Query).unwrap();
        assert_eq!(v, "\"query\"");
    }
}
