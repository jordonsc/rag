# Multi-stage build for the RAG binaries: the indexer (`rag-ingest`), the HTTP
# retrieval service (`rag-serve`), and the MCP gateway (`rag-mcp`). One image, all
# three binaries — callers name the binary (no ENTRYPOINT). Runtime needs `git`
# (the GitHub source shallow-clones repos) and CA certs (HTTPS to Voyage/GitHub).
#
# `rag-mcp` runs server-side here ONLY in its `--transport http` mode (the shared
# Streamable HTTP gateway, so remote clients need no local binary). Its original
# `--transport stdio` mode is still a per-client subprocess spawned by the agent on
# the box it runs on — that one is built locally (`cargo build --release -p rag-mcp`),
# see deploy/RUNBOOK.md.
FROM docker.io/library/rust:1.94-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p rag-ingest -p rag-serve -p rag-mcp

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/rag-ingest /usr/local/bin/rag-ingest
COPY --from=build /src/target/release/rag-serve /usr/local/bin/rag-serve
COPY --from=build /src/target/release/rag-mcp /usr/local/bin/rag-mcp
# No ENTRYPOINT: units run e.g. `... localhost/rag:latest rag-ingest run --source github`,
# `... rag-serve`, or `... rag-mcp --transport http`. `curl` is included for the
# rag-serve / rag-mcp healthchecks.
