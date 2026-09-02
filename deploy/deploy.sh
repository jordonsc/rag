#!/usr/bin/env bash
# One-command deploy of the RAG services to the configured host (run from the dev
# repo root).
#
#   ./deploy/deploy.sh
#
# Ships the source — Rust crates and the `web/` SPA sources, minus anything the
# build regenerates (target/, node_modules/, dist/) — builds the unified image
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
#
# An explicit DEPLOY_HOST in the environment wins over the file. It has to: the
# header above documents `DEPLOY_HOST=myhost ./deploy/deploy.sh`, and sourcing
# deploy.env unconditionally would overwrite exactly the value the caller just
# set — so the documented inline override silently went to the file's host
# instead. `deploy-local.sh` depends on this precedence too.
_deploy_host_from_env="${DEPLOY_HOST:-}"
[ -f deploy/deploy.env ] && . deploy/deploy.env
[ -n "$_deploy_host_from_env" ] && DEPLOY_HOST="$_deploy_host_from_env"
HOST="${DEPLOY_HOST:-your-server}"
SRC_DIR="rag/src"
IMAGE="localhost/rag:latest"

if [ "$HOST" = "your-server" ]; then
    echo "ERROR: set DEPLOY_HOST (deploy/deploy.env or inline) to your server's SSH host." >&2
    exit 1
fi

# Is the target this very machine? On a single-box estate the dev box and the
# server are the same host, and then the ssh hop is not merely redundant: it
# requires the box to hold a key authorising a login to itself, which is an
# account nobody otherwise wants to exist. `deploy-local.sh` is the entry point
# for that case; it sets DEPLOY_HOST=local and lands here.
#
# `run` and `put` are the only things that differ between the two modes, so
# there is ONE list of deploy steps rather than two that drift apart. Resist
# adding a bare `ssh` below — it silently breaks the local path.
case "$HOST" in
    local | localhost | 127.0.0.1 | "$(hostname -s 2>/dev/null)" | "$(hostname -f 2>/dev/null)")
        LOCAL=1
        TARGET="localhost"
        ;;
    *)
        LOCAL=0
        TARGET="$HOST"
        ;;
esac

# Run a command on the target. Locally this is a subshell, not an ssh session, so
# `~` and `$HOME` still resolve to the same place either way.
run() {
    if [ "$LOCAL" = 1 ]; then bash -c "$1"; else ssh "$HOST" "$1"; fi
}

# Copy files into a directory on the target, given relative to the target's home
# (matching scp's default behaviour, so the call sites read identically).
#   put <dest-dir-relative-to-home> <file>...
put() {
    local dest="$1"
    shift
    if [ "$LOCAL" = 1 ]; then
        mkdir -p "$HOME/$dest"
        cp "$@" "$HOME/$dest/"
    else
        scp "$@" "$HOST:$dest/"
    fi
}

# Where the source tree lands: a path here, a host:path over ssh.
rsync_target() {
    if [ "$LOCAL" = 1 ]; then echo "$HOME/$SRC_DIR/"; else echo "$HOST:$SRC_DIR/"; fi
}

# Prefix for the "go read the logs" hints below — locally you are already there.
LOG_HINT=$([ "$LOCAL" = 1 ] && echo "" || echo "ssh $HOST ")

if [ "$LOCAL" = 1 ]; then
    echo "== deploying to THIS machine ($(hostname -s)) — no ssh hop =="
fi

echo "== 1/6  ship source -> $TARGET:$SRC_DIR =="
run "mkdir -p ~/$SRC_DIR ~/.config/systemd/user ~/.config/containers/systemd ~/rag/triggers ~/rag/ledger ~/rag/prompts && touch ~/rag/triggers/reindex ~/rag/triggers/ledger-reindex"
# The image is built from this tree, so `web/` has to travel with the crates — the
# SPA is compiled in a Node stage on the host, not shipped pre-built. What must NOT
# travel is anything that build regenerates: node_modules (thousands of files, and
# the wrong platform's binaries) and dist (the bundle the Node stage produces). Same
# rule as target/ — these excludes mirror .containerignore, which keeps the same
# things out of the podman build context on the far side.
rsync -a --delete \
    --exclude target --exclude .git --exclude .env --exclude corpus --exclude '*.swp' \
    --exclude rag.toml --exclude deploy/deploy.env \
    --exclude node_modules --exclude dist \
    ./ "$(rsync_target)"

echo "== 2/6  build $IMAGE on $TARGET =="
run "cd ~/$SRC_DIR && podman build -t $IMAGE -f Containerfile ."

