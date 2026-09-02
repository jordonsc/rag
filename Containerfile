# Multi-stage build for the RAG binaries: the indexer (`rag-ingest`), the HTTP
# retrieval service (`rag-serve`), and the MCP gateway (`rag-mcp`) — plus the
# ledger web UI that `rag-serve` hands to a browser at `/`. One image, all three
# binaries — callers name the binary (no ENTRYPOINT). Runtime needs `git` (the
# GitHub source shallow-clones repos) and CA certs (HTTPS to Voyage/GitHub).
#
# `rag-mcp` runs server-side here ONLY in its `--transport http` mode (the shared
# Streamable HTTP gateway, so remote clients need no local binary). Its original
# `--transport stdio` mode is still a per-client subprocess spawned by the agent on
# the box it runs on — that one is built locally (`cargo build --release -p rag-mcp`),
# see deploy/RUNBOOK.md.
#
# There are two build stages, Rust and Node, and **neither depends on the other**.
# Each copies only its own inputs, so a change to the SPA never invalidates the
# cargo build and a change to a crate never re-runs `npm ci`. That independence is
# worth the extra COPY lines: the image is built on the deployment box (see
# deploy/deploy.sh), which is small, and a cold Rust rebuild for a one-line CSS
# change is minutes it does not have.

# ---------------------------------------------------------------------------
# The SPA. `web/` is an npm workspace (`ui` = the design system, `app` = the
# viewer); only `app` has a build script, and it emits `app/dist`.
#
# Node 22 LTS, bookworm-slim to match the runtime base below. `web/README.md`
# asks for Node 22+ / npm 10+ and Vite refuses anything older; pinning the major
# rather than `:latest` keeps a deploy from silently moving toolchains.
# ---------------------------------------------------------------------------
FROM docker.io/library/node:22-bookworm-slim AS web
WORKDIR /web
# Manifests and the lockfile first, sources second. Fetching the dependency tree
# is the slow half of this stage and it only changes when these four files do, so
# a source-only edit reuses the installed layer. `npm ci` (not `install`) installs
# exactly what the committed lockfile pins and fails if the manifests disagree
# with it — a deploy is the wrong place to discover a floating minor version.
# npm needs every workspace member's manifest present before it will resolve.
COPY web/package.json web/package-lock.json ./
COPY web/ui/package.json ui/
COPY web/app/package.json app/
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# The binaries. Copy only what cargo reads — `COPY . .` here would put the whole
# repo (web sources included) into the layer hash and undo the split above.
# ---------------------------------------------------------------------------
FROM docker.io/library/rust:1.94-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN cargo build --release -p rag-ingest -p rag-serve -p rag-mcp

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/rag-ingest /usr/local/bin/rag-ingest
COPY --from=build /src/target/release/rag-serve /usr/local/bin/rag-serve
COPY --from=build /src/target/release/rag-mcp /usr/local/bin/rag-mcp
# The built bundle, and nothing else from the Node stage — `node_modules` and the
# toolchain stay behind in it. This destination is not a preference: the Quadlet
# unit sets `RAG_SERVER__WEB_ROOT=/usr/local/share/rag/web` (deploy/rag-serve.container),
# so the unit and this line have to agree and they live in different files. Change
# one, change the other. A bundle that lands anywhere else is simply not served —
# an empty/missing web root is a warning in rag-serve, not a startup failure.
COPY --from=web /web/app/dist /usr/local/share/rag/web
# No ENTRYPOINT: units run e.g. `... localhost/rag:latest rag-ingest run --source github`,
# `... rag-serve`, or `... rag-mcp --transport http`. `curl` is included for the
# rag-serve / rag-mcp healthchecks.
