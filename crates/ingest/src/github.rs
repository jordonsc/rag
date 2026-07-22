//! GitHub corpus source: enumerate an account's repos, select the active ones,
//! and shallow-clone them so the indexer needs no developer filesystem.
//!
//! Archived repos are always skipped (and should be purged from the index).
//! Forks are configurable. The PAT is read from `GITHUB_TOKEN` (env-only).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context};
use rag_core::config::GithubConfig;
use rag_core::model::Corpus;
use serde::Deserialize;

use crate::discovery::RepoRoot;

const TOKEN_ENV: &str = "GITHUB_TOKEN";

#[derive(Debug, Deserialize)]
pub struct RepoMeta {
    pub name: String,
    pub clone_url: String,
    pub default_branch: String,
    pub archived: bool,
    pub fork: bool,
    pub owner: Owner,
}

#[derive(Debug, Deserialize)]
pub struct Owner {
    pub login: String,
}

/// Outcome of preparing the GitHub corpus: cloned roots to index, plus the names
/// of repos that should be purged from the index (archived / excluded).
pub struct Prepared {
    pub roots: Vec<RepoRoot>,
    pub purge_repos: Vec<String>,
    pub selected: usize,
    pub archived: usize,
    pub skipped_forks: usize,
}

/// Read the GitHub PAT from the environment.
pub fn token() -> anyhow::Result<String> {
    std::env::var(TOKEN_ENV).with_context(|| format!("{TOKEN_ENV} not set"))
}

/// Enumerate, select, and clone the account's repos.
pub async fn prepare(cfg: &GithubConfig, token: &str) -> anyhow::Result<Prepared> {
    let repos = enumerate(cfg, token).await?;

    let mut roots = Vec::new();
    let mut purge_repos = Vec::new();
    let (mut selected, mut archived, mut skipped_forks) = (0, 0, 0);

    std::fs::create_dir_all(&cfg.work_dir)
        .with_context(|| format!("create work dir {}", cfg.work_dir.display()))?;

    for repo in &repos {
        if repo.owner.login != cfg.account {
            continue;
        }
        if repo.archived {
            archived += 1;
            purge_repos.push(repo.name.clone());
            continue;
        }
        if cfg.exclude.iter().any(|e| e == &repo.name) {
            purge_repos.push(repo.name.clone());
            continue;
        }
        if repo.fork && !cfg.include_forks {
            skipped_forks += 1;
            purge_repos.push(repo.name.clone());
            continue;
        }

        let dest = cfg.work_dir.join(&repo.name);
        clone_or_update(repo, &dest, token).with_context(|| format!("clone {}", repo.name))?;
        let corpus = if repo.name == cfg.wiki_repo {
            Corpus::Wiki
        } else {
            Corpus::Code
        };
        roots.push(RepoRoot {
            name: repo.name.clone(),
            corpus,
            root: dest,
        });
        selected += 1;
    }

    Ok(Prepared {
        roots,
        purge_repos,
        selected,
        archived,
        skipped_forks,
    })
}

/// List repos owned by the authenticated account (paginated).
async fn enumerate(cfg: &GithubConfig, token: &str) -> anyhow::Result<Vec<RepoMeta>> {
    let client = reqwest::Client::new();
    let mut repos = Vec::new();
    let mut page = 1;
    loop {
        let url =
            format!("https://api.github.com/user/repos?affiliation=owner&per_page=100&page={page}");
        let resp = client
            .get(&url)
            .bearer_auth(token)
            .header("User-Agent", "rag-indexer")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("github api {status}: {body}");
        }
        let batch: Vec<RepoMeta> = resp.json().await?;
        let n = batch.len();
        repos.extend(batch);
        if n < 100 {
            break;
        }
        page += 1;
    }
    tracing::info!(account = %cfg.account, repos = repos.len(), "enumerated GitHub repos");
    Ok(repos)
}

/// Shallow-clone a repo, or update an existing clone to the latest default branch.
/// The token is injected into the remote URL for auth and is never logged.
fn clone_or_update(repo: &RepoMeta, dest: &Path, token: &str) -> anyhow::Result<()> {
    let authed =
        repo.clone_url
            .replacen("https://", &format!("https://x-access-token:{token}@"), 1);

    if dest.join(".git").is_dir() {
        run_git(
            dest,
            &["fetch", "--depth", "1", "origin", &repo.default_branch],
        )?;
        run_git(
            dest,
            &[
                "reset",
                "--hard",
                &format!("origin/{}", repo.default_branch),
            ],
        )?;
        run_git(dest, &["clean", "-qdfx"])?;
    } else {
        if dest.exists() {
            std::fs::remove_dir_all(dest).ok();
        }
        run_git(
            Path::new("."),
            &[
                "clone",
                "--depth",
                "1",
                "--single-branch",
                "--branch",
                &repo.default_branch,
                &authed,
                &dest.to_string_lossy(),
            ],
        )?;
    }
    tracing::info!(repo = %repo.name, "cloned/updated");
    Ok(())
}

fn run_git(cwd: &Path, args: &[&str]) -> anyhow::Result<()> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .context("spawn git")?;
    if !out.status.success() {
        // Redact any token that may appear in a remote URL in stderr.
        let stderr =
            String::from_utf8_lossy(&out.stderr).replace("x-access-token:", "x-access-token:***@");
        bail!("git {:?} failed: {}", args.first().unwrap_or(&""), stderr);
    }
    Ok(())
}

/// Convenience for callers that only need the cloned roots as a `Vec<PathBuf>`.
#[allow(dead_code)]
pub fn root_paths(prepared: &Prepared) -> Vec<PathBuf> {
    prepared.roots.iter().map(|r| r.root.clone()).collect()
}
