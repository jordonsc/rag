//! Corpus source resolution: local filesystem (dev) or GitHub clones (server).

use clap::ValueEnum;
use rag_core::config::Config;
use rag_core::model::Corpus;

use crate::discovery::{self, DiscoveredFile, SkipReason};
use crate::github::{self, Prepared};

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
pub enum Source {
    /// Walk the local corpus (the configured code root + wiki).
    Local,
    /// Shallow-clone the configured GitHub account's repos.
    Github,
}

pub struct Resolved {
    pub files: Vec<DiscoveredFile>,
    pub skips: Vec<(SkipReason, u64)>,
    /// Present only for the GitHub source (carries repos to purge).
    pub github: Option<Prepared>,
}

pub async fn resolve(
    cfg: &Config,
    source: Source,
    corpus: Option<Corpus>,
    repo: Option<&str>,
) -> anyhow::Result<Resolved> {
    match source {
        Source::Local => {
            let (files, skips) = discovery::discover(cfg, corpus, repo);
            Ok(Resolved {
                files,
                skips,
                github: None,
            })
        }
        Source::Github => {
            let token = github::token()?;
            let prepared = github::prepare(&cfg.github, &token).await?;
            tracing::info!(
                selected = prepared.selected,
                archived = prepared.archived,
                skipped_forks = prepared.skipped_forks,
                "GitHub corpus prepared"
            );
            let (files, skips) = discovery::discover_roots(cfg, &prepared.roots, corpus, repo);
            Ok(Resolved {
                files,
                skips,
                github: Some(prepared),
            })
        }
    }
}
