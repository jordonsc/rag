#!/usr/bin/env bash
# Back up the Qdrant `rag_corpus` collection, the ledger DB and the tracker DB
# (run on the server, or via
# `ssh <host> 'bash -s' < deploy/backup-qdrant.sh`).
#
# The index is rebuildable from GitHub source, but a snapshot saves a full
# re-embed (Voyage tokens + ~3 min). Uses Qdrant's snapshot API; the snapshot
# lands in the snapshots bind mount (~/rag/qdrant/snapshots) and is copied to a
# timestamped tarball under ~/rag/backups.
#
# Restore: see deploy/RUNBOOK.md ("Restore the index from a snapshot").
set -euo pipefail

COLLECTION="${RAG_COLLECTION:-rag_corpus}"
QDRANT_REST="${QDRANT_REST:-http://localhost:6333}"
SNAP_DIR="$HOME/rag/qdrant/snapshots"
OUT_DIR="$HOME/rag/backups"
KEEP="${KEEP:-7}"   # how many tarballs to retain

mkdir -p "$OUT_DIR"

echo "== creating snapshot of '$COLLECTION' =="
resp="$(curl -fsS -X POST "$QDRANT_REST/collections/$COLLECTION/snapshots")"
name="$(printf '%s' "$resp" | grep -oE '"name":"[^"]+"' | head -1 | cut -d'"' -f4)"
if [ -z "$name" ]; then
    echo "ERROR: could not parse snapshot name from response:" >&2
    printf '%s\n' "$resp" >&2
    exit 1
fi
echo "  snapshot: $name"

# Qdrant writes collection snapshots under <snapshots>/<collection>/<name>.
src="$SNAP_DIR/$COLLECTION/$name"
if [ ! -f "$src" ]; then
    # Some versions place it directly under <snapshots>/<name>.
    src="$SNAP_DIR/$name"
fi
[ -f "$src" ] || { echo "ERROR: snapshot file not found under $SNAP_DIR" >&2; exit 1; }

stamp="$(printf '%s' "$name" | tr -cd '0-9' | tail -c 14)"
[ -n "$stamp" ] || stamp="snapshot"
out="$OUT_DIR/${COLLECTION}-${stamp}.snapshot"
cp -f "$src" "$out"
echo "  saved: $out ($(du -h "$out" | cut -f1))"

echo "== pruning to last $KEEP backups =="
ls -1t "$OUT_DIR/${COLLECTION}-"*.snapshot 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "  rm $old"; rm -f "$old"
done

# The ledger SQLite DB is the source of truth (Qdrant ledger points are derived),
# so back it up too. Unlike the corpus, this CANNOT be rebuilt from elsewhere.
echo "== backing up ledger SQLite =="
LEDGER_DB="$HOME/rag/ledger/ledger.db"
if [ -f "$LEDGER_DB" ]; then
    lstamp="$(date -u +%Y%m%d%H%M%S 2>/dev/null || echo backup)"
    lout="$OUT_DIR/ledger-${lstamp}.db"
    if command -v sqlite3 >/dev/null 2>&1; then
        # Consistent online backup.
        sqlite3 "$LEDGER_DB" ".backup '$lout'"
    else
        # No sqlite3: copy the db + WAL/SHM together (consistent enough to restore).
        cp -f "$LEDGER_DB" "$lout"
        [ -f "$LEDGER_DB-wal" ] && cp -f "$LEDGER_DB-wal" "$lout-wal" || true
        [ -f "$LEDGER_DB-shm" ] && cp -f "$LEDGER_DB-shm" "$lout-shm" || true
    fi
    echo "  saved: $lout ($(du -h "$lout" | cut -f1))"
    ls -1t "$OUT_DIR/ledger-"*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
        echo "  rm $old"; rm -f "$old" "$old-wal" "$old-shm"
    done
else
    echo "  (no ledger.db yet — skipping)"
fi

# The tracker SQLite DB (specs/tracker) is the source of truth for every project's
# queue, specs and concepts, which no longer live in their repositories: like the
# ledger, it CANNOT be rebuilt from elsewhere. This is the interim same-box copy
# until the off-box backup (tracker m06). Attachments are not copied: they are
# content-addressed and never rewritten, so a second copy on the same disk guards
# against nothing a disk failure would not take with it.
echo "== backing up tracker SQLite =="
TRACKER_DB="$HOME/rag/tracker/tracker.db"
if [ -f "$TRACKER_DB" ]; then
    tstamp="$(date -u +%Y%m%d%H%M%S 2>/dev/null || echo backup)"
    tout="$OUT_DIR/tracker-${tstamp}.db"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$TRACKER_DB" ".backup '$tout'"
    else
        cp -f "$TRACKER_DB" "$tout"
        [ -f "$TRACKER_DB-wal" ] && cp -f "$TRACKER_DB-wal" "$tout-wal" || true
        [ -f "$TRACKER_DB-shm" ] && cp -f "$TRACKER_DB-shm" "$tout-shm" || true
    fi
    echo "  saved: $tout ($(du -h "$tout" | cut -f1))"
    ls -1t "$OUT_DIR/tracker-"*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
        echo "  rm $old"; rm -f "$old" "$old-wal" "$old-shm"
    done
else
    echo "  (no tracker.db yet — skipping)"
fi

echo "backup OK"
