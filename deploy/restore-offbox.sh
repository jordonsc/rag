#!/usr/bin/env bash
# Fetch an off-box backup (deploy/backup-offbox.sh) into a directory and verify it
# (tracker m06, TB-03). It never writes the live data: putting the files in place is
# the runbook's job, with rag-serve stopped ("Restore from S3" in deploy/RUNBOOK.md).
#
#   bash deploy/restore-offbox.sh DEST [STAMP]
#
# DEST   a new or empty directory; receives tracker/tracker.db, tracker/attachments/
#        and ledger/ledger.db — the layout of ~/rag, so DEST can be moved into place.
# STAMP  a daily copy (YYYYMMDD) or a weekly one (GGGG-Www, e.g. 2026-W44); default:
#        the newest daily copy of each database.
#
# Each database is checked three ways before the script says OK: its sha256 against
# the manifest written at backup time, `PRAGMA integrity_check`, and the row count of
# every table against the manifest's. Every attachment is checked against its name.
# Configuration: as backup-offbox.sh (RAG_BACKUP__S3_URI, _AWS_PROFILE, _AWS_REGION,
# read from the environment or ~/.config/rag/env).
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

if [ $# -lt 1 ] || [ $# -gt 2 ]; then die "usage: $0 DEST [YYYYMMDD | GGGG-Www]"; fi
DEST="$1"
STAMP="${2:-}"

ENV_FILE="${RAG_ENV_FILE:-$HOME/.config/rag/env}"
if [ -r "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            RAG_BACKUP__*=*) ;;
            *) continue ;;
        esac
        key="${line%%=*}"
        val="${line#*=}"
        val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
        [[ "$key" =~ ^RAG_BACKUP__[A-Z0-9_]+$ ]] || continue
        if [ -z "${!key:-}" ]; then
            export "$key=$val"
        fi
    done < "$ENV_FILE"
fi

S3_URI="${RAG_BACKUP__S3_URI:-}"
PROFILE="${RAG_BACKUP__AWS_PROFILE:-default}"
REGION="${RAG_BACKUP__AWS_REGION:-ap-southeast-4}"
DATA_DIR="${RAG_BACKUP__DATA_DIR:-$HOME/rag}"

case "$S3_URI" in
    s3://?*) ;;
    *) die "RAG_BACKUP__S3_URI is not set to s3://bucket[/prefix] (env or $ENV_FILE)" ;;
esac
for tool in aws sqlite3 zstd sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed"
done

case "$STAMP" in
    "") KIND=daily ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) KIND=daily ;;
    [0-9][0-9][0-9][0-9]-W[0-9][0-9]) KIND=weekly ;;
    *) die "STAMP must be YYYYMMDD or GGGG-Www, not '$STAMP'" ;;
esac

# Refuse the live directories, and anything already holding a database.
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd -P)"
for live in "$DATA_DIR" "$DATA_DIR/tracker" "$DATA_DIR/ledger"; do
    if [ -d "$live" ] && [ "$DEST" = "$(cd "$live" && pwd -P)" ]; then
        die "DEST is the live $live; restore into a scratch directory and move it into place"
    fi
done
if [ -e "$DEST/tracker/tracker.db" ] || [ -e "$DEST/ledger/ledger.db" ]; then
    die "$DEST already holds a restored database; use an empty directory"
fi

rest="${S3_URI#s3://}"
BUCKET="${rest%%/*}"
PREFIX=""
[ "$rest" != "$BUCKET" ] && PREFIX="${rest#*/}"
PREFIX="${PREFIX%/}"
key_of() { if [ -n "$PREFIX" ]; then printf '%s/%s' "$PREFIX" "$1"; else printf '%s' "$1"; fi; }
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
list_keys() {
    local out
    out="$(aws_ s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" \
        --query 'Contents[].Key' --output text)" || die "cannot list s3://$BUCKET/$1"
    [ "$out" = "None" ] && return 0
    printf '%s\n' "$out" | tr '\t' '\n' | sed '/^$/d'
}

# The manifest's table counts, as "table count" lines sorted by table; and the same
# from a database file. Their equality is the row-count check.
manifest_counts() {
    python3 -I -c 'import json,sys
for t, n in sorted(json.load(open(sys.argv[1]))["tables"].items()): print(t, n)' "$1"
}
manifest_field() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
db_counts() {
    local t
    while IFS= read -r t; do
        printf '%s %s\n' "$t" "$(sqlite3 -readonly "$1" "SELECT count(*) FROM \"${t//\"/\"\"}\";")"
    done < <(sqlite3 -readonly "$1" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;")
}

restore_db() {
    local name="$1" stem
    if [ -n "$STAMP" ]; then
        stem="$(key_of "db/$KIND/$name-$STAMP")"
    else
        local keys
        keys="$(list_keys "$(key_of "db/daily/$name-")")"
        stem="$(printf '%s\n' "$keys" | { grep '\.db\.zst$' || true; } | sed 's/\.db\.zst$//' | sort | tail -n 1)"
        [ -n "$stem" ] || die "no daily copy of $name in s3://$BUCKET/$(key_of db/daily/)"
    fi
    echo "== $name: s3://$BUCKET/$stem.db.zst =="
    mkdir -p "$DEST/$name"
    local db="$DEST/$name/$name.db" manifest="$DEST/$name/$name.backup.json"
    aws_ s3 cp --only-show-errors "s3://$BUCKET/$stem.db.zst" "$DEST/$name/$name.db.zst"
    aws_ s3 cp --only-show-errors "s3://$BUCKET/$stem.json" "$manifest"
    zstd -q -d "$DEST/$name/$name.db.zst" -o "$db"
    rm -f "$DEST/$name/$name.db.zst"

    local want got
    want="$(manifest_field "$manifest" sha256)"
    got="$(sha256sum "$db" | cut -d' ' -f1)"
    [ "$want" = "$got" ] || die "$name: sha256 $got does not match the manifest's $want"
    got="$(sqlite3 -readonly "$db" 'PRAGMA integrity_check;')"
    [ "$got" = "ok" ] || die "$name: integrity_check: $got"
    if ! diff <(manifest_counts "$manifest") <(db_counts "$db") >"$DEST/$name/counts.diff"; then
        cat "$DEST/$name/counts.diff" >&2
        die "$name: row counts differ from the manifest (taken $(manifest_field "$manifest" taken_at))"
    fi
    rm -f "$DEST/$name/counts.diff"
    echo "  taken $(manifest_field "$manifest" taken_at); sha256 ok; integrity ok; rows match:"
    db_counts "$db" | sed 's/^/    /'
}

restore_db tracker
restore_db ledger

echo "== attachments =="
att_prefix="$(key_of attachments/)"
ATT="$DEST/tracker/attachments"
mkdir -p "$ATT"
keys="$(list_keys "$att_prefix")"
n=0
while IFS= read -r key; do
    [ -n "$key" ] || continue
    rel="${key#"$att_prefix"}"
    sha="${rel#*/}"
    mkdir -p "$ATT/${rel%%/*}"
    aws_ s3 cp --only-show-errors "s3://$BUCKET/$key" "$ATT/$rel"
    [ "$(sha256sum "$ATT/$rel" | cut -d' ' -f1)" = "$sha" ] || die "attachment $rel does not hash to its name"
    n=$((n + 1))
done <<< "$keys"
echo "  $n attachment(s), each hashing to its name"

echo "restore into $DEST OK"
