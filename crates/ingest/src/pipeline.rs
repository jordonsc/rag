//! Embed-and-persist, one unit at a time.
//!
//! A *unit* is the thing whose points must be replaced together — a source file
//! (corpus ingest) or a ledger topic (ledger reconcile). Its texts are embedded in
//! token-safe batches ([`plan_batches`]) that freely span unit boundaries, and each
//! unit is handed to a [`UnitSink`] **as soon as its last vector arrives**. So a run
//! that fails at batch *k* has already persisted every unit finished before it and
//! loses at most the one unit in flight, instead of discarding everything it paid
//! for — which is what turned one oversized batch into ~4M wasted tokens per
//! retry, every 15 minutes (ledger `rag-0032`).

use std::future::Future;

use rag_core::voyage::{plan_batches, VoyageClient};

/// Something that embeds one planned batch of document texts, returning one vector
/// per input (in order) and the tokens billed. A trait so the pipeline can be
/// exercised without the network.
pub trait BatchEmbedder {
    fn embed(
        &self,
        texts: &[String],
    ) -> impl Future<Output = rag_core::Result<(Vec<Vec<f32>>, u64)>>;
}

impl BatchEmbedder for VoyageClient {
    fn embed(
        &self,
        texts: &[String],
    ) -> impl Future<Output = rag_core::Result<(Vec<Vec<f32>>, u64)>> {
        self.embed_document_batch(texts)
    }
}

/// Receives each finished unit's vectors, in unit order, and makes them durable.
pub trait UnitSink {
    fn persist(
        &mut self,
        unit: usize,
        vectors: Vec<Vec<f32>>,
    ) -> impl Future<Output = anyhow::Result<()>>;
}

/// What a pipeline run got done — filled in as it goes, so a caller still has it
/// when the run fails part-way.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Progress {
    /// Tokens billed by the requests that succeeded.
    pub tokens: u64,
    /// Embedding requests that succeeded (a split refusal counts once).
    pub batches: usize,
    /// Units handed to the sink successfully.
    pub units_persisted: usize,
}

/// Embed `texts` — laid out unit by unit, `unit_lens[u]` texts for unit `u` — and
/// persist each unit through `sink` the moment it is complete. A unit with no
/// texts is persisted with no vectors (its sink call is what retires its stale
/// points). Returns the first error; everything persisted before it stays.
pub async fn embed_units<E, S>(
    embedder: &E,
    texts: &[String],
    unit_lens: &[usize],
    sink: &mut S,
    progress: &mut Progress,
) -> anyhow::Result<()>
where
    E: BatchEmbedder,
    S: UnitSink,
{
    anyhow::ensure!(
        unit_lens.iter().sum::<usize>() == texts.len(),
        "unit lengths sum to {} but there are {} texts",
        unit_lens.iter().sum::<usize>(),
        texts.len()
    );

    // Vectors of the units not yet persisted, starting at unit `next`.
    let mut pending: Vec<Vec<f32>> = Vec::new();
    let mut next = 0usize;

    flush_complete(unit_lens, &mut next, &mut pending, sink, progress).await?;
    for range in plan_batches(texts) {
        let want = range.len();
        let (vectors, tokens) = embedder.embed(&texts[range]).await?;
        anyhow::ensure!(
            vectors.len() == want,
            "embedding count {} != batch size {want}",
            vectors.len()
        );
        progress.tokens += tokens;
        progress.batches += 1;
        pending.extend(vectors);
        flush_complete(unit_lens, &mut next, &mut pending, sink, progress).await?;
    }
    anyhow::ensure!(
        next == unit_lens.len() && pending.is_empty(),
        "pipeline ended with {} of {} units persisted",
        next,
        unit_lens.len()
    );
    Ok(())
}

