#!/usr/bin/env bash
# One-command deploy of the RAG services to the configured host (run from the dev
# repo root).
#
#   ./deploy/deploy.sh
#
# Ships the source (no target/.git/.env/corpus), builds the unified image
# `localhost/rag:latest` on the host, installs/refreshes the systemd units,
# restarts the HTTP service, reloads the sync timer, and prunes old images so disk
# doesn't bloat. Idempotent — safe to re-run.
#
# Target host comes from $DEPLOY_HOST (set it in deploy/deploy.env — copy
# deploy/deploy.env.example — or pass it inline: DEPLOY_HOST=myhost ./deploy/deploy.sh).
#
# Prereqs (one-time, see deploy/RUNBOOK.md): linger enabled, ~/.config/rag/env
# populated (VOYAGE_API_KEY, GITHUB_TOKEN), Qdrant running.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Load the deploy target (DEPLOY_HOST) from deploy/deploy.env if present.
[ -f deploy/deploy.env ] && . deploy/deploy.env
HOST="${DEPLOY_HOST:-your-server}"
SRC_DIR="rag/src"
IMAGE="localhost/rag:latest"

if [ "$HOST" = "your-server" ]; then
    echo "ERROR: set DEPLOY_HOST (deploy/deploy.env or inline) to your server's SSH host." >&2
    exit 1
fi

echo "== 1/6  ship source -> $HOST:$SRC_DIR =="
ssh "$HOST" "mkdir -p ~/$SRC_DIR ~/.config/systemd/user ~/.config/containers/systemd ~/rag/triggers ~/rag/ledger && touch ~/rag/triggers/reindex ~/rag/triggers/ledger-reindex"
rsync -az --delete \
    --exclude target --exclude .git --exclude .env --exclude corpus --exclude '*.swp' \
    ./ "$HOST:$SRC_DIR/"

echo "== 2/6  build $IMAGE on $HOST =="
ssh "$HOST" "cd ~/$SRC_DIR && podman build -t $IMAGE -f Containerfile ."

echo "== 3/6  install units =="
# Quadlet (.container) units -> ~/.config/containers/systemd/
# Plain units (.service/.timer/.path) -> ~/.config/systemd/user/
scp deploy/rag-serve.container "$HOST:.config/containers/systemd/rag-serve.container"
scp deploy/rag-mcp.container   "$HOST:.config/containers/systemd/rag-mcp.container"
scp deploy/qdrant.container    "$HOST:.config/containers/systemd/qdrant.container"
scp deploy/rag-sync.service deploy/rag-sync.timer deploy/rag-reindex.path \
    deploy/rag-ledger-sync.service deploy/rag-ledger-sync.timer deploy/rag-ledger-reindex.path \
    deploy/rag-backup.service deploy/rag-backup.timer \
    "$HOST:.config/systemd/user/"
ssh "$HOST" "systemctl --user daemon-reload"

echo "== 4/6  ensure Qdrant payload indexes (idempotent; adds ledger type/status/topic_id) =="
ssh "$HOST" "podman run --rm --network=host --pull=never \
    --env-file=\$HOME/.config/rag/env -e RAG_QDRANT__URL=http://localhost:6334 \
    $IMAGE rag-ingest init"

echo "== 5/6  (re)start services =="
# rag-serve + the MCP gateway pick up the new image; corpus + ledger timers and
# trigger watchers are enabled.
# rag-serve + rag-mcp are Quadlet units enabled via their own [Install] section
# (can't be `systemctl enable`d — they're generated), so just (re)start them.
ssh "$HOST" "systemctl --user restart rag-serve.service rag-mcp.service && systemctl --user enable --now \
    rag-sync.timer rag-reindex.path rag-ledger-sync.timer rag-ledger-reindex.path rag-backup.timer"

echo "== 6/6  prune old images =="
ssh "$HOST" "podman image prune -af >/dev/null && podman image ls | grep -E 'rag|qdrant' || true"

echo
echo "== health =="
ssh "$HOST" "curl -fsS http://localhost:17793/health && echo && curl -fsS http://localhost:17793/info" || {
    echo "WARNING: /health or /info failed — check: ssh $HOST journalctl --user -u rag-serve.service -n 50"
    exit 1
}
# MCP gateway liveness: a bare GET yields 4xx (no session) but proves it's listening.
ssh "$HOST" "curl -s -o /dev/null -w 'rag-mcp /corpus -> HTTP %{http_code}\n' http://localhost:17794/corpus" || {
    echo "WARNING: rag-mcp gateway not answering — check: ssh $HOST journalctl --user -u rag-mcp.service -n 50"
    exit 1
}
echo
echo "deploy OK"
