#!/usr/bin/env bash
# Disk hygiene for the server: remove dangling/unused images so old Qdrant (and later,
# service) image versions don't accumulate. Safe to run any time — Podman will not
# remove an image that a container (running or stopped) still references.
set -euo pipefail

echo "== before =="
podman image ls
echo
echo "== pruning dangling + unused images =="
podman image prune -af
echo
echo "== after =="
podman image ls