/// Hand every unit whose vectors are all in `pending` to the sink, in order.
async fn flush_complete<S: UnitSink>(
    unit_lens: &[usize],
    next: &mut usize,
    pending: &mut Vec<Vec<f32>>,
    sink: &mut S,
    progress: &mut Progress,
) -> anyhow::Result<()> {
    while *next < unit_lens.len() && unit_lens[*next] <= pending.len() {
        let rest = pending.split_off(unit_lens[*next]);
        let unit_vectors = std::mem::replace(pending, rest);
        sink.persist(*next, unit_vectors).await?;
        progress.units_persisted += 1;
        *next += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use rag_core::error::Error;
    use rag_core::voyage::BATCH_TOKEN_BUDGET;

    use super::*;

    /// Embeds each text as `[len]`; fails the `fail_on`-th request (1-based).
    struct FakeEmbedder {
        calls: Cell<usize>,
        fail_on: Option<usize>,
    }

    impl FakeEmbedder {
        fn new(fail_on: Option<usize>) -> Self {
            Self {
                calls: Cell::new(0),
                fail_on,
            }
        }
    }

    impl BatchEmbedder for FakeEmbedder {
        async fn embed(&self, texts: &[String]) -> rag_core::Result<(Vec<Vec<f32>>, u64)> {
            self.calls.set(self.calls.get() + 1);
            if Some(self.calls.get()) == self.fail_on {
                return Err(Error::Voyage("400: TOO_MANY_TOKENS_IN_BATCH".into()));
            }
            Ok((
                texts.iter().map(|t| vec![t.len() as f32]).collect(),
                texts.iter().map(|t| t.len() as u64).sum(),
            ))
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        persisted: RefCell<Vec<(usize, Vec<f32>)>>,
    }

    impl UnitSink for RecordingSink {
        async fn persist(&mut self, unit: usize, vectors: Vec<Vec<f32>>) -> anyhow::Result<()> {
            self.persisted
                .borrow_mut()
                .push((unit, vectors.into_iter().map(|v| v[0]).collect()));
            Ok(())
        }
    }

    /// Texts big enough that each planned batch holds only a few of them.
    fn big(len: usize) -> String {
        "k".repeat(len)
    }

    #[tokio::test]
    async fn every_unit_is_persisted_with_its_own_vectors_in_order() {
        // Unit 1 has no texts; unit 2 spans a batch boundary.
        let third = BATCH_TOKEN_BUDGET / 3;
        let texts = vec![big(10), big(third), big(third), big(third), big(20)];
        let lens = [1, 0, 3, 1];
        let embedder = FakeEmbedder::new(None);
        let mut sink = RecordingSink::default();
        let mut progress = Progress::default();
        embed_units(&embedder, &texts, &lens, &mut sink, &mut progress)
            .await
            .unwrap();
        let got = sink.persisted.into_inner();
        assert_eq!(
            got,
            vec![
                (0, vec![10.0]),
                (1, vec![]),
                (2, vec![third as f32; 3]),
                (3, vec![20.0]),
            ]
        );
        assert!(progress.batches >= 2, "the fixture must span batches");
        assert_eq!(progress.units_persisted, 4);
        assert_eq!(progress.tokens, (10 + 3 * third + 20) as u64);
    }

    #[tokio::test]
    async fn a_failure_keeps_every_unit_finished_before_it() {
        // One unit per batch-filling text: each request completes one unit.
        let texts: Vec<String> = (0..5).map(|_| big(BATCH_TOKEN_BUDGET - 100)).collect();
        let lens = [1, 1, 1, 1, 1];
        let embedder = FakeEmbedder::new(Some(4));
        let mut sink = RecordingSink::default();
        let mut progress = Progress::default();
        let err = embed_units(&embedder, &texts, &lens, &mut sink, &mut progress).await;
        assert!(err.is_err());
        let units: Vec<usize> = sink
            .persisted
            .into_inner()
            .iter()
            .map(|(u, _)| *u)
            .collect();
        assert_eq!(
            units,
            vec![0, 1, 2],
            "units before the failing batch persist"
        );
        assert_eq!(progress.units_persisted, 3);
        assert_eq!(progress.batches, 3);
        assert_eq!(
            embedder.calls.get(),
            4,
            "nothing is attempted after the failure"
        );
    }

    #[tokio::test]
    async fn a_unit_split_across_a_failed_batch_is_not_persisted_half_done() {
        let half = BATCH_TOKEN_BUDGET / 2 + 1;
        // Unit 0 = two texts that cannot share a batch; the second batch fails.
        let texts = vec![big(half), big(half)];
        let embedder = FakeEmbedder::new(Some(2));
        let mut sink = RecordingSink::default();
        let mut progress = Progress::default();
        assert!(
            embed_units(&embedder, &texts, &[2], &mut sink, &mut progress)
                .await
                .is_err()
        );
        assert!(sink.persisted.into_inner().is_empty());
        assert_eq!(progress.units_persisted, 0);
    }

    #[tokio::test]
    async fn only_empty_units_need_no_request() {
        let embedder = FakeEmbedder::new(None);
        let mut sink = RecordingSink::default();
        let mut progress = Progress::default();
        embed_units(&embedder, &[], &[0, 0], &mut sink, &mut progress)
            .await
            .unwrap();
        assert_eq!(sink.persisted.into_inner().len(), 2);
        assert_eq!(embedder.calls.get(), 0);
    }

    #[tokio::test]
    async fn mismatched_unit_lengths_are_refused() {
        let embedder = FakeEmbedder::new(None);
        let mut sink = RecordingSink::default();
        let mut progress = Progress::default();
        assert!(
            embed_units(&embedder, &[big(1)], &[2], &mut sink, &mut progress)
                .await
                .is_err()
        );
        assert_eq!(embedder.calls.get(), 0);
    }
}
