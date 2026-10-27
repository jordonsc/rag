# Host running the RAG services (SSH alias or user@host). The real value lives in
# the gitignored deploy/deploy.env (copy it from deploy/deploy.env.example).
# Override per invocation with: make reindex DEPLOY_HOST=myhost
-include deploy/deploy.env
DEPLOY_HOST ?= your-server

.PHONY: build check fmt fmt-check clippy test run-ingest run-serve run-mcp reindex reconcile-ledger reconcile-tracker all

all: fmt-check clippy test

build:
	cargo build --workspace

check:
	cargo check --workspace

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all -- --check

clippy:
	cargo clippy --workspace --all-targets -- -D warnings

test:
	cargo test --workspace

run-ingest:
	cargo run -p rag-ingest --

run-serve:
	cargo run -p rag-serve --

run-mcp:
	cargo run -p rag-mcp --

# Trigger an immediate corpus re-index on the server (the timer otherwise runs every 15 min).
reindex:
	ssh $(DEPLOY_HOST) systemctl --user start rag-sync.service && echo "re-index triggered"

# Trigger an immediate ledger reconcile on the server (the timer otherwise runs every 15 min;
# rag-serve also fires this automatically after each ledger write).
reconcile-ledger:
	ssh $(DEPLOY_HOST) systemctl --user start rag-ledger-sync.service && echo "ledger reconcile triggered"

# Trigger an immediate tracker reconcile (corpus = tracker) on the server (the timer otherwise
# runs every 15 min; rag-serve also fires this automatically after each tracker write).
reconcile-tracker:
	ssh $(DEPLOY_HOST) systemctl --user start rag-tracker-sync.service && echo "tracker reconcile triggered"