# ---- preflight: the corpus-purge guard -------------------------------------
#
# `rag-sync` selects repos with `owner.login == $RAG_GITHUB__ACCOUNT`. With the
# account unset, zero repos are selected, the walk finds zero files, and the
# reconcile treats every indexed file as deleted — it purges the entire code
# corpus. The index rebuilds, but only after a full re-clone and re-embed, and
# in the meantime every agent's `search_corpus` silently returns nothing.
#
# This has now happened twice. Both times a deploy reinstalled rag-sync.service
# over a copy that carried the account, and both times the unit's own comment
# warned about it — which is the point: a comment cannot stop a deploy, so this
# check does. It runs BEFORE the units are installed, because after that the
# damage is one timer tick away.
#
# Set RAG_SKIP_ACCOUNT_CHECK=1 to bypass (e.g. a `--source local` estate that has
# edited rag-sync.service and genuinely has no GitHub account).
echo "== preflight  corpus-purge guard =="
if [ "${RAG_SKIP_ACCOUNT_CHECK:-0}" = "1" ]; then
    echo "  skipped (RAG_SKIP_ACCOUNT_CHECK=1)"
elif run "grep -qs '^RAG_GITHUB__ACCOUNT=..*' ~/.config/rag/env"; then
    echo "  OK — RAG_GITHUB__ACCOUNT is set on $TARGET"
else
    cat >&2 <<EOF
ERROR: RAG_GITHUB__ACCOUNT is not set in ~/.config/rag/env on $TARGET.

Deploying now would install rag-sync.service and then, on its next run, PURGE THE
ENTIRE CODE CORPUS from the index: with no account, zero repos are selected, and
the reconcile deletes every indexed file as though it had disappeared.

Fix it on $TARGET, then re-run:

    echo 'RAG_GITHUB__ACCOUNT=your-github-account' >> ~/.config/rag/env

(Or set RAG_SKIP_ACCOUNT_CHECK=1 if this estate indexes a local source and has
deliberately edited rag-sync.service.)
EOF
    exit 1
fi

echo "== 3/6  install units =="
# Quadlet (.container) units -> ~/.config/containers/systemd/
# Plain units (.service/.timer/.path) -> ~/.config/systemd/user/
put .config/containers/systemd \
    deploy/rag-serve.container deploy/rag-mcp.container deploy/qdrant.container
put .config/systemd/user \
    deploy/rag-sync.service deploy/rag-sync.timer deploy/rag-reindex.path \
    deploy/rag-ledger-sync.service deploy/rag-ledger-sync.timer deploy/rag-ledger-reindex.path \
    deploy/rag-backup.service deploy/rag-backup.timer
run "systemctl --user daemon-reload"

echo "== 4/6  ensure Qdrant payload indexes (idempotent; adds ledger type/status/topic_id) =="
run "podman run --rm --network=host --pull=never \
    --env-file=\$HOME/.config/rag/env -e RAG_QDRANT__URL=http://localhost:6334 \
    $IMAGE rag-ingest init"

echo "== 5/6  (re)start services =="
# rag-serve + the MCP gateway pick up the new image; corpus + ledger timers and
# trigger watchers are enabled.
# rag-serve + rag-mcp are Quadlet units enabled via their own [Install] section
# (can't be `systemctl enable`d — they're generated), so just (re)start them.
run "systemctl --user restart rag-serve.service rag-mcp.service && systemctl --user enable --now \
    rag-sync.timer rag-reindex.path rag-ledger-sync.timer rag-ledger-reindex.path rag-backup.timer"

echo "== 6/6  prune old images =="
run "podman image prune -af >/dev/null && podman image ls | grep -E 'rag|qdrant' || true"

echo
echo "== health =="
run "curl -fsS http://localhost:17793/health && echo && curl -fsS http://localhost:17793/info" || {
    echo "WARNING: /health or /info failed — check: ${LOG_HINT}journalctl --user -u rag-serve.service -n 50"
    exit 1
}
# MCP gateway liveness: a bare GET yields 4xx (no session) but proves it's listening.
run "curl -s -o /dev/null -w 'rag-mcp /corpus -> HTTP %{http_code}\n' http://localhost:17794/corpus" || {
    echo "WARNING: rag-mcp gateway not answering — check: ${LOG_HINT}journalctl --user -u rag-mcp.service -n 50"
    exit 1
}
# Ledger UI: `/` must return the SPA shell rather than the API's JSON 404, which is
# what you get if the bundle didn't make it into the image. Deliberately NOT fatal —
# the web root is optional by design (rag-serve serves the JSON API alone without
# one), so a missing bundle is a broken UI, not a broken deploy.
run "curl -fsS http://localhost:17793/ | grep -qi '<!doctype html'" \
    && echo "ledger UI -> HTML at http://$TARGET:17793/" \
    || echo "WARNING: / returned no HTML — the UI bundle is missing from the image, or RAG_SERVER__WEB_ROOT is unset in rag-serve.container. The JSON API is unaffected."
echo
echo "deploy OK"
