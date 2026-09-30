#!/usr/bin/env bash
# Disk hygiene for the server: remove dangling/unused images so old Qdrant (and later,
# service) image versions don't accumulate. Podman will not remove an image that a
# container (running or stopped) still references — but it removes EVERY other
# unused image on the host, whatever project owns it. Only for a box dedicated to rag;
# `deploy.sh` retires rag's own superseded image without this.
set -euo pipefail

echo "== before =="
podman image ls
echo
echo "== pruning dangling + unused images =="
podman image prune -af
echo
echo "== after =="
podman image ls
