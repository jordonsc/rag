#!/usr/bin/env bash
# Deploy the RAG services to THIS machine — the single-box case, where the box you
# develop on is also the box that runs Qdrant, rag-serve and the timers.
#
#   ./deploy/deploy-local.sh
#
# Everything `deploy.sh` does, minus the ssh/scp hop. It is a thin entry point, not
# a second implementation: it sets DEPLOY_HOST=local and execs `deploy.sh`, whose
# `run`/`put` helpers then execute here instead of over a connection. There is one
# list of deploy steps, so the two paths cannot drift — which matters, because a
# deploy script that is only exercised on one of two machines is a deploy script
# that is wrong on the other.
#
# WHY THIS EXISTS, rather than just pointing DEPLOY_HOST at your own hostname:
# ssh to yourself needs the box to hold a key authorising a login to itself. That
# is a real account with a real authorised key, added for the sake of a hop whose
# only purpose is to arrive back where it started. Not worth the attack surface.
#
# You do not strictly need this file — `deploy.sh` detects that DEPLOY_HOST names
# this machine (it compares against `hostname -s`/`-f`) and takes the same local
# path. This exists so the intent is explicit at the call site, and so a deploy on
# a single-box estate does not depend on `deploy/deploy.env` naming the right host.
#
# Prereqs are identical and unchanged (see deploy/RUNBOOK.md): linger enabled,
# ~/.config/rag/env populated (VOYAGE_API_KEY, and GITHUB_TOKEN for the GitHub
# source), Qdrant reachable. Podman is required; a Node or Rust toolchain is not —
# both builds happen inside the image.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# An explicit DEPLOY_HOST beats deploy/deploy.env, so this holds even on a box
# whose deploy.env names a remote host. `deploy.sh` enforces that precedence.
DEPLOY_HOST=local exec "$here/deploy.sh" "$@"
